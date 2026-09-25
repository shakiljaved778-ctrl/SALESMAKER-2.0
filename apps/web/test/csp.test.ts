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
