import {idempotencyMiddleware} from './../index.js'
import {createCache} from 'cache-manager'
import express, {type Request, type Response} from 'express'
import Keyv from 'keyv'
import {CacheableMemory} from 'cacheable'

const SERVICE_NAME = 'express-demo'

function getCurrentUserId(req: Request): string {
  // Replace this with the real authenticated user identifier.
  // In Express you typically read it from req.user after authentication.
  return (req as Request & {user?: {id: string}}).user?.id ?? 'anonymous'
}

const cache = createCache({
  stores: [
    new Keyv({
      // for Redis support: https://www.npmjs.com/package/cache-manager#update-on-redis-and-ioredis-support
      store: new CacheableMemory({ttl: 60000, lruSize: 5000}),
    }),
  ],
})

function extractIdempotencyKey(req: Request): string | undefined {
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
