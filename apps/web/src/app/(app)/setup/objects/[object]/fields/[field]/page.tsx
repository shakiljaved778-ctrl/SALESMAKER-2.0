import { notFound } from 'next/navigation';

import { FieldDetailPage } from '../../../../../../../components/setup/objects/field-detail';

const NAME = /^[a-z][a-z0-9_]{0,62}$/;

export default async function FieldPage({
  params,
}: {
  params: Promise<{ object: string; field: string }>;
}) {
  const { object, field } = await params;
  if (!NAME.test(object) || !NAME.test(field)) notFound();
  return <FieldDetailPage key={`${object}.${field}`} object={object} field={field} />;
}
