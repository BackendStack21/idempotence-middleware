const {idempotencyMiddleware} = require('./../index.js')
const {createCache} = require('cache-manager')
const express = require('express')
const {Keyv} = require('keyv')
const {CacheableMemory} = require('cacheable')

const SERVICE_NAME = 'express-demo'

function getCurrentUserId(req) {
  // Replace this with the real authenticated user identifier.
  // In Express you typically read it from req.user after authentication.
  return req.user?.id ?? 'anonymous'
}

const cache = createCache({
  stores: [
    new Keyv({
      // for Redis support: https://www.npmjs.com/package/cache-manager#update-on-redis-and-ioredis-support
      store: new CacheableMemory({ttl: 60000, lruSize: 5000}),
    }),
  ],
})

function extractIdempotencyKey(req) {
  const header = req.headers['x-custom-req-id']
  const value = Array.isArray(header) ? header[0] : header
  if (!value || !/^[a-zA-Z0-9_.~-]{1,128}$/.test(value)) {
    return undefined
  }
  // Scope the key with a service and user identifier to prevent cross-user collisions.
  return `${SERVICE_NAME}-${getCurrentUserId(req)}-${value}`
}

const app = express()

app.use(
  idempotencyMiddleware({
    ttl: 5000,
    idempotencyKeyExtractor: extractIdempotencyKey,
    cache: {
      get: async (key) => {
        return cache.get(key)
      },
      set: async (key, value, {ttl}) => {
        return cache.set(key, value, ttl)
      },
    },
  }),
)

app.post('/create', (req, res) => {
  res.send('Resource created!')
})

app.listen(3000, () => {
  console.log('Server is running on port 3000')
})
