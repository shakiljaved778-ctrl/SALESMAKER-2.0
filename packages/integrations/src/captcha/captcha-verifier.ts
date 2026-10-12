/**
 * Bot challenges on public forms (§7.1): Cloudflare Turnstile in cells once keys are provided,
 * a fake locally and in CI. Only the visitor's token and IP are sent.
 */
export interface CaptchaVerifier {
  /** The public key the browser widget needs. */
  readonly siteKey: string;
  /** Whether the token proves a human solved the challenge. Network failures are `false`. */
  verify(token: string, remoteIp?: string): Promise<boolean>;
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Turnstile's server-side verification (`siteverify`). */
export class TurnstileVerifier implements CaptchaVerifier {
  constructor(
    readonly siteKey: string,
    private readonly secretKey: string,
    private readonly url = SITEVERIFY,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 3_000,
  ) {}

  async verify(token: string, remoteIp?: string): Promise<boolean> {
    if (!token || token.length > 2048) return false;
    const body = new URLSearchParams({ secret: this.secretKey, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return false;
      const out = (await res.json()) as { success?: unknown };
      return out.success === true;
    } catch {
      return false;
    }
  }
}

/** Test double: the token `pass` (or any listed) passes, everything else fails. */
export class FakeCaptchaVerifier implements CaptchaVerifier {
  readonly siteKey = 'fake-site-key';
  constructor(private readonly passing: ReadonlySet<string> = new Set(['pass'])) {}

  verify(token: string): Promise<boolean> {
    return Promise.resolve(this.passing.has(token));
  }
}
