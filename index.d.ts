import {IncomingMessage, ServerResponse} from 'http'

/**
 * Options for configuring cache behavior.
 */
export interface CacheOptions {
  /**
   * Time-to-live for the cached entries, in milliseconds.
   * Optional; defaults depend on the caching library used.
   */
  ttl?: number
}

/**
 * Interface for a cache implementation.
 * A compatible cache must implement `get` and `set` methods.
 */
export interface Cache {
  /**
   * Retrieves the value associated with the given key from the cache.
   *
   * @param key - The key to look up in the cache.
   * @returns A promise that resolves to the cached value, or `null` if the key is not found.
   */
  get(key: string): Promise<any>

  /**
   * Stores a value in the cache with the specified key and options.
   *
   * @param key - The key to store the value under.
   * @param value - The value to store in the cache.
   * @param options - Additional options, such as TTL.
   * @returns A promise that resolves once the value is stored.
   */
  set(key: string, value: any, options?: CacheOptions): Promise<any>
}

/**
 * Logger interface for custom logging implementations.
 */
export interface Logger {
  /**
   * Logs an error message or error object.
   *
   * @param args - The error message or objects to log.
   */
  error(...args: any[]): void
}

/**
 * Configuration options for the idempotency middleware.
 */
export interface IdempotencyMiddlewareOptions {
  /**
   * A cache instance that supports `get` and `set` methods.
   * Compatible with libraries like `cache-manager`.
   */
  cache: Cache

  /**
   * Default time-to-live for cached responses, in milliseconds.
   * Must be between 1 and 86,400,000 (24 hours).
   */
  ttl: number

  /**
   * A function to extract the idempotency key from the HTTP request.
   * Defaults to extracting the `x-request-id` header.
   *
   * The returned key must be a non-empty string of at most 128 characters
   * matching `^[a-zA-Z0-9_.~-]+$`. In multi-user environments the key should
   * be scoped with a user/tenant identifier to prevent cross-user collisions.
   *
   * @param req - The incoming HTTP request.
   * @returns The extracted idempotency key, or `undefined`/`null` to disable idempotency.
   */
  idempotencyKeyExtractor?: (req: IncomingMessage) => string | undefined | null

  /**
   * An optional logger for error reporting.
   * The logger must implement at least an `error` method.
   * Defaults to using `console.error`.
   */
  logger?: Logger

  /**
   * A prefix to prepend to cache keys to avoid collisions with other cached data.
   * Defaults to `'idemp-key-'`.
   */
  keyPrefix?: string

  /**
   * Maximum response body size (in bytes) that will be cached.
   * Responses larger than this value are not cached, preventing cache memory exhaustion.
   * Defaults to 1 MB (1,048,576 bytes).
   */
  maxResponseSize?: number
}

/**
 * Creates an idempotency middleware function.
 *
 * The middleware ensures idempotent handling of requests by:
 * - Checking if a response for a unique request key (idempotency key) is cached.
 * - Returning the cached response if available, skipping reprocessing.
 * - Caching successful responses (status codes 2xx) for future requests.
 *
 * The cache key is scoped by HTTP method, request URL, and the extracted idempotency
 * key, and the middleware uses an in-flight lock to prevent concurrent duplicate
 * processing of the same key.
 *
 * @param options - Configuration options for the middleware.
 * @returns A middleware function compatible with Connect-like frameworks.
 */
export function idempotencyMiddleware(
  options: IdempotencyMiddlewareOptions,
): (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void

/**
 * Generates a SHA-256 hash of the input string.
 *
 * @param data - The string to hash.
 * @returns The hexadecimal SHA-256 hash of the input string.
 */
export function hashSha256(data: string): string
