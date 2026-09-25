export const dynamic = 'force-dynamic';

/** Liveness for the load balancer; the web tier holds no state of its own. */
export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
