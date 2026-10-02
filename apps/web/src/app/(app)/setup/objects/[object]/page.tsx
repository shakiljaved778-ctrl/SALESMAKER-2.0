import { notFound } from 'next/navigation';

import { ObjectDetailPage } from '../../../../../components/setup/objects/objects-pages';

const OBJECT = /^[a-z][a-z0-9_]{0,62}$/;

export default async function ObjectPage({ params }: { params: Promise<{ object: string }> }) {
  const { object } = await params;
  if (!OBJECT.test(object)) notFound();
  return <ObjectDetailPage object={object} />;
}
