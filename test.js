'use strict'

import test from 'node:test'
import assert from 'node:assert'
import {EventEmitter} from 'node:events'
import {idempotencyMiddleware, hashSha256} from './index.js'

// A simple mock cache implementation
function createMockCache({
  getValue = null,
  getError = null,
  setError = null,
} = {}) {
  const store = new Map()
  return {
    store,
    setCalls: [],
    get: async (key) => {
      if (getError) throw getError
      return store.get(key) ?? getValue
    },
    set: async (key, value, options) => {
      if (setError) throw setError
      store.set(key, value)
      return true
    },
  }
}

// A helper to create a mock logger
function createMockLogger() {
  return {
    errorCalls: [],
    error: function (...args) {
      this.errorCalls.push(args)
    },
  }
}

// A helper to create a mock request and response
function createMockReqRes({
  headers = {},
  statusCode = 200,
  method = 'POST',
  url = '/create',
} = {}) {
  const req = {headers, method, url}

  // Mock response as an EventEmitter to simulate the 'end' event.
  const res = new EventEmitter()
  res.headers = {}
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value
  }
  res.getHeaders = () => res.headers
  res.removeHeader = (name) => {
    delete res.headers[name.toLowerCase()]
  }
  res.endCalled = false
  res.endBody = undefined
  res.statusCode = statusCode
  res.end = (body) => {
    res.endCalled = true
    res.endBody = body
    // Simulate 'end' event after a tick
    process.nextTick(() => {
      res.emit('end', {status: res.statusCode, data: body})
    })
  }

  return {req, res}
}

test('idempotencyMiddleware - no idempotency key provided', async (t) => {
  const cache = createMockCache()
  const logger = createMockLogger()
  let nextCalled = false

  const middleware = idempotencyMiddleware({
    cache,
    ttl: 3600,
    logger,
  })

  const {req, res} = createMockReqRes()
  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(
    nextCalled,
    'Next should be called if no idempotency key is present',
  )
  assert.strictEqual(res.endCalled, false, 'Response should not end')
})

test('idempotencyMiddleware - idempotency key present and cache hit', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 201,
    headers: {'content-type': 'text/plain; charset=utf-8'},
    body: {type: 'string', data: 'Resource created!'},
    cachedAt: Date.now(),
  })
  const logger = createMockLogger()
  const middleware = idempotencyMiddleware({cache, ttl: 3600, logger})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false

  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.strictEqual(
    nextCalled,
    false,
    'Next should not be called if cache hit',
  )
  assert.strictEqual(
    res.statusCode,
    201,
    'Should replay the original status code',
  )
  assert.strictEqual(
    res.endBody,
    'Resource created!',
    'Should replay the original body',
  )
  assert.strictEqual(
    res.headers['x-idempotency-status'],
    'hit',
    'Should set X-Idempotency-Status header',
  )
})

test('idempotencyMiddleware - idempotency key present and cache miss', async (t) => {
  const cache = createMockCache()
  const logger = createMockLogger()
  const middleware = idempotencyMiddleware({cache, ttl: 3600, logger})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false

  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(nextCalled, 'Next should be called if cache miss')

  // Simulate the actual response sending after next (like a route handler)
  res.end('Hello World')

  // Wait a tick for onEnd to trigger
  await new Promise(setImmediate)

  const stored = cache.store.get(buildExpectedKey('123'))
  assert.ok(stored, 'Should store a value in the cache')
  assert.strictEqual(stored.version, 1)
  assert.strictEqual(stored.status, 200)
  assert.strictEqual(stored.body.data, 'Hello World')
})

test('idempotencyMiddleware - cache read error', async (t) => {
  const cacheError = new Error('Cache Read Error')
  const cache = createMockCache({getError: cacheError})
  const logger = createMockLogger()
  const middleware = idempotencyMiddleware({cache, ttl: 3600, logger})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(nextCalled, 'Next should be called even on cache error')
  assert.deepStrictEqual(logger.errorCalls[0], [
    'IdempotencyMiddleware - Cache READ Error:',
    cacheError,
  ])
})

test('idempotencyMiddleware - cache write error', async (t) => {
  const cacheWriteError = new Error('Cache Write Error')
  const cache = createMockCache({setError: cacheWriteError})
  const logger = createMockLogger()
  const middleware = idempotencyMiddleware({cache, ttl: 3600, logger})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(nextCalled, 'Next should be called on cache miss')

  res.end('Hello World')
  await new Promise(setImmediate)

  // The cache write should fail
  assert.equal(
    logger.errorCalls[0][0],
    'IdempotencyMiddleware - Cache WRITE Error:',
  )
})

test('idempotencyMiddleware - non-2xx response does not cache', async (t) => {
  const cache = createMockCache()
  const logger = createMockLogger()
  const middleware = idempotencyMiddleware({cache, ttl: 3600, logger})

  const {req, res} = createMockReqRes({
    headers: {'x-request-id': '123'},
    statusCode: 400,
  })
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(nextCalled, 'Next should be called on cache miss')

  // End with a 4xx error
  res.end('Bad Request')
  await new Promise(setImmediate)

  assert.strictEqual(cache.store.size, 0, 'Cache should remain empty')
  assert.strictEqual(logger.errorCalls.length, 0, 'No error logs expected')
})

test('idempotencyMiddleware - should skip GET method', async (t) => {
  const cache = createMockCache()
  const logger = createMockLogger()
  const middleware = idempotencyMiddleware({cache, ttl: 3600, logger})

  const {req, res} = createMockReqRes({
    headers: {'x-request-id': '123'},
    method: 'GET',
  })
  let nextCalled = false

  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(nextCalled, 'Next should be called on GET method')
})

test('idempotencyMiddleware - should trigger error when cache.get is not a function', async (t) => {
  const cache = {}
  const logger = createMockLogger()

  assert.throws(() => idempotencyMiddleware({cache, ttl: 3600, logger}), {
    name: 'Error',
    message:
      'IdempotencyMiddleware: A valid cache instance with .get and .set methods is required.',
  })
})

test('idempotencyMiddleware - should trigger error when cache.set is not a function', async (t) => {
  const cache = {}
  const logger = createMockLogger()

  assert.throws(() => idempotencyMiddleware({cache, ttl: 3600, logger}), {
    name: 'Error',
    message:
      'IdempotencyMiddleware: A valid cache instance with .get and .set methods is required.',
  })
})

test('idempotencyMiddleware - should trigger error ttl is not a number', async (t) => {
  const cache = createMockCache()
  const logger = createMockLogger()

  assert.throws(() => idempotencyMiddleware({cache, ttl: '3600', logger}), {
    name: 'Error',
    message:
      'IdempotencyMiddleware: A positive numeric ttl (in milliseconds) is required.',
  })
})

test('idempotencyMiddleware - should reject ttl above maximum', async (t) => {
  const cache = createMockCache()
  const logger = createMockLogger()

  assert.throws(
    () => idempotencyMiddleware({cache, ttl: 24 * 60 * 60 * 1000 + 1, logger}),
    {
      name: 'Error',
      message:
        'IdempotencyMiddleware: ttl must be between 1 and 86400000 milliseconds.',
    },
  )
})

test('idempotencyMiddleware - hashSha256 function', async (t) => {
  const hash = hashSha256('123')
  assert.strictEqual(
    hash,
    'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
  )
})

test('idempotencyMiddleware - rejects unsafe idempotency keys', async (t) => {
  const cache = createMockCache()
  const logger = createMockLogger()
  const middleware = idempotencyMiddleware({cache, ttl: 3600, logger})

  const {req, res} = createMockReqRes({
    headers: {'x-request-id': 'key with spaces'},
  })
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(nextCalled, 'Next should be called for unsafe keys')
  assert.strictEqual(cache.store.size, 0)
})

test('idempotencyMiddleware - rejects idempotency keys that are too long', async (t) => {
  const cache = createMockCache()
  const logger = createMockLogger()
  const middleware = idempotencyMiddleware({cache, ttl: 3600, logger})

  const {req, res} = createMockReqRes({
    headers: {'x-request-id': 'x'.repeat(129)},
  })
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(nextCalled, 'Next should be called for overlong keys')
})

test('idempotencyMiddleware - extractor errors are handled gracefully', async (t) => {
  const cache = createMockCache()
  const logger = createMockLogger()
  const extractorError = new Error('extractor failed')
  const middleware = idempotencyMiddleware({
    cache,
    ttl: 3600,
    logger,
    idempotencyKeyExtractor: () => {
      throw extractorError
    },
  })

  const {req, res} = createMockReqRes()
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(nextCalled, 'Next should be called when extractor throws')
  assert.deepStrictEqual(logger.errorCalls[0], [
    'IdempotencyMiddleware - Extractor Error:',
    extractorError,
  ])
})

test('idempotencyMiddleware - keyPrefix option is honored', async (t) => {
  const cache = createMockCache()
  const middleware = idempotencyMiddleware({
    cache,
    ttl: 3600,
    keyPrefix: 'custom-prefix-',
  })

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  await middleware(req, res, () => {
    res.end('Hello')
  })
  await new Promise(setImmediate)

  const keys = Array.from(cache.store.keys())
  assert.strictEqual(keys.length, 1)
  assert.ok(
    keys[0].startsWith('custom-prefix-'),
    'Cache key should use the configured prefix',
  )
})

test('idempotencyMiddleware - concurrent duplicate requests are deduplicated', async (t) => {
  const cache = createMockCache()
  const middleware = idempotencyMiddleware({cache, ttl: 3600})
  let handlerCalls = 0
  const responses = []

  function runRequest() {
    return new Promise((resolve) => {
      const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})

      middleware(req, res, () => {
        handlerCalls++
        // Simulate some asynchronous work
        setImmediate(() => {
          res.statusCode = 201
          res.end('created')
        })
      })

      res.on('end', () => {
        responses.push({status: res.statusCode, body: res.endBody})
        resolve()
      })
    })
  }

  await Promise.all([runRequest(), runRequest()])

  assert.strictEqual(handlerCalls, 1, 'Handler should only run once')
  assert.strictEqual(responses.length, 2)
  assert.strictEqual(responses[0].status, 201)
  assert.strictEqual(responses[1].status, 201)
  assert.strictEqual(responses[0].body, 'created')
  assert.strictEqual(responses[1].body, 'created')
})

test('idempotencyMiddleware - cache key is scoped by method and url', async (t) => {
  const cache = createMockCache()
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req: req1, res: res1} = createMockReqRes({
    headers: {'x-request-id': '123'},
    url: '/orders',
  })
  await middleware(req1, res1, () => {
    res1.end('orders')
  })
  await new Promise(setImmediate)

  const {req: req2, res: res2} = createMockReqRes({
    headers: {'x-request-id': '123'},
    url: '/invoices',
  })
  let next2Called = false
  await middleware(req2, res2, () => {
    next2Called = true
    res2.end('invoices')
  })
  await new Promise(setImmediate)

  assert.ok(next2Called, 'Different URL should not share cache key')
  assert.strictEqual(cache.store.size, 2)
})

test('idempotencyMiddleware - invalid cache values are ignored', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {version: 0, status: 200})
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
    res.end('ok')
  })

  assert.ok(nextCalled, 'Next should be called for invalid cached values')
})

test('idempotencyMiddleware - validates cache instance presence', async (t) => {
  assert.throws(() => idempotencyMiddleware({ttl: 3600}), {
    message:
      'IdempotencyMiddleware: A valid cache instance with .get and .set methods is required.',
  })
})

test('idempotencyMiddleware - validates ttl options', async (t) => {
  const cache = createMockCache()

  assert.throws(() => idempotencyMiddleware({cache, ttl: Infinity}), {
    message:
      'IdempotencyMiddleware: A positive numeric ttl (in milliseconds) is required.',
  })
  assert.throws(() => idempotencyMiddleware({cache, ttl: 0}), {
    message:
      'IdempotencyMiddleware: A positive numeric ttl (in milliseconds) is required.',
  })
  assert.throws(() => idempotencyMiddleware({cache, ttl: -1}), {
    message:
      'IdempotencyMiddleware: A positive numeric ttl (in milliseconds) is required.',
  })
})

test('idempotencyMiddleware - validates keyPrefix option', async (t) => {
  const cache = createMockCache()

  assert.throws(
    () => idempotencyMiddleware({cache, ttl: 3600, keyPrefix: ''}),
    {
      message: 'IdempotencyMiddleware: keyPrefix must be a non-empty string.',
    },
  )
  assert.throws(
    () => idempotencyMiddleware({cache, ttl: 3600, keyPrefix: 123}),
    {
      message: 'IdempotencyMiddleware: keyPrefix must be a non-empty string.',
    },
  )
})

test('idempotencyMiddleware - validates maxResponseSize option', async (t) => {
  const cache = createMockCache()

  assert.throws(
    () => idempotencyMiddleware({cache, ttl: 3600, maxResponseSize: 0}),
    {
      message:
        'IdempotencyMiddleware: maxResponseSize must be a positive number.',
    },
  )
  assert.throws(
    () => idempotencyMiddleware({cache, ttl: 3600, maxResponseSize: -1}),
    {
      message:
        'IdempotencyMiddleware: maxResponseSize must be a positive number.',
    },
  )
  assert.throws(
    () => idempotencyMiddleware({cache, ttl: 3600, maxResponseSize: Infinity}),
    {
      message:
        'IdempotencyMiddleware: maxResponseSize must be a positive number.',
    },
  )
  assert.throws(
    () => idempotencyMiddleware({cache, ttl: 3600, maxResponseSize: '1MB'}),
    {
      message:
        'IdempotencyMiddleware: maxResponseSize must be a positive number.',
    },
  )
})

test('idempotencyMiddleware - empty idempotency key is skipped', async (t) => {
  const cache = createMockCache()
  const middleware = idempotencyMiddleware({
    cache,
    ttl: 3600,
    idempotencyKeyExtractor: () => '',
  })

  const {req, res} = createMockReqRes()
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(nextCalled)
})

test('idempotencyMiddleware - array header is skipped', async (t) => {
  const cache = createMockCache()
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': ['123']}})
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.ok(nextCalled)
})

test('idempotencyMiddleware - unexpected errors are passed to next', async (t) => {
  const cache = createMockCache()
  const logger = createMockLogger()
  const middleware = idempotencyMiddleware({cache, ttl: 3600, logger})

  const req = {
    get method() {
      throw new Error('method access failed')
    },
    headers: {},
  }
  const res = new EventEmitter()
  let nextArg
  await middleware(req, res, (err) => {
    nextArg = err
  })

  assert.ok(nextArg instanceof Error)
  assert.strictEqual(nextArg.message, 'method access failed')
  assert.strictEqual(
    logger.errorCalls[0][0],
    'IdempotencyMiddleware - Unexpected Error:',
  )
})

test('idempotencyMiddleware - hop-by-hop headers are not replayed', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 200,
    headers: {
      'content-type': 'text/plain',
      'content-length': '17',
      connection: 'keep-alive',
      date: 'Mon, 01 Jan 2024 00:00:00 GMT',
    },
    body: {type: 'string', data: 'Resource created!'},
    cachedAt: Date.now(),
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  await middleware(req, res, () => {})

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(res.headers['content-type'], 'text/plain')
  assert.strictEqual(res.headers['content-length'], undefined)
  assert.strictEqual(res.headers.connection, undefined)
  assert.strictEqual(res.headers.date, undefined)
})

test('idempotencyMiddleware - buffers are cached and replayed', async (t) => {
  const cache = createMockCache()
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  await middleware(req, res, () => {
    res.end(Buffer.from('binary data'))
  })
  await new Promise(setImmediate)

  const stored = cache.store.get(buildExpectedKey('123'))
  assert.strictEqual(stored.body.type, 'buffer')
  assert.strictEqual(
    stored.body.data,
    Buffer.from('binary data').toString('base64'),
  )

  const {req: req2, res: res2} = createMockReqRes({
    headers: {'x-request-id': '123'},
  })
  await middleware(req2, res2, () => {})
  assert.ok(Buffer.isBuffer(res2.endBody))
  assert.strictEqual(res2.endBody.toString(), 'binary data')
})

test('idempotencyMiddleware - responses larger than maxResponseSize are not cached', async (t) => {
  const cache = createMockCache()
  const middleware = idempotencyMiddleware({
    cache,
    ttl: 3600,
    maxResponseSize: 5,
  })

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  await middleware(req, res, () => {
    res.end('Hello World')
  })
  await new Promise(setImmediate)

  assert.strictEqual(cache.store.size, 0)
})

test('idempotencyMiddleware - empty responses are cached', async (t) => {
  const cache = createMockCache()
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  await middleware(req, res, () => {
    res.end()
  })
  await new Promise(setImmediate)

  const stored = cache.store.get(buildExpectedKey('123'))
  assert.strictEqual(stored.body.type, 'string')
  assert.strictEqual(stored.body.data, '')
})

test('idempotencyMiddleware - unknown body type passes through deserialization', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 200,
    headers: {},
    body: {type: 'unknown', data: 'foo'},
    cachedAt: Date.now(),
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  await middleware(req, res, () => {})

  assert.deepStrictEqual(res.endBody, {type: 'unknown', data: 'foo'})
})

test('idempotencyMiddleware - buffer body with invalid data passes through', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 200,
    headers: {},
    body: {type: 'buffer', data: 123},
    cachedAt: Date.now(),
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  await middleware(req, res, () => {})

  assert.deepStrictEqual(res.endBody, {type: 'buffer', data: 123})
})

test('idempotencyMiddleware - primitive body passes through deserialization', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 200,
    headers: {},
    body: 'raw body',
    cachedAt: Date.now(),
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  await middleware(req, res, () => {})

  assert.strictEqual(res.endBody, 'raw body')
})

test('idempotencyMiddleware - falsy string body is replayed', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 200,
    headers: {},
    body: '',
    cachedAt: Date.now(),
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  await middleware(req, res, () => {})

  assert.strictEqual(res.endBody, '')
})

test('idempotencyMiddleware - ignores cached responses with non-2xx status', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 199,
    headers: {},
    body: {type: 'string', data: 'ok'},
    cachedAt: Date.now(),
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
    res.end('ok')
  })

  assert.ok(nextCalled)
})

test('idempotencyMiddleware - ignores cached responses with 3xx status', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 301,
    headers: {},
    body: {type: 'string', data: 'ok'},
    cachedAt: Date.now(),
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
    res.end('ok')
  })

  assert.ok(nextCalled)
})

test('idempotencyMiddleware - ignores cached responses with non-numeric status', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: '200',
    headers: {},
    body: {type: 'string', data: 'ok'},
    cachedAt: Date.now(),
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
    res.end('ok')
  })

  assert.ok(nextCalled)
})

test('idempotencyMiddleware - ignores cached responses with missing cachedAt', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 200,
    headers: {},
    body: {type: 'string', data: 'ok'},
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
    res.end('ok')
  })

  assert.ok(nextCalled)
})

test('idempotencyMiddleware - ignores cached responses with null body', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 200,
    headers: {},
    body: null,
    cachedAt: Date.now(),
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
    res.end('ok')
  })

  assert.ok(nextCalled)
})

test('idempotencyMiddleware - ignores cached string values', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), 'cached value')
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  let nextCalled = false
  await middleware(req, res, () => {
    nextCalled = true
    res.end('ok')
  })

  assert.ok(nextCalled)
})

test('idempotencyMiddleware - ignores cached responses with undefined headers', async (t) => {
  const cache = createMockCache()
  cache.store.set(buildExpectedKey('123'), {
    version: 1,
    status: 200,
    headers: undefined,
    body: {type: 'string', data: 'ok'},
    cachedAt: Date.now(),
  })
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  await middleware(req, res, () => {})

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(res.endBody, 'ok')
})

test('idempotencyMiddleware - falls back to originalUrl when url is missing', async (t) => {
  const cache = createMockCache()
  const middleware = idempotencyMiddleware({cache, ttl: 3600})

  const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})
  delete req.url
  req.originalUrl = '/original'
  await middleware(req, res, () => {
    res.end('ok')
  })
  await new Promise(setImmediate)

  const keys = Array.from(cache.store.keys())
  assert.strictEqual(keys.length, 1)
  assert.ok(keys[0].startsWith('idemp-key-'))
})

test('idempotencyMiddleware - three concurrent requests are deduplicated', async (t) => {
  const cache = createMockCache()
  const middleware = idempotencyMiddleware({cache, ttl: 3600})
  let handlerCalls = 0
  const responses = []

  function runRequest() {
    return new Promise((resolve) => {
      const {req, res} = createMockReqRes({headers: {'x-request-id': '123'}})

      middleware(req, res, () => {
        handlerCalls++
        setImmediate(() => {
          res.statusCode = 201
          res.end('created')
        })
      })

      res.on('end', () => {
        responses.push({status: res.statusCode, body: res.endBody})
        resolve()
      })
    })
  }

  await Promise.all([runRequest(), runRequest(), runRequest()])

  assert.strictEqual(handlerCalls, 1)
  assert.strictEqual(responses.length, 3)
  for (const response of responses) {
    assert.strictEqual(response.status, 201)
    assert.strictEqual(response.body, 'created')
  }
})

function buildExpectedKey(idempotencyKey, method = 'POST', url = '/create') {
  const keyMaterial = `${method}:${url}:${idempotencyKey}`
  return `idemp-key-${hashSha256(keyMaterial)}`
}
