import { notFound } from 'next/navigation';

import { EditorPage } from '../../../../components/records/editor-page';
import { objectForSection } from '../../../../components/records/fields';

const FIELD = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Full-page create (§9.11); `?account_id=…` prefills a field, `?recordTypeId=…` skips the picker. */
export default async function NewRecordRoute({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { section } = await params;
  const object = objectForSection(section);
  if (!object) notFound();
  const query = await searchParams;
  const prefill: Record<string, string> = {};
  for (const [key, value] of Object.entries(query))
    if (FIELD.test(key) && typeof value === 'string' && value.length <= 255) prefill[key] = value;
  const recordTypeId =
    typeof query['recordTypeId'] === 'string' && UUID.test(query['recordTypeId'])
      ? query['recordTypeId']
      : undefined;
  return (
    <EditorPage
      object={object}
      section={section}
      prefill={prefill}
      {...(recordTypeId ? { recordTypeId } : {})}
    />
  );
}
