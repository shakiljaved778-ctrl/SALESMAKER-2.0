import { notFound } from 'next/navigation';

import { EditorPage } from '../../../../../components/records/editor-page';
import { objectForSection } from '../../../../../components/records/fields';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Full-page edit (§9.11). */
export default async function EditRecordRoute({
  params,
}: {
  params: Promise<{ section: string; id: string }>;
}) {
  const { section, id } = await params;
  const object = objectForSection(section);
  if (!object || !UUID.test(id)) notFound();
  return <EditorPage key={id} object={object} section={section} id={id} />;
}
