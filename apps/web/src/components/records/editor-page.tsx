'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { cellApi } from '../../lib/cell-api';
import type { DescribedObject } from './fields';
import { RecordEditor, type RecordEditorProps } from './record-editor';

/** Full-page create or edit (§9.11): a titled card around the record form. */
export function EditorPage(props: Omit<RecordEditorProps, 'quick' | 'onDone'>) {
  const t = useTranslations('records.editor');
  const [label, setLabel] = useState('');
  useEffect(() => {
    void cellApi<DescribedObject>('GET', `/v1/objects/${props.object}/describe`).then((r) => {
      if (r.ok) setLabel(r.data.label);
    });
  }, [props.object]);
  return (
    <div className="grid max-w-5xl gap-4 p-[var(--page-padding)]">
      <h1 className="text-title-1 text-fg">
        {label
          ? props.id
            ? t('editTitle', { object: label })
            : t('newTitle', { object: label })
          : ' '}
      </h1>
      <div className="rounded-md border border-line bg-surface p-4 shadow-e1">
        <RecordEditor {...props} />
      </div>
    </div>
  );
}
