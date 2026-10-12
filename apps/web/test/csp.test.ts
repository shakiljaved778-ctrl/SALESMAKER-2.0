import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy } from '../src/server/csp';

describe('contentSecurityPolicy', () => {
  it('allows only this origin and nonce-stamped scripts in production', () => {
    const csp = contentSecurityPolicy('abc123', { dev: false, https: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('adds eval only for development and drops the https upgrade on plain http', () => {
    const csp = contentSecurityPolicy('n', { dev: true, https: false });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});

describe('contentSecurityPolicy for hosted web forms', () => {
  it('lets any site frame the form and Turnstile load, and nothing more', () => {
    const csp = contentSecurityPolicy('n', { dev: false, https: true, embeddable: true });
    expect(csp).toContain('frame-ancestors *');
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(csp).toContain(
      "script-src 'self' 'nonce-n' 'strict-dynamic' https://challenges.cloudflare.com",
    );
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp).toContain("connect-src 'self' https://challenges.cloudflare.com");
    expect(contentSecurityPolicy('n', { dev: false, https: true })).not.toContain('challenges');
  });
});
