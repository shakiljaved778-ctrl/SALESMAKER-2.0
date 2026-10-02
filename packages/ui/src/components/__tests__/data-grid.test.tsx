// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  DataGrid,
  type DataGridColumn,
  type DataGridLabels,
  type DataGridLayout,
  type DataGridProps,
} from '../data-grid.js';

interface Lead {
  id: string;
  name: string;
  company: string;
  amount: number;
  stage: string;
}

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
  resizeColumn: (c) => `Resize ${c}`,
  expandGroup: (g) => `Expand ${g}`,
  collapseGroup: (g) => `Collapse ${g}`,
  loadMore: 'Load more',
  loading: 'Loading records',
  rowActions: 'Actions',
};

const rows: Lead[] = [
  { id: '1', name: 'Maya Chen', company: 'Pixelcraft', amount: 300, stage: 'open' },
  { id: '2', name: 'Omar Haddad', company: 'Gulf Trading', amount: 100, stage: 'won' },
  { id: '3', name: 'Priya Nair', company: 'Aurelia', amount: 200, stage: 'open' },
];

const columns: DataGridColumn<Lead>[] = [
  { id: 'name', header: 'Name', value: (r) => r.name, sortable: true, required: true },
  { id: 'company', header: 'Company', value: (r) => r.company, sortable: true },
  {
    id: 'amount',
    header: 'Amount',
    value: (r) => r.amount,
    sortable: true,
    align: 'end',
    editable: true,
    aggregate: (list) => list.reduce((s, r) => s + r.amount, 0),
  },
];

function grid(props: Partial<DataGridProps<Lead>> = {}) {
  return render(
    <DataGrid<Lead>
      label="Leads"
      rows={rows}
      rowId={(r) => r.id}
      rowLabel={(r) => r.name}
      columns={columns}
      labels={labels}
      empty={<p>No leads yet. Import your first leads.</p>}
      {...props}
    />,
  );
}

const names = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('gridcell')[0]?.textContent);

describe('DataGrid (§9.10)', () => {
  it('exposes ARIA grid semantics with row and column indices', () => {
    grid();
    const table = screen.getByRole('grid', { name: 'Leads' });
    expect(table).toHaveAttribute('aria-rowcount', '4');
    expect(table).toHaveAttribute('aria-colcount', '3');
    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['Name', 'Company', 'Amount']);
    expect(headers[1]).toHaveAttribute('aria-colindex', '2');
    expect(screen.getAllByRole('row')[2]).toHaveAttribute('aria-rowindex', '3');
    // One cell is in the tab order (roving focus).
    expect(table.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('sorts on header click, multi-sorts with shift', async () => {
    const user = userEvent.setup();
    grid();
    await user.click(screen.getByRole('button', { name: 'Amount' }));
    expect(names()).toEqual(['Omar Haddad', 'Priya Nair', 'Maya Chen']);
    expect(screen.getAllByRole('columnheader')[2]).toHaveAttribute('aria-sort', 'ascending');
    await user.click(screen.getByRole('button', { name: 'Amount' }));
    expect(names()).toEqual(['Maya Chen', 'Priya Nair', 'Omar Haddad']);
    fireEvent.click(screen.getByRole('button', { name: 'Company' }), { shiftKey: true });
    expect(screen.getAllByRole('columnheader')[1]).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getAllByRole('columnheader')[2]).toHaveAttribute('aria-sort', 'descending');
  });

  it('leaves sorting to the server when told to', async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn();
    grid({ sorting: [], onSortingChange });
    await user.click(screen.getByRole('button', { name: 'Amount' }));
    expect(onSortingChange).toHaveBeenCalledWith([{ id: 'amount', desc: false }]);
    expect(names()).toEqual(['Maya Chen', 'Omar Haddad', 'Priya Nair']);
  });

  it('moves through cells with the keyboard and opens a row with Enter', async () => {
    const user = userEvent.setup();
    const onRowOpen = vi.fn();
    grid({ onRowOpen });
    const first = screen.getAllByRole('columnheader')[0];
    first?.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveTextContent('Maya Chen');
    await user.keyboard('{ArrowDown}{End}');
    expect(document.activeElement).toHaveTextContent('100');
    await user.keyboard('{Home}');
    expect(document.activeElement).toHaveTextContent('Omar Haddad');
    await user.keyboard('{Enter}');
    expect(onRowOpen).toHaveBeenCalledWith(rows[1]);
    await user.keyboard('{Control>}{End}{/Control}');
    expect(document.activeElement).toHaveTextContent('200');
    await user.keyboard('{PageUp}');
    expect(document.activeElement).toHaveTextContent('Amount');
    await user.keyboard('{Enter}');
    expect(screen.getAllByRole('columnheader')[2]).toHaveAttribute('aria-sort', 'ascending');
  });

  it('mirrors arrow keys in RTL layouts', async () => {
    const user = userEvent.setup();
    grid({ dir: 'rtl' });
    screen.getAllByRole('columnheader')[0]?.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toHaveTextContent('Company');
  });

  it('selects rows with checkboxes, Space and shift-click ranges', async () => {
    const user = userEvent.setup();
    function Selectable() {
      const [selected, setSelected] = useState<Set<string>>(new Set());
      return (
        <>
          <DataGrid<Lead>
            label="Leads"
            rows={rows}
            rowId={(r) => r.id}
            rowLabel={(r) => r.name}
            columns={columns}
            labels={labels}
            empty={null}
            selected={selected}
            onSelectedChange={setSelected}
          />
          <output>{[...selected].sort().join(',')}</output>
        </>
      );
    }
    render(<Selectable />);
    expect(screen.getByRole('grid')).toHaveAttribute('aria-multiselectable', 'true');
    await user.click(screen.getByRole('checkbox', { name: 'Select Maya Chen' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Priya Nair' }), {
      shiftKey: true,
    });
    expect(screen.getByRole('status')).toHaveTextContent('1,2,3');
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(screen.getByRole('status')).toHaveTextContent('');
    screen.getAllByRole('gridcell')[1]?.focus();
    await user.keyboard(' ');
    expect(screen.getByRole('status')).toHaveTextContent('1');
  });

  it('edits a cell inline with Enter, saving or cancelling', async () => {
    const user = userEvent.setup();
    const onCellEdit = vi.fn();
    grid({
      onCellEdit,
      renderEditor: (_row, _col, done) => (
        <input
          aria-label="Amount editor"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') done(Number(e.currentTarget.value));
          }}
        />
      ),
    });
    const amount = screen.getAllByRole('gridcell').find((c) => c.textContent === '300');
    amount?.focus();
    await user.keyboard('{Enter}');
    await user.type(screen.getByRole('textbox', { name: 'Amount editor' }), '450{Enter}');
    expect(onCellEdit).toHaveBeenCalledWith(rows[0], columns[2], 450);
    expect(screen.queryByRole('textbox')).toBeNull();
    amount?.focus();
    await user.keyboard('{Enter}{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onCellEdit).toHaveBeenCalledTimes(1);
  });

  it('groups rows under collapsible headers with aggregates', async () => {
    const user = userEvent.setup();
    grid({ groupBy: (r) => r.stage, groupLabel: (k) => (k === 'open' ? 'Open' : 'Won') });
    const open = screen.getAllByRole('row').find((r) => r.hasAttribute('data-group'));
    expect(open).toHaveTextContent('Open2Amount: 500');
    await user.click(screen.getByRole('button', { name: 'Collapse Open' }));
    expect(screen.queryByText('Maya Chen')).toBeNull();
    expect(screen.getByText('Omar Haddad')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand Open' }));
    expect(screen.getByText('Maya Chen')).toBeInTheDocument();
  });

  it('applies the column layout: order, hidden and pinned (sticky) columns', async () => {
    const user = userEvent.setup();
    function Layout() {
      const [layout, setLayout] = useState<DataGridLayout>({
        order: ['amount', 'name', 'company'],
        pinned: ['name'],
      });
      return (
        <DataGrid<Lead>
          label="Leads"
          rows={rows}
          rowId={(r) => r.id}
          rowLabel={(r) => r.name}
          columns={columns}
          labels={labels}
          empty={null}
          layout={layout}
          onLayoutChange={setLayout}
        />
      );
    }
    render(<Layout />);
    const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers()).toEqual(['Amount', 'Name', 'Company']);
    expect(screen.getAllByRole('columnheader')[1]?.style.insetInlineStart).toBe('160px');
    await user.click(screen.getByRole('button', { name: 'Company column options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide column' }));
    expect(headers()).toEqual(['Amount', 'Name']);
    await user.click(screen.getByRole('button', { name: 'Amount column options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move right' }));
    expect(headers()).toEqual(['Name', 'Amount']);
    // Required columns cannot be hidden.
    await user.click(screen.getByRole('button', { name: 'Name column options' }));
    expect(screen.queryByRole('menuitem', { name: 'Hide column' })).toBeNull();
  });

  it('resizes columns from the keyboard', () => {
    const onLayoutChange = vi.fn();
    grid({ layout: {}, onLayoutChange });
    const handle = screen.getByRole('separator', { name: 'Resize Company' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onLayoutChange).toHaveBeenCalledWith({ sizes: { company: 176 } });
  });

  it('shows loading, empty, no-results, error and no-permission states', () => {
    const { rerender } = grid({ status: 'loading' });
    expect(screen.getByRole('region', { name: 'Leads' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading records')).toBeInTheDocument();
    const props = {
      label: 'Leads',
      rowId: (r: Lead) => r.id,
      rowLabel: (r: Lead) => r.name,
      columns,
      labels,
      empty: <p>No leads yet</p>,
      noResults: <p>No leads match these filters</p>,
      error: <p>Couldn’t load leads</p>,
      noPermission: <p>You can’t see leads</p>,
    };
    rerender(<DataGrid<Lead> {...props} rows={[]} />);
    expect(screen.getByText('No leads yet')).toBeInTheDocument();
    rerender(<DataGrid<Lead> {...props} rows={[]} filtered />);
    expect(screen.getByText('No leads match these filters')).toBeInTheDocument();
    rerender(<DataGrid<Lead> {...props} rows={rows} status="error" />);
    expect(screen.getByText('Couldn’t load leads')).toBeInTheDocument();
    expect(screen.queryByRole('grid')).toBeNull();
    rerender(<DataGrid<Lead> {...props} rows={rows} status="no-permission" />);
    expect(screen.getByText('You can’t see leads')).toBeInTheDocument();
  });

  it('virtualises long lists and loads more on request', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 10_000 }, (_, i) => ({
      id: String(i),
      name: `Lead ${String(i)}`,
      company: 'Co',
      amount: i,
      stage: 'open',
    }));
    const onLoadMore = vi.fn();
    grid({ rows: many, hasMore: true, onLoadMore, height: 640 });
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '10001');
    const rendered = screen.getAllByRole('row').length;
    expect(rendered).toBeLessThan(100);
    expect(rendered).toBeGreaterThan(10);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('shows row actions and opens rows on double-click', async () => {
    const user = userEvent.setup();
    const onRowOpen = vi.fn();
    grid({ onRowOpen, rowActions: (r) => <button type="button">Call {r.name}</button> });
    expect(screen.getByRole('button', { name: 'Call Maya Chen' })).toBeInTheDocument();
    await user.dblClick(screen.getByText('Priya Nair'));
    expect(onRowOpen).toHaveBeenCalledWith(rows[2]);
  });
});
