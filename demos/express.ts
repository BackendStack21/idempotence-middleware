import {idempotencyMiddleware} from './../index.js'
import {createCache} from 'cache-manager'
import express, {type Request, type Response} from 'express'
import Keyv from 'keyv'
import {CacheableMemory} from 'cacheable'

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
      get: async (key: string) => {
        return cache.get(key)
      },
      set: async (key: string, value: any, options) => {
        return cache.set(key, value, options?.ttl)
      },
    },
  }),
)

app.post('/create', (req: Request, res: Response) => {
  res.send('Resource created!')
})

app.listen(3000, () => {
  console.log('Server is running on port 3000')
})
