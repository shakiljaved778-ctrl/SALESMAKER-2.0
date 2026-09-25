import { signup } from '../../../server/apex';
import { bffDeps } from '../../../server/deps';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return signup(request, bffDeps());
}
