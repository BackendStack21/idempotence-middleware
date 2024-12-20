const {idempotencyMiddleware} = require('./../index.js')
const {createCache} = require('cache-manager')
const express = require('express')
const {Keyv} = require('keyv')
const {CacheableMemory} = require('cacheable')

const SERVICE_NAME = 'express-demo'

const cache = createCache({
  stores: [
    new Keyv({
      // for Redis support: https://www.npmjs.com/package/cache-manager#update-on-redis-and-ioredis-support
      store: new CacheableMemory({ttl: 60000, lruSize: 5000}),
    }),
  ],
})

const app = express()

app.use(
  idempotencyMiddleware({
    ttl: 5000,
    idempotencyKeyExtractor: (req) =>
      `${SERVICE_NAME}-${req.headers['x-custom-req-id']}`,
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
