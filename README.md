# Idempotency Middleware

This middleware enables your API to handle requests idempotently, ensuring that the same operation is not executed multiple times. It is built on the concept of idempotence, a property in mathematics and computer science where certain operations can be repeated without changing the result. The middleware is compatible with Connect-like frameworks, such as Restana and Express.js.

## Features

- **Idempotent Request Handling**: Ensures that duplicate requests with the same idempotency key are processed only once, preventing unintended side effects.
- **Original Response Replay**: On a cache hit, the middleware replays the original HTTP status code, headers, and body instead of returning a generic empty response.
- **Concurrent Request Deduplication**: Uses an in-flight lock so that simultaneous requests with the same idempotency key execute the handler only once.
- **Cache Key Scoping**: Cache keys are derived from the HTTP method, full request URL (including query string), and idempotency key to prevent cross-route and cross-method collisions.
- **Customizable Cache Integration**: Supports any cache library that implements `get` and `set` methods, allowing flexibility in your caching strategy.
- **Configurable Idempotency Key**: Lets you define the key used to identify requests. By default, it uses the `x-request-id` header.
- **Adjustable TTL (Time-to-Live)**: Provides the ability to configure the expiration time for cache entries, balancing performance and resource usage (max 24 hours).
- **HTTP Method Support**: Compatible with the following HTTP methods: `POST`, `PUT`, `PATCH`, and `DELETE`.

## Installation

```bash
npm install idempotency-middleware
```

## Usage

```javascript
import {idempotencyMiddleware} from 'idempotency-middleware'
import {createCache} from 'cache-manager'
import express, {type Request, type Response} from 'express'
import Keyv from 'keyv'
import {CacheableMemory} from 'cacheable'

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
    ttl: 5000, // 5 seconds
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
```

Calling the API

```bash
curl -X POST http://localhost:3000/create -H "x-request-id: 123"  # 200 -> Resource created!
curl -X POST http://localhost:3000/create -H "x-request-id: 123"  # 200 -> Resource created! (replayed from cache)
# after 5 seconds
curl -X POST http://localhost:3000/create -H "x-request-id: 123"  # 200 -> Resource created!
```

## Options

| Option                    | Type                                   | Default                       | Description                                                                                                                                                                                                                                            |
| ------------------------- | -------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cache`                   | `Cache`                                | required                      | A cache instance with `.get(key)` and `.set(key, value, {ttl})` methods.                                                                                                                                                                               |
| `ttl`                     | `number`                               | required                      | Cache TTL in milliseconds. Must be between `1` and `86,400,000` (24 hours).                                                                                                                                                                            |
| `idempotencyKeyExtractor` | `(req) => string \| undefined \| null` | `req.headers['x-request-id']` | Extracts the idempotency key from the request. The returned key must match `^[a-zA-Z0-9_.~-]{1,128}$`. Duplicate headers are exposed as arrays by Node.js; the default extractor does not normalize them, so idempotency is skipped for such requests. |
| `keyPrefix`               | `string`                               | `'idemp-key-'`                | Prefix prepended to every cache key.                                                                                                                                                                                                                   |
| `maxResponseSize`         | `number`                               | `1,048,576` (1 MB)            | Maximum response body size (in bytes) that will be cached. Larger responses are not cached.                                                                                                                                                            |
| `logger`                  | `Logger`                               | `console`                     | Logger used for error reporting. Must expose an `.error(...args)` method.                                                                                                                                                                              |

### Behavior notes

- Only successful responses with a `2xx` status code are cached.
- Hop-by-hop and connection-level headers such as `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Content-Length`, and `Date` are stripped before replay and are not restored from the cache.
- Responses larger than `maxResponseSize` are still served to the client; only the cache write is skipped.
- Previous versions stored a plain string (`"1"`) in the cache. Those entries are ignored after upgrading, so only new responses will be replayed.

## Customizing idempotency key

By default, the middleware uses the `x-request-id` header to identify the request. You can customize the key that will be used to identify the request by passing a custom `idempotencyKeyExtractor` function to the middleware.

> In production environments, it is **strongly recommended** to combine the `x-request-id` header with user/tenant identifiers (e.g., a hashed user ID or session token) to ensure the key's uniqueness and prevent cross-user collisions.

```javascript
function extractIdempotencyKey(req: Request) {
  const header = req.headers['x-custom-req-id']
  const value = Array.isArray(header) ? header[0] : header
  if (!value || !/^[a-zA-Z0-9_.~-]{1,128}$/.test(value)) {
    return undefined
  }
  // Scope the key with a service and user identifier to prevent cross-user collisions.
  const userId = req.user?.id ?? 'anonymous'
  return `${SERVICE_NAME}-${userId}-${value}`
}

app.use(
  idempotencyMiddleware({
    ttl: 5000,
    idempotencyKeyExtractor: extractIdempotencyKey,
    //...,
  }),
)
```

### Security Considerations

The middleware is designed to operate safely in untrusted or partially trusted environments when configured correctly. Keep the following risks and mitigations in mind:

#### 1. **Cache Flooding**

An attacker could overwhelm the cache by sending a high volume of requests with unique `x-request-id` values, exhausting resources and degrading performance.

**Mitigation:**

- Implement rate limiting and throttling mechanisms at the middleware or API gateway level.
- Set a maximum capacity for the idempotency cache, with a defined eviction policy (e.g., Least Recently Used (LRU) strategy).
- Use the `maxResponseSize` option to avoid caching very large responses.
- Monitor and log unusual traffic patterns to detect and respond to potential attacks promptly.

#### 2. **Identity Spoofing**

An attacker could forge the `x-request-id` header to impersonate another user's requests, potentially interfering with their operations.

**Mitigation:**

- Use a secure idempotency key that combines the `x-request-id` header with user-specific information, such as a hashed user identifier or session token.
- Encrypt or digitally sign the `x-request-id` value to ensure its authenticity and prevent tampering.

#### 3. **Concurrent Duplicate Processing**

Without locking, two simultaneous requests with the same idempotency key could both execute the underlying handler.

**Mitigation:**

- This middleware now maintains an in-flight lock per idempotency key so that duplicate concurrent requests wait for the first request to finish and then replay its cached response.

#### General Recommendations

- Regularly audit the middleware's security practices and ensure compliance with your organization's security standards.
- Use HTTPS to protect the `x-request-id` header and prevent interception or tampering during transmission.
- Test your middleware against common attack scenarios, such as denial-of-service (DoS) or injection attacks, to ensure robust protection.

## License

See the [LICENSE](LICENSE) file for license rights and limitations (MIT).
