# Idempotency Middleware

This middleware enables your API to handle requests idempotently, ensuring that the same operation is not executed multiple times. It is built on the concept of idempotence, a property in mathematics and computer science where certain operations can be repeated without changing the result. The middleware is compatible with Connect-like frameworks, such as Restana and Express.js.

## Features

- **Idempotent Request Handling**: Ensures that duplicate requests with the same idempotency key are processed only once, preventing unintended side effects.
- **Customizable Cache Integration**: Supports any cache library that implements `get` and `set` methods, allowing flexibility in your caching strategy.
- **Configurable Idempotency Key**: Lets you define the key used to identify requests. By default, it uses the `x-request-id` header.
- **Adjustable TTL (Time-to-Live)**: Provides the ability to configure the expiration time for cache entries, balancing performance and resource usage.
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
curl -X POST http://localhost:3000/create -H "x-request-id: 123"  # 204
# after 5 seconds
curl -X POST http://localhost:3000/create -H "x-request-id: 123"  # 200 -> Resource created!
```

## Customizing idempotency key

By default, the middleware uses the `x-request-id` header to identify the request. You can customize the key that will be used to identify the request by passing a custom `idempotencyKeyExtractor` function to the middleware.

> In production environments, it is recommended to use a combination of the `x-request-id` header and other unique identifiers such as `service-name` and `user-id` to ensure the key's uniqueness and prevent collisions.

```javascript
app.use(
  idempotencyMiddleware({
    ttl: 5000,
    idempotencyKeyExtractor: (req: Request) => {
      return `${SERVICE_NAME}-${req.headers['x-custom-req-id']}`
    },
    //...,
  }),
)
```

### Security Considerations

The middleware is designed to operate in a trusted environment. If you plan to deploy it in an untrusted or partially trusted environment, take the following risks and mitigations into account:

#### 1. **Cache Flooding**

An attacker could overwhelm the cache by sending a high volume of requests with unique `x-request-id` values, exhausting resources and degrading performance.

**Mitigation:**

- Implement rate limiting and throttling mechanisms at the middleware or API gateway level.
- Set a maximum capacity for the idempotency cache, with a defined eviction policy (e.g., Least Recently Used (LRU) strategy).
- Monitor and log unusual traffic patterns to detect and respond to potential attacks promptly.

#### 2. **Identity Spoofing**

An attacker could forge the `x-request-id` header to impersonate another user's requests, potentially interfering with their operations.

**Mitigation:**

- Use a secure idempotency key that combines the `x-request-id` header with user-specific information, such as a hashed user identifier or session token.
- Encrypt or digitally sign the `x-request-id` value to ensure its authenticity and prevent tampering.

#### General Recommendations

- Regularly audit the middleware's security practices and ensure compliance with your organization's security standards.
- Use HTTPS to protect the `x-request-id` header and prevent interception or tampering during transmission.
- Test your middleware against common attack scenarios, such as denial-of-service (DoS) or injection attacks, to ensure robust protection.

## License

See the [LICENSE](LICENSE) file for license rights and limitations (MIT).
