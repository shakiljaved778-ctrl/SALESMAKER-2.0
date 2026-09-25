import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';

import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

interface PendingCode {
  nonce: string;
  codeChallenge: string;
  claims: Record<string, unknown>;
}

export interface FakeOidcIssuer {
  issuer: string;
  /** Fail the next N discovery requests with a 503. */
  failDiscovery(times: number): void;
  /** What the authorize endpoint would hand back after the user signs in. */
  issueCode(input: PendingCode): string;
  tokenRequests: URLSearchParams[];
  close(): Promise<void>;
}

/**
 * A minimal OpenID Connect issuer (discovery, JWKS, token endpoint with PKCE S256 check) so the
 * real openid-client adapter is exercised in-process, with no provider or network egress.
 */
export async function startFakeOidcIssuer(clientId: string): Promise<FakeOidcIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  const tokenRequests: URLSearchParams[] = [];
  let discoveryFailures = 0;
  let issuer = '';

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      if (discoveryFailures > 0) {
        discoveryFailures -= 1;
        json(res, 503, { error: 'unavailable' });
        return;
      }
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }
    if (url.pathname === '/jwks') {
      json(res, 200, { keys: [jwk] });
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        tokenRequests.push(form);
        const pending = codes.get(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!pending || challenge !== pending.codeChallenge) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        codes.delete(form.get('code') ?? '');
        void new SignJWT({ nonce: pending.nonce, ...pending.claims })
          .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey)
          .then((idToken) => {
            json(res, 200, {
              access_token: randomUUID(),
              token_type: 'Bearer',
              expires_in: 300,
              id_token: idToken,
            });
          });
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  issuer = `http://127.0.0.1:${String(address.port)}`;

  return {
    issuer,
    tokenRequests,
    failDiscovery(times) {
      discoveryFailures = times;
    },
    issueCode(input) {
      const code = randomUUID();
      codes.set(code, input);
      return code;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
