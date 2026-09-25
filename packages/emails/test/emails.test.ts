import { describe, expect, it } from 'vitest';

import {
  renderResetPasswordEmail,
  renderVerifyEmail,
  renderWorkspacesEmail,
} from '../src/index.js';

describe('system emails', () => {
  it('renders the verification email with translated copy, the link and a plain-text part', async () => {
    const email = await renderVerifyEmail({
      locale: 'en',
      name: 'Amira',
      workspace: 'Pixelcraft',
      url: 'https://pixelcraft.salesmaker.app/verify-email?token=abc',
      expiresInHours: 24,
    });
    expect(email.subject).toBe('Verify your email for SalesMaker');
    expect(email.html).toContain('href="https://pixelcraft.salesmaker.app/verify-email?token=abc"');
    expect(email.html).toContain('This link expires in 24 hours.');
    expect(email.html).toContain('content="light only"');
    expect(email.text).toContain('Hi Amira, confirm your email to finish setting up Pixelcraft.');
  });

  it('escapes user-supplied values', async () => {
    const email = await renderResetPasswordEmail({
      locale: 'en',
      name: '<script>alert(1)</script>',
      workspace: 'Acme & Co',
      url: 'https://acme.salesmaker.app/reset?token=x',
      expiresInMinutes: 30,
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('Acme &amp; Co');
  });

  it('pluralises the workspace list and renders RTL for the ar-XB pseudo-locale', async () => {
    const none = await renderWorkspacesEmail({ locale: 'en', workspaces: [] });
    expect(none.text).toContain("We couldn't find any workspaces");
    const two = await renderWorkspacesEmail({
      locale: 'ar-XB',
      workspaces: [
        { name: 'Pixelcraft', url: 'https://pixelcraft.salesmaker.app' },
        { name: 'Aurelia', url: 'https://aurelia.salesmaker.app' },
      ],
    });
    expect(two.text).toContain('belongs to 2 workspaces');
    expect(two.html).toContain('dir="rtl"');
  });
});
