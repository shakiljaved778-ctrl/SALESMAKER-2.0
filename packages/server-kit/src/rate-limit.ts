import type { Redis } from 'ioredis';

/**
 * Token bucket in Valkey/Redis (§3.6, §10.1). One Lua script per call keeps it atomic across
 * API nodes, and the server clock (TIME) avoids node clock skew.
 * KEYS[1] bucket key · ARGV[1] capacity · ARGV[2] refill per second · ARGV[3] cost
 * Returns { allowed (0|1), remaining tokens (floored), ms until one token is available }.
 */
const TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2]) / 1000
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill_per_ms)
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_per_ms) + 1000)
local wait = 0
if tokens < 1 then wait = math.ceil((1 - tokens) / refill_per_ms) end
return { allowed, math.floor(tokens), wait }
`;

export interface RateLimitPolicy {
  /** Burst size. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until at least one more request is allowed. */
  resetSeconds: number;
}

type RedisWithBucket = Redis & {
  smTokenBucket(
    key: string,
    capacity: number,
    refill: number,
    cost: number,
  ): Promise<[number, number, number]>;
};

export class TokenBucketRateLimiter {
  private readonly redis: RedisWithBucket;

  constructor(
    redis: Redis,
    private readonly prefix = 'rl',
  ) {
    if (!('smTokenBucket' in redis))
      redis.defineCommand('smTokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET });
    this.redis = redis as RedisWithBucket;
  }

  async consume(key: string, policy: RateLimitPolicy, cost = 1): Promise<RateLimitResult> {
    const [allowed, remaining, waitMs] = await this.redis.smTokenBucket(
      `${this.prefix}:${key}`,
      policy.capacity,
      policy.refillPerSecond,
      cost,
    );
    return {
      allowed: allowed === 1,
      limit: policy.capacity,
      remaining,
      resetSeconds: Math.ceil(waitMs / 1000),
    };
  }
}

/** Standard RateLimit headers (§10.1). */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(result.resetSeconds),
  };
}
