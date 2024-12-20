'use strict'

import crypto from 'crypto'
import onEnd from 'on-http-end'

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
 * @param {number} options.ttl - Time-to-live in milliseconds for cached responses.
 * @param {string} [options.idempotencyKeyExtractor] - A function that extracts the idempotency key from the request object.
 * @param {Object} [options.logger=console] - A logger object with `.error()` and possibly other methods for logging.
 *
 * @returns {Function} Connect-style middleware function `(req, res, next)`.
 *
 * @throws {Error} If `cache` or `ttl` is not provided.
 */
export function idempotencyMiddleware({
  cache,
  ttl,
  idempotencyKeyExtractor = (req) => req.headers['x-request-id'],
  logger = console,
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

  if (typeof ttl !== 'number' || ttl <= 0) {
    throw new Error(
      'IdempotencyMiddleware: A positive numeric ttl (in milliseconds) is required.',
    )
  }

  return function (req, res, next) {
    if (
      req.method === 'POST' ||
      req.method === 'PUT' ||
      req.method === 'PATCH' ||
      req.method === 'DELETE'
    ) {
      let idempotencyKey = idempotencyKeyExtractor(req)

      // If no idempotency key is found, there's no special handling needed
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        return next()
      }

      // Hash the idempotency key to ensure it's a valid cache key
      idempotencyKey = 'idemp-key-' + hashSha256(idempotencyKey)

      // Attempt to retrieve a cached response
      cache
        .get(idempotencyKey)
        .then(function (cachedResponse) {
          if (cachedResponse) {
            // Cached response found: return 304 Not Modified to prevent reprocessing
            res.statusCode = 304
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.end()
          } else {
            // No cached response found: set up a post-response hook
            onEnd(res, function (payload) {
              // Only cache the response if it's a success (2xx)
              if (
                payload.status >= 200 &&
                payload.status < 300 &&
                typeof idempotencyKey === 'string'
              ) {
                // Store a simple flag or a derived response as needed.
                // Here we store `true` to indicate a successful processed request.
                // If you need to store the actual payload, store `payload.body` instead.
                cache
                  .set(idempotencyKey, '1', {ttl: ttl})
                  .catch(function (err) {
                    logger.error(
                      'IdempotencyMiddleware - Cache WRITE Error:',
                      err,
                    )
                  })
              }
            })

            // Proceed to the next handler in the chain
            next()
          }
        })
        .catch(function (error) {
          // If there's an error reading from the cache, log and proceed without caching
          logger.error('IdempotencyMiddleware - Cache READ Error:', error)
          next()
        })
    } else {
      // For non-idempotent methods, proceed without special handling
      next()
    }
  }
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
