import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

/** Passwords the fake range API reports as breached. Tests and e2e rely on these. */
export const BREACHED_PASSWORDS = [
  'password1234',
  'correcthorsebatterystaple',
  'letmein-please',
  'Summer2026!',
];

const sha1 = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();
const BREACHED = new Map(BREACHED_PASSWORDS.map((p, i) => [sha1(p), 1000 + i]));

/** Fake Have I Been Pwned k-anonymity range API: `GET /hibp/range/{prefix}` → `SUFFIX:COUNT` lines. */
export function registerFakeHibp(app: FastifyInstance): void {
  app.get<{ Params: { prefix: string } }>('/hibp/range/:prefix', async (request, reply) => {
    const prefix = request.params.prefix.toUpperCase();
    if (!/^[0-9A-F]{5}$/.test(prefix))
      return reply.status(400).send('The hash prefix was not in a valid format');
    const lines = [...BREACHED]
      .filter(([hash]) => hash.startsWith(prefix))
      .map(([hash, count]) => `${hash.slice(5)}:${String(count)}`);
    // Padding entries with count 0, like the real API's Add-Padding option.
    lines.push(`${'0'.repeat(35)}:0`);
    return reply.type('text/plain').send(lines.join('\r\n'));
  });
}
