import { notFound } from 'next/navigation';

import { LayoutEditorPage } from '../../../../../../../components/setup/objects/layouts';

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LayoutPage({
  params,
}: {
  params: Promise<{ object: string; id: string }>;
}) {
  const { object, id } = await params;
  if (!NAME.test(object) || !UUID.test(id)) notFound();
  return <LayoutEditorPage key={id} object={object} id={id} />;
}
