import { savePreferences } from '../../../../server/bff';
import { bffDeps } from '../../../../server/deps';

export const dynamic = 'force-dynamic';

export function PATCH(request: Request): Promise<Response> {
  return savePreferences(request, bffDeps());
}
