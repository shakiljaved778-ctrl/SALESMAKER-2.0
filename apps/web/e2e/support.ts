import { createHmac, randomBytes } from 'node:crypto';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';

export const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';
export const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
export const CONTROL_API = process.env.E2E_CONTROL_API_URL ?? 'http://localhost:4100';
export const PASSWORD = 'correct horse battery staple';

/** A slug no other run has used: runs share one stack. */
export function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}

export function workspaceUrl(slug: string, path = '/'): string {
  const base = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3000');
  return `${base.protocol}//${slug}.${base.host}${path}`;
}

interface MailpitMessage {
  ID: string;
  Subject: string;
}

/** The newest email to `to` whose subject matches, from Mailpit (nothing is delivered for real). */
export async function latestEmail(to: string, subject: RegExp): Promise<{ text: string }> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
    ).json()) as { messages?: MailpitMessage[] };
    const hit = search.messages?.find((m) => subject.test(m.Subject));
    if (hit) {
      const message = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
      };
      return { text: message.Text };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No email to ${to} matching ${String(subject)}`);
}

export function linkIn(text: string, path: string): string {
  const match = new RegExp(`https?://\\S+${path}\\?token=[\\w-]+`).exec(text);
  if (!match) throw new Error(`No ${path} link in the email`);
  return match[0];
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), `offset` time steps from now. */
export function totp(base32Secret: string, offset = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32Secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(
    Array.from({ length: Math.floor(bits.length / 8) }, (_, i) =>
      parseInt(bits.slice(i * 8, i * 8 + 8), 2),
    ),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const at = (hmac[hmac.length - 1] ?? 0) & 15;
  return String((hmac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** axe is release-blocking (§9.14): no serious or critical violations. */
export async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(blocking, 'axe serious/critical violations').toEqual([]);
}

/** Set display preferences the way the app does, before the page loads. */
export async function preferDisplay(
  page: Page,
  host: string,
  prefs: { theme?: string; density?: string; locale?: string },
): Promise<void> {
  const domain = new URL(host).hostname;
  await page.context().addCookies(
    Object.entries({ sm_theme: prefs.theme, sm_density: prefs.density, sm_locale: prefs.locale })
      .filter((e): e is [string, string] => e[1] !== undefined)
      .map(([name, value]) => ({ name, value, domain, path: '/' })),
  );
}

/**
 * Visual baseline (§13.3). The blocking CI pass sets E2E_SKIP_VISUAL (fonts render slightly
 * differently between machines); a second, non-blocking pass compares and uploads the diffs.
 */
export async function expectScreenshot(
  page: Page,
  name: string,
  options: { mask?: Locator[]; fullPage?: boolean } = {},
): Promise<void> {
  if (process.env.E2E_SKIP_VISUAL) return;
  await expect(page).toHaveScreenshot(name, options);
}
