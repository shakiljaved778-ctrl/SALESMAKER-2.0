import { createHash, randomBytes, randomUUID } from 'node:crypto';

import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

/**
 * Fake OpenID Connect identity providers standing in for Google and Microsoft (§10.5): discovery,
 * an authorize page where you type the identity you want, a token endpoint that enforces client
 * authentication, redirect-URI matching and PKCE (S256), RS256 ID tokens, and JWKS. Nothing here
 * talks to the real providers.
 */
export interface FakeOidcClient {
  clientId: string;
  clientSecret: string;
}

export interface FakeOidcOptions {
  /** External base URL of the server hosting the fakes, e.g. http://localhost:4200 */
  baseUrl: string;
  providers: Partial<Record<'google' | 'microsoft', FakeOidcClient>>;
}

interface PendingCode {
  provider: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string | undefined;
  email: string;
  name: string;
  emailVerified: boolean;
  expiresAt: number;
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** Stable subject per provider and email, like a real IdP. */
export function fakeSubject(provider: string, email: string): string {
  return createHash('sha256')
    .update(`${provider}:${email.toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
}

export async function registerFakeOidc(
  app: FastifyInstance,
  options: FakeOidcOptions,
): Promise<void> {
  await app.register(formbody);
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = randomUUID();
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();

  for (const [provider, client] of Object.entries(options.providers)) {
    const issuer = `${options.baseUrl.replace(/\/$/, '')}/${provider}`;
    const base = `/${provider}`;

    app.get(`${base}/.well-known/openid-configuration`, () => ({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'email', 'profile'],
    }));

    app.get(`${base}/jwks`, () => ({ keys: [jwk] }));

    const issueCode = (
      reply: FastifyReply,
      q: Record<string, string | undefined>,
      email: string,
      name: string,
      verified: boolean,
    ) => {
      const code = randomBytes(24).toString('base64url');
      codes.set(code, {
        provider,
        clientId: q['client_id'] ?? '',
        redirectUri: q['redirect_uri'] ?? '',
        codeChallenge: q['code_challenge'] ?? '',
        nonce: q['nonce'],
        email,
        name,
        emailVerified: verified,
        expiresAt: Date.now() + 60_000,
      });
      const target = new URL(q['redirect_uri'] ?? '');
      target.searchParams.set('code', code);
      if (q['state']) target.searchParams.set('state', q['state']);
      return reply.redirect(target.toString(), 302);
    };

    const validate = (q: Record<string, string | undefined>): string | null => {
      if (q['client_id'] !== client.clientId) return 'unknown client_id';
      if (q['response_type'] !== 'code') return 'response_type must be code';
      if (q['code_challenge_method'] !== 'S256' || !q['code_challenge'])
        return 'PKCE S256 is required';
      if (!q['redirect_uri']) return 'redirect_uri is required';
      return null;
    };

    // Authorize: a form to pick the identity. `fake_email` auto-approves (for API tests).
    app.get<{ Querystring: Record<string, string | undefined> }>(
      `${base}/authorize`,
      async (request, reply) => {
        const q = request.query;
        const problem = validate(q);
        if (problem) return reply.status(400).send(problem);
        if (q['fake_email']) {
          return issueCode(
            reply,
            q,
            q['fake_email'],
            q['fake_name'] ?? 'Test User',
            q['fake_unverified'] !== '1',
          );
        }
        const hidden = Object.entries(q)
          .map(
            ([k, v]) =>
              `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v ?? '')}">`,
          )
          .join('');
        const title = provider === 'google' ? 'Fake Google' : 'Fake Microsoft';
        return reply.type('text/html')
          .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} sign-in</title></head>
<body style="font-family:system-ui;max-width:420px;margin:48px auto"><h1>${title}</h1><p>Local fake identity provider. No real account is used.</p>
<form method="post" action="${base}/authorize">${hidden}
<label>Email <input name="email" type="email" required value="${escapeHtml(q['login_hint'] ?? '')}"></label><br><br>
<label>Name <input name="name" required value="Test User"></label><br><br>
<button type="submit">Continue</button></form></body></html>`);
      },
    );

    app.post<{ Body: Record<string, string | undefined> }>(
      `${base}/authorize`,
      async (request, reply) => {
        const q = request.body;
        const problem = validate(q);
        if (problem) return reply.status(400).send(problem);
        return issueCode(reply, q, q['email'] ?? '', q['name'] ?? 'Test User', true);
      },
    );

    app.post<{ Body: Record<string, string | undefined> }>(
      `${base}/token`,
      async (request, reply) => {
        const body = request.body;
        let clientId = body['client_id'];
        let clientSecret = body['client_secret'];
        const basic = request.headers.authorization;
        if (basic?.startsWith('Basic ')) {
          const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
          clientId = decodeURIComponent(id ?? '');
          clientSecret = decodeURIComponent(secret ?? '');
        }
        if (clientId !== client.clientId || clientSecret !== client.clientSecret) {
          return reply.status(401).send({ error: 'invalid_client' });
        }
        const pending = codes.get(body['code'] ?? '');
        codes.delete(body['code'] ?? '');
        if (
          !pending ||
          pending.provider !== provider ||
          pending.expiresAt < Date.now() ||
          pending.clientId !== clientId
        ) {
          return reply.status(400).send({ error: 'invalid_grant' });
        }
        if (pending.redirectUri !== body['redirect_uri'])
          return reply
            .status(400)
            .send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        const challenge = createHash('sha256')
          .update(body['code_verifier'] ?? '')
          .digest('base64url');
        if (challenge !== pending.codeChallenge)
          return reply
            .status(400)
            .send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });

        const subject = fakeSubject(provider, pending.email);
        const claims: Record<string, unknown> = {
          email: pending.email,
          email_verified: pending.emailVerified,
          name: pending.name,
          ...(pending.nonce ? { nonce: pending.nonce } : {}),
          ...(provider === 'microsoft'
            ? {
                oid: subject,
                tid: '9188040d-6c67-4c5b-b112-36a304b66dad',
                preferred_username: pending.email,
              }
            : {}),
        };
        const idToken = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'RS256', kid })
          .setIssuer(issuer)
          .setAudience(client.clientId)
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return {
          access_token: randomBytes(24).toString('base64url'),
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        };
      },
    );
  }
}
