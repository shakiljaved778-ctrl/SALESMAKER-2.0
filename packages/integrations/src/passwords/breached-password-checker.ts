import { createHash } from 'node:crypto';

/** Breached-password check (§6.1). Only a 5-character SHA-1 prefix ever leaves the process. */
export interface BreachedPasswordChecker {
  /** Number of times the password appears in known breaches (0 = not found). */
  breachCount(password: string): Promise<number>;
}

export function sha1Upper(password: string): string {
  return createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
}

/**
 * k-anonymity range API client (Have I Been Pwned format: `GET {base}/range/{prefix}` returns
 * `SUFFIX:COUNT` lines). Locally and in CI the base URL points at apps/fakes.
 */
export class RangeApiBreachedPasswordChecker implements BreachedPasswordChecker {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 2_000,
  ) {}

  async breachCount(password: string): Promise<number> {
    const hash = sha1Upper(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`breached-password range API answered ${String(res.status)}`);
    for (const line of (await res.text()).split(/\r?\n/)) {
      const [lineSuffix, count] = line.trim().split(':');
      if (lineSuffix === suffix) return Number.parseInt(count ?? '0', 10);
    }
    return 0;
  }
}

/** Test double: a fixed list of breached passwords. */
export class FakeBreachedPasswordChecker implements BreachedPasswordChecker {
  constructor(
    private readonly breached: ReadonlySet<string> = new Set([
      'password1234',
      'correcthorsebatterystaple',
    ]),
  ) {}

  breachCount(password: string): Promise<number> {
    return Promise.resolve(this.breached.has(password) ? 42 : 0);
  }
}
