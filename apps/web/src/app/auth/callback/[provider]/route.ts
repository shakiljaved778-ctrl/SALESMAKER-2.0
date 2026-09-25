import { completeSignIn } from '../../../../server/oidc';
import { bffDeps } from '../../../../server/deps';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  return completeSignIn(request, bffDeps(), (await params).provider);
}
