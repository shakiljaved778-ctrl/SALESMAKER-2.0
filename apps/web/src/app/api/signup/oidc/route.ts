import { startSignup } from '../../../../server/oidc';
import { bffDeps } from '../../../../server/deps';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return startSignup(request, bffDeps());
}
