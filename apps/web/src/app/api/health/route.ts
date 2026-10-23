import { webEnvProblems } from '../../../server/env';

export const dynamic = 'force-dynamic';

/**
 * Liveness for the load balancer and the deploy smoke test; the web tier holds no state of its
 * own. A deployment missing required settings answers 503 with the variable names (never values).
 */
export function GET(): Response {
  const missing = webEnvProblems();
  const headers = { 'cache-control': 'no-store' };
  if (missing.length > 0)
    return Response.json({ status: 'misconfigured', missing }, { status: 503, headers });
  return Response.json({ status: 'ok' }, { headers });
}
