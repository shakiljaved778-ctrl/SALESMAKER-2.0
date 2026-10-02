'use client';

import type { DataGridLabels, FieldEditorLabels, FieldValueLabels } from '@sm/ui';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

/** Every label the record components take, from the catalogue (golden rule 5). */
export function useRecordLabels() {
  const tf = useTranslations('records.field');
  const tg = useTranslations('records.grid');
  return useMemo(() => {
    const value: FieldValueLabels = {
      empty: tf('empty'),
      yes: tf('yes'),
      no: tf('no'),
      opensInNewTab: tf('opensInNewTab'),
    };
    const editor: FieldEditorLabels = {
      select: tf('select'),
      none: tf('none'),
      search: tf('search'),
      noResults: tf('noResults'),
      searching: tf('searching'),
    };
    const grid: DataGridLabels = {
      selectAll: tg('selectAll'),
      selectRow: (name) => tg('selectRow', { name }),
      sortAscending: tg('sortAscending'),
      sortDescending: tg('sortDescending'),
      clearSort: tg('clearSort'),
      columnMenu: (column) => tg('columnMenu', { column }),
      pinColumn: tg('pinColumn'),
      unpinColumn: tg('unpinColumn'),
      hideColumn: tg('hideColumn'),
      moveLeft: tg('moveLeft'),
      moveRight: tg('moveRight'),
      resizeColumn: (column) => tg('resizeColumn', { column }),
      expandGroup: (group) => tg('expandGroup', { group }),
      collapseGroup: (group) => tg('collapseGroup', { group }),
      loadMore: tg('loadMore'),
      loading: tg('loading'),
      rowActions: tg('rowActions'),
    };
    return { value, editor, grid, edit: (field: string) => tg('edit', { field }) };
  }, [tf, tg]);
}
