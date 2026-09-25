import Fastify, { type FastifyInstance } from 'fastify';

import { registerFakeHibp } from './fake-hibp.js';
import { registerFakeOidc, type FakeOidcOptions } from './fake-oidc.js';

export type FakesServerOptions = FakeOidcOptions;

/** All third-party fakes on one Fastify server (served by apps/fakes on :4200 locally). */
export async function buildFakesServer(options: FakesServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get('/health', () => ({ status: 'ok', service: 'fakes' }));
  registerFakeHibp(app);
  await registerFakeOidc(app, options);
  return app;
}
