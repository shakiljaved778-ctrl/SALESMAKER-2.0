import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inbox, Lock, Phone, SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button, IconButton } from './button.js';
import {
  DataGrid,
  type DataGridColumn,
  type DataGridLabels,
  type DataGridLayout,
} from './data-grid.js';
import { Banner, EmptyState } from './feedback.js';
import { StatusChip } from './status-chip.js';

const meta: Meta = { title: 'Components/Data grid' };
export default meta;

const labels: DataGridLabels = {
  selectAll: 'Select all rows',
  selectRow: (r) => `Select ${r}`,
  sortAscending: 'Sort ascending',
  sortDescending: 'Sort descending',
  clearSort: 'Clear sort',
  columnMenu: (c) => `${c} column options`,
  pinColumn: 'Pin column',
  unpinColumn: 'Unpin column',
  hideColumn: 'Hide column',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  resizeColumn: (c) => `Resize ${c} column`,
  expandGroup: (g) => `Expand ${g}`,
  collapseGroup: (g) => `Collapse ${g}`,
  loadMore: 'Load more',
  loading: 'Loading leads',
  rowActions: 'Row actions',
};

interface Lead {
  id: string;
  name: string;
  company: string;
  owner: string;
  stage: 'New' | 'Working' | 'Qualified';
  amount: number;
  city: string;
}

const FIRST = ['Maya', 'Omar', 'Priya', 'Lina', 'Jonas', 'Diego', 'Sara', 'Yusuf', 'Hana', 'Tom'];
const LAST = [
  'Chen',
  'Haddad',
  'Nair',
  'Park',
  'Weber',
  'Santos',
  'Okafor',
  'Aziz',
  'Sato',
  'Reed',
];
const COMPANIES = ['Pixelcraft', 'Aurelia Bank', 'Gulf Trading', 'Northwind', 'Tyrell', 'Initech'];
const CITIES = ['Doha', 'Dubai', 'London', 'Lisbon', 'Riyadh', 'Berlin'];
const STAGES = ['New', 'Working', 'Qualified'] as const;

const makeLeads = (n: number): Lead[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    name: `${FIRST[i % 10] ?? ''} ${LAST[(i * 7) % 10] ?? ''}`,
    company: COMPANIES[i % 6] ?? '',
    owner: ['Lina Park', 'Jonas Weber', 'Priya Nair'][i % 3] ?? '',
    stage: STAGES[i % 3] ?? 'New',
    amount: ((i * 3779) % 90_000) + 1000,
    city: CITIES[(i * 5) % 6] ?? '',
  }));

const money = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const TONE = { New: 'neutral', Working: 'info', Qualified: 'success' } as const;

const columns: DataGridColumn<Lead>[] = [
  { id: 'name', header: 'Name', value: (r) => r.name, sortable: true, required: true, width: 180 },
  { id: 'company', header: 'Company', value: (r) => r.company, sortable: true },
  {
    id: 'stage',
    header: 'Status',
    value: (r) => r.stage,
    sortable: true,
    width: 130,
    cell: (r) => <StatusChip tone={TONE[r.stage]}>{r.stage}</StatusChip>,
  },
  { id: 'owner', header: 'Owner', value: (r) => r.owner, sortable: true },
  { id: 'city', header: 'City', value: (r) => r.city, width: 120 },
  {
    id: 'amount',
    header: 'Annual revenue',
    value: (r) => r.amount,
    sortable: true,
    align: 'end',
    width: 150,
    cell: (r) => money.format(r.amount),
    aggregate: (rows) => money.format(rows.reduce((s, r) => s + r.amount, 0)),
  },
];

const empty = (
  <EmptyState
    icon={<Inbox />}
    title="No leads yet"
    description="Import a spreadsheet or add your first lead to start working your pipeline."
    action={<Button>Import leads</Button>}
  />
);

/** Rows are generated inside the story so Storybook's source panel never serialises them. */
function Interactive({ count, grouped = false }: { count: number; grouped?: boolean }) {
  const rows = useMemo(() => makeLeads(count), [count]);
  const [selected, setSelected] = useState<Set<string>>(new Set(['2', '3']));
  const [layout, setLayout] = useState<DataGridLayout>({});
  return (
    <DataGrid<Lead>
      label="Leads"
      rows={rows}
      rowId={(r) => r.id}
      rowLabel={(r) => r.name}
      columns={columns}
      labels={labels}
      empty={empty}
      selected={selected}
      onSelectedChange={setSelected}
      layout={layout}
      onLayoutChange={setLayout}
      height={420}
      rowActions={(r) => (
        <IconButton label={`Call ${r.name}`} size="sm" variant="ghost">
          <Phone />
        </IconButton>
      )}
      {...(grouped ? { groupBy: (r: Lead) => r.stage, groupLabel: (k: string) => k } : {})}
      hasMore
      onLoadMore={() => undefined}
    />
  );
}

export const Default: StoryObj = { render: () => <Interactive count={24} /> };

export const Grouped: StoryObj = { render: () => <Interactive count={18} grouped /> };

export const Virtualised: StoryObj = {
  name: 'Virtualised (10,000 rows)',
  render: () => <Interactive count={10_000} />,
};

const stateProps = {
  label: 'Leads',
  rowId: (r: Lead) => r.id,
  rowLabel: (r: Lead) => r.name,
  columns,
  labels,
  empty,
  height: 260,
};

export const States: StoryObj = {
  render: () => (
    <div className="grid max-w-4xl gap-6">
      <DataGrid<Lead> {...stateProps} rows={[]} status="loading" />
      <DataGrid<Lead> {...stateProps} rows={[]} />
      <DataGrid<Lead>
        {...stateProps}
        rows={[]}
        filtered
        noResults={
          <EmptyState
            icon={<SearchX />}
            title="No leads match these filters"
            description="Clear a filter or search for another name."
            action={<Button variant="secondary">Clear filters</Button>}
          />
        }
      />
      <DataGrid<Lead>
        {...stateProps}
        rows={makeLeads(3)}
        status="error"
        error={
          <Banner
            tone="danger"
            title="Couldn’t load leads"
            action={
              <Button size="sm" variant="secondary">
                Try again
              </Button>
            }
          >
            Check your connection, then try again.
          </Banner>
        }
      />
      <DataGrid<Lead>
        {...stateProps}
        rows={makeLeads(3)}
        status="no-permission"
        noPermission={
          <EmptyState
            icon={<Lock />}
            title="You can’t see leads"
            description="Ask your administrator for access to leads."
          />
        }
      />
    </div>
  ),
};
