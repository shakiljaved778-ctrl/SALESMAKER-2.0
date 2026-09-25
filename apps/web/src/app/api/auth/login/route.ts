import { login } from '../../../../server/bff';
import { bffDeps } from '../../../../server/deps';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return login(request, bffDeps());
}
