import Fastify, { type FastifyInstance } from 'fastify';

import { registerHibp } from './hibp.js';

export function buildFakesServer(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/health', () => ({ status: 'ok', service: 'fakes' }));
  registerHibp(app);
  return app;
}
