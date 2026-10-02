import { notFound } from 'next/navigation';

import { objectForSection } from '../../../../components/records/fields';
import { RecordPage } from '../../../../components/records/record-page';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Record page (§9.11 T2) for the object homes' records. */
export default async function RecordRoute({
  params,
}: {
  params: Promise<{ section: string; id: string }>;
}) {
  const { section, id } = await params;
  const object = objectForSection(section);
  if (!object || !UUID.test(id)) notFound();
  return <RecordPage key={id} object={object} section={section} id={id} />;
}
