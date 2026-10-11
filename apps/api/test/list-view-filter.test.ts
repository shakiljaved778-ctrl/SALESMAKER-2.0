import type { FilterNode } from '@sm/query-engine';
import { describe, expect, it } from 'vitest';

import { pruneFilter } from '../src/records/list-views.service.js';

const hidden = new Set(['title', 'email']);
const readable = (path: string) => !hidden.has(path.split('.')[0] ?? '');
const company: FilterNode = { field: 'company', op: 'eq', value: 'Aurelia Bank' };
const title: FilterNode = { field: 'title', op: 'eq', value: 'CTO' };
const email: FilterNode = { field: 'email', op: 'is_null' };

describe('pruneFilter (saved view filters on hidden fields)', () => {
  it('drops hidden conditions and collapses what is left', () => {
    expect(pruneFilter({ and: [company, title] }, readable)).toEqual(company);
    expect(pruneFilter({ or: [title, email] }, readable)).toBeUndefined();
    expect(pruneFilter({ not: title }, readable)).toBeUndefined();
    expect(pruneFilter({ and: [company, { or: [title, company] }] }, readable)).toEqual({
      and: [company, company],
    });
    expect(pruneFilter({ not: { and: [company, email] } }, readable)).toEqual({ not: company });
  });

  it('keeps a filter whose fields are all readable, and lookup paths by their first field', () => {
    const node: FilterNode = {
      or: [company, { field: 'owner_id.name', op: 'contains', value: 'a' }],
    };
    expect(pruneFilter(node, readable)).toEqual(node);
    expect(pruneFilter({ field: 'title.x', op: 'is_null' }, readable)).toBeUndefined();
  });
});
