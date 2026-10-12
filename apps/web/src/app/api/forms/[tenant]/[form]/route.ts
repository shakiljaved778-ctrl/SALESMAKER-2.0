import { bffDeps } from '../../../../../server/deps';
import { submitPublicForm } from '../../../../../server/forms';

export const dynamic = 'force-dynamic';

/** A hosted form's submissions (§7.1), relayed to the workspace's cell. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenant: string; form: string }> },
): Promise<Response> {
  const { tenant, form } = await params;
  return submitPublicForm(request, bffDeps(), tenant, form);
}
