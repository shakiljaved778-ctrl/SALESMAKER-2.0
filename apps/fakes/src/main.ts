import { buildFakesServer } from './server.js';

const port = Number.parseInt(process.env['FAKES_PORT'] ?? '4200', 10);
const app = buildFakesServer();
await app.listen({ port, host: '0.0.0.0' });
process.stdout.write(`fakes listening on :${String(port)}\n`);
