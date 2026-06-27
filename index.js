'use strict'

import crypto from 'crypto'
import onEnd from 'on-http-end'

const DEFAULT_KEY_PREFIX = 'idemp-key-'
const MAX_KEY_LENGTH = 128
const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_.~-]+$/
const MAX_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const DEFAULT_MAX_RESPONSE_SIZE = 1024 * 1024 // 1 MB

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'date',
])

/**
 * Creates a middleware function that implements idempotency based on a request-specific key
 * (commonly referred to as an 'idempotency key' or 'request id').
 *
 * This pattern is especially useful for ensuring that retrying the same request (due to network
 * issues or client-side retries) does not produce duplicate side effects on the server (such as
 * creating the same resource multiple times).
 *
 * @param {Object} options - Configuration options for the middleware.
 * @param {Object} options.cache - A cache instance that supports `.get(key)` and `.set(key, value, { ttl })` methods.
 * @param {number} options.ttl - Time-to-live in milliseconds for cached responses (1..86400000).
 * @param {string} [options.idempotencyKeyExtractor] - A function that extracts the idempotency key from the request object.
 * @param {Object} [options.logger=console] - A logger object with `.error()` and possibly other methods for logging.
 * @param {string} [options.keyPrefix='idemp-key-'] - Prefix prepended to cache keys.
 * @param {number} [options.maxResponseSize=1048576] - Maximum response body size (in bytes) that will be cached.
 *
 * @returns {Function} Connect-style middleware function `(req, res, next)`.
 *
 * @throws {Error} If `cache` or `ttl` is not provided, or if options are invalid.
 */
export function idempotencyMiddleware({
  cache,
  ttl,
  idempotencyKeyExtractor = (req) => req.headers['x-request-id'],
  logger = console,
  keyPrefix = DEFAULT_KEY_PREFIX,
  maxResponseSize = DEFAULT_MAX_RESPONSE_SIZE,
}) {
  // Validate the mandatory parameters
  if (
    !cache ||
    typeof cache.get !== 'function' ||
    typeof cache.set !== 'function'
  ) {
    throw new Error(
      'IdempotencyMiddleware: A valid cache instance with .get and .set methods is required.',
    )
  }

  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    throw new Error(
      'IdempotencyMiddleware: A positive numeric ttl (in milliseconds) is required.',
    )
  }

  if (ttl > MAX_TTL_MS) {
    throw new Error(
      `IdempotencyMiddleware: ttl must be between 1 and ${MAX_TTL_MS} milliseconds.`,
    )
  }

  if (typeof keyPrefix !== 'string' || keyPrefix.length === 0) {
    throw new Error(
      'IdempotencyMiddleware: keyPrefix must be a non-empty string.',
    )
  }

  if (
    typeof maxResponseSize !== 'number' ||
    !Number.isFinite(maxResponseSize) ||
    maxResponseSize <= 0
  ) {
    throw new Error(
      'IdempotencyMiddleware: maxResponseSize must be a positive number.',
    )
  }

  // In-flight request locks per cache key. This prevents two requests with the same
  // idempotency key from both missing the cache and executing the handler.
  const inFlight = new Map()

  return async function (req, res, next) {
    try {
      if (
        req.method !== 'POST' &&
        req.method !== 'PUT' &&
        req.method !== 'PATCH' &&
        req.method !== 'DELETE'
      ) {
        return next()
      }

      let idempotencyKey
      try {
        idempotencyKey = idempotencyKeyExtractor(req)
      } catch (err) {
        logger.error('IdempotencyMiddleware - Extractor Error:', err)
        return next()
      }

      if (!isValidIdempotencyKey(idempotencyKey)) {
        return next()
      }

      const cacheKey = buildCacheKey(keyPrefix, req, idempotencyKey)

      // Wait for any in-flight request for the same key to finish, then acquire the
      // lock before any async cache read so concurrent requests cannot race past
      // this point and both execute the handler.
      let existing = inFlight.get(cacheKey)
      while (existing) {
        await existing
        existing = inFlight.get(cacheKey)
      }

      const {promise: lock, release} = createLock()
      inFlight.set(cacheKey, lock)

      try {
        // Double-check the cache now that we hold the lock.
        const cachedResponse = await cache.get(cacheKey)
        if (isValidCachedResponse(cachedResponse)) {
          replayResponse(res, cachedResponse)
          release()
          inFlight.delete(cacheKey)
          return
        }

        // No cached response found: set up a post-response hook.
        onEnd(res, function (payload) {
          try {
            // Only cache the response if it's a success (2xx) and not too large.
            if (
              payload.status >= 200 &&
              payload.status < 300 &&
              typeof cacheKey === 'string' &&
              getBodyLength(payload.data) <= maxResponseSize
            ) {
              const responseToCache = {
                version: 1,
                status: payload.status,
                headers: payload.headers,
                body: serializeBody(payload.data),
                cachedAt: Date.now(),
              }
              cache
                .set(cacheKey, responseToCache, {ttl: ttl})
                .catch(function (err) {
                  logger.error(
                    'IdempotencyMiddleware - Cache WRITE Error:',
                    err,
                  )
                })
            }
          } finally {
            release()
            inFlight.delete(cacheKey)
          }
        })

        // Proceed to the next handler in the chain
        next()
      } catch (error) {
        release()
        inFlight.delete(cacheKey)
        logger.error('IdempotencyMiddleware - Cache READ Error:', error)
        return next()
      }
    } catch (error) {
      logger.error('IdempotencyMiddleware - Unexpected Error:', error)
      return next(error)
    }
  }
}

function createLock() {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return {promise, release}
}

function isValidIdempotencyKey(key) {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= MAX_KEY_LENGTH &&
    SAFE_KEY_PATTERN.test(key)
  )
}

function buildCacheKey(prefix, req, idempotencyKey) {
  const method = req.method
  const url = req.url || req.originalUrl
  const keyMaterial = `${method}:${url}:${idempotencyKey}`
  return `${prefix}${hashSha256(keyMaterial)}`
}

function isValidCachedResponse(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.version === 1 &&
    typeof value.status === 'number' &&
    value.status >= 200 &&
    value.status < 300 &&
    typeof value.cachedAt === 'number' &&
    value.body !== undefined &&
    value.body !== null
  )
}

function replayResponse(res, cachedResponse) {
  res.statusCode = cachedResponse.status
  res.setHeader('X-Idempotency-Status', 'hit')

  const headers = cachedResponse.headers || {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue
    }
    res.setHeader(name, value)
  }

  res.end(deserializeBody(cachedResponse.body))
}

function serializeBody(body) {
  if (Buffer.isBuffer(body)) {
    return {type: 'buffer', data: body.toString('base64')}
  }
  return {type: 'string', data: String(body ?? '')}
}

function deserializeBody(body) {
  if (body && typeof body === 'object') {
    if (body.type === 'buffer' && typeof body.data === 'string') {
      return Buffer.from(body.data, 'base64')
    }
    if (body.type === 'string') {
      return body.data
    }
  }
  return body
}

function getBodyLength(body) {
  if (Buffer.isBuffer(body)) {
    return body.length
  }
  if (typeof body === 'string') {
    return Buffer.byteLength(body, 'utf8')
  }
  return 0
}

/**
 * Generates a SHA-256 hash of the provided string.
 *
 * @param {string} str - The string to hash.
 *
 * @returns {string} The SHA-256 hash of the string.
 */
export function hashSha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex')
}
