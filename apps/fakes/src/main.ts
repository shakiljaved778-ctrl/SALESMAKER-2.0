import { buildFakesServer } from '@sm/testing';

const port = Number.parseInt(process.env['FAKES_PORT'] ?? '4200', 10);
const app = await buildFakesServer({
  baseUrl: process.env['FAKES_BASE_URL'] ?? `http://localhost:${String(port)}`,
  providers: {
    google: {
      clientId: process.env['OIDC_GOOGLE_CLIENT_ID'] ?? 'fake-google-client',
      clientSecret: process.env['OIDC_GOOGLE_CLIENT_SECRET'] ?? 'fake-google-secret',
    },
    microsoft: {
      clientId: process.env['OIDC_MICROSOFT_CLIENT_ID'] ?? 'fake-microsoft-client',
      clientSecret: process.env['OIDC_MICROSOFT_CLIENT_SECRET'] ?? 'fake-microsoft-secret',
    },
  },
});
await app.listen({ port, host: '0.0.0.0' });
process.stdout.write(`fakes listening on :${String(port)}\n`);
