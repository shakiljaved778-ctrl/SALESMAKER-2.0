import { startSignIn } from '../../../../server/oidc';
import { bffDeps } from '../../../../server/deps';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  return startSignIn(request, bffDeps(), (await params).provider);
}
