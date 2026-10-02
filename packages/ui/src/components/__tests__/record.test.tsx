// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  FieldEditor,
  type FieldEditorLabels,
  type FieldEditorProps,
  type FieldEditorValue,
} from '../field-editor.js';
import { FieldValue, formatDate, formatNumber, type FieldValueLabels } from '../field-value.js';
import { FormField } from '../form-field.js';
import { HighlightsPanel } from '../highlights-panel.js';
import { Path, type PathLabels, type PathStage } from '../path.js';
import { FormSection, RecordForm } from '../record-form.js';
import { RelatedList } from '../related-list.js';

const valueLabels: FieldValueLabels = {
  empty: '—',
  yes: 'Yes',
  no: 'No',
  opensInNewTab: '(opens in a new tab)',
};
const now = new Date('2026-10-02T12:00:00Z');

describe('formatNumber', () => {
  it('formats money from its decimal string without a float round trip', () => {
    expect(
      formatNumber('currency', '12345678901234.57', { locale: 'en', currencyCode: 'USD' }),
    ).toBe('$12,345,678,901,234.57');
    expect(formatNumber('currency', '1000', { locale: 'de', currencyCode: 'EUR', scale: 2 })).toBe(
      '1.000,00\u00a0€',
    );
  });

  it('treats percent values as the percentage itself and rejects non-numbers', () => {
    expect(formatNumber('percent', '12.5', { locale: 'en' })).toBe('12.5%');
    expect(formatNumber('number', 'abc', { locale: 'en' })).toBeNull();
    expect(formatNumber('number', 4200, { locale: 'en' })).toBe('4,200');
  });
});

describe('formatDate', () => {
  it('shows dates within a week relatively, with the absolute form kept', () => {
    const d = formatDate('date', '2026-10-05', { locale: 'en', now, timeZone: 'UTC' });
    expect(d).toMatchObject({ text: 'in 3 days', absolute: 'Oct 5, 2026', relative: true });
    expect(formatDate('date', '2026-10-02', { locale: 'en', now, timeZone: 'UTC' })?.text).toBe(
      'today',
    );
    expect(formatDate('date', '2026-12-25', { locale: 'en', now })?.text).toBe('Dec 25, 2026');
  });

  it('never shifts a business date with the viewer zone', () => {
    // 23:00 on 1 Oct in Los Angeles is already 2 Oct in UTC: "today" follows the viewer's calendar.
    const lateLa = new Date('2026-10-02T06:00:00Z');
    const opts = { locale: 'en', now: lateLa, timeZone: 'America/Los_Angeles' };
    expect(formatDate('date', '2026-10-01', opts)?.text).toBe('today');
    expect(formatDate('date', '2026-10-01', opts)?.absolute).toBe('Oct 1, 2026');
  });

  it('shows date-times as minutes, hours or days ago', () => {
    const opts = { locale: 'en', now, timeZone: 'UTC' };
    expect(formatDate('datetime', '2026-10-02T11:45:00Z', opts)?.text).toBe('15 min. ago');
    expect(formatDate('datetime', '2026-10-02T09:00:00Z', opts)?.text).toBe('3 hr. ago');
    expect(formatDate('datetime', '2026-09-29T12:00:00Z', opts)?.text).toBe('3 days ago');
    expect(formatDate('datetime', '2026-08-01T12:00:00Z', opts)).toMatchObject({
      relative: false,
      text: 'Aug 1, 2026, 12:00 PM',
    });
    expect(formatDate('datetime', 'nope', opts)).toBeNull();
  });
});

describe('FieldValue', () => {
  const show = (props: Partial<Parameters<typeof FieldValue>[0]>) =>
    render(
      <FieldValue type="text" value={null} labels={valueLabels} locale="en" now={now} {...props} />,
    );

  it('renders an empty value as the empty label', () => {
    show({ type: 'currency', value: null });
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('links phone, email and URL values', () => {
    show({ type: 'phone', value: '+974 4400 1234' });
    expect(screen.getByRole('link').getAttribute('href')).toBe('tel:+97444001234');
    show({ type: 'email', value: 'maya@pixelcraft.example' });
    expect(screen.getByRole('link', { name: 'maya@pixelcraft.example' }).getAttribute('href')).toBe(
      'mailto:maya@pixelcraft.example',
    );
    show({ type: 'url', value: 'pixelcraft.example/about' });
    const url = screen.getByRole('link', { name: /pixelcraft.example\/about.*new tab/ });
    expect(url.getAttribute('href')).toBe('https://pixelcraft.example/about');
    expect(url.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders picklists with their label and checkboxes as words, never colour alone', () => {
    show({
      type: 'multi_picklist',
      value: ['b', 'a'],
      options: [
        { value: 'a', label: 'Alpha', tone: 'success' },
        { value: 'b', label: 'Beta' },
      ],
    });
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    show({ type: 'checkbox', value: false });
    expect(screen.getByText('No')).toBeTruthy();
  });

  it('renders a lookup as a chip linking to the record', () => {
    show({
      type: 'lookup',
      value: { id: 'a1', name: 'Aurelia Bank', object: 'account' },
      lookupHref: (v) => `/o/${v.object}/${v.id}`,
    });
    expect(screen.getByRole('link', { name: 'Aurelia Bank' }).getAttribute('href')).toBe(
      '/o/account/a1',
    );
  });

  it('marks up dates with a machine-readable time', () => {
    const { container } = show({ type: 'date', value: '2026-10-01', timeZone: 'UTC' });
    expect(screen.getByText('yesterday')).toBeTruthy();
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-01');
  });
});

const editorLabels: FieldEditorLabels = {
  select: 'Select an option',
  none: '--None--',
  search: 'Search…',
  noResults: 'No matches',
  searching: 'Searching…',
};

function Editor(props: Partial<FieldEditorProps> & { onValue?: (v: FieldEditorValue) => void }) {
  const { onValue, ...rest } = props;
  const [value, setValue] = useState<FieldEditorValue | undefined>(props.value);
  return (
    <FormField label="Field">
      <FieldEditor
        type="text"
        labels={editorLabels}
        {...rest}
        value={value}
        onChange={(v) => {
          setValue(v);
          onValue?.(v);
        }}
      />
    </FormField>
  );
}

describe('FieldEditor', () => {
  it('accepts only a plain decimal for money and emits it as a string', async () => {
    const onValue = vi.fn();
    render(<Editor type="currency" currencyCode="USD" onValue={onValue} />);
    const input = screen.getByLabelText('Field');
    await userEvent.type(input, '12a.5x0');
    expect((input as HTMLInputElement).value).toBe('12.50');
    expect(onValue).toHaveBeenLastCalledWith('12.50');
    expect(screen.getByText('USD')).toBeTruthy();
    await userEvent.clear(input);
    expect(onValue).toHaveBeenLastCalledWith(null);
  });

  it('emits date-times as UTC ISO strings', () => {
    const onValue = vi.fn();
    render(<Editor type="datetime" onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: '2026-10-02T09:30' } });
    expect(onValue).toHaveBeenLastCalledWith(new Date('2026-10-02T09:30').toISOString());
  });

  it('keeps multi-picklist values in option order and labels the group by the field', async () => {
    const onValue = vi.fn();
    render(
      <Editor
        type="multi_picklist"
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ]}
        onValue={onValue}
      />,
    );
    expect(screen.getByRole('group', { name: 'Field' })).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
    expect(onValue).toHaveBeenLastCalledWith(['a', 'b']);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
    expect(onValue).toHaveBeenLastCalledWith(null);
  });

  it('toggles a checkbox to a boolean', async () => {
    const onValue = vi.fn();
    render(<Editor type="checkbox" value={false} onValue={onValue} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Field' }));
    expect(onValue).toHaveBeenLastCalledWith(true);
  });

  it('searches lookups and emits the chosen record, keeping the current one listed', async () => {
    const onValue = vi.fn();
    const onSearch = vi.fn();
    const current = { id: 'a1', name: 'Aurelia Bank', object: 'account' };
    render(
      <Editor
        type="lookup"
        value={current}
        lookup={{
          results: [{ id: 'a2', name: 'Gulf Trading', object: 'account' }],
          onSearch,
        }}
        onValue={onValue}
      />,
    );
    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent).toContain('Aurelia Bank');
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: /Gulf Trading/ }));
    expect(onValue).toHaveBeenLastCalledWith({ id: 'a2', name: 'Gulf Trading', object: 'account' });
  });

  it('uses the inline aria-label outside a form field', () => {
    render(
      <FieldEditor
        type="email"
        value="a@b.example"
        onChange={() => undefined}
        labels={editorLabels}
        aria-label="Email"
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Email' });
    expect(input.getAttribute('type')).toBe('email');
    expect(input.getAttribute('dir')).toBe('ltr');
  });
});

describe('HighlightsPanel', () => {
  it('shows three actions and moves the rest, destructive last, to the overflow menu', async () => {
    const onDelete = vi.fn();
    render(
      <HighlightsPanel
        icon={<span />}
        objectLabel="Opportunity"
        title="Aurelia renewal"
        fields={[{ label: 'Amount', value: '$120,000' }]}
        owner={{ name: 'Lina Park', label: 'Owner' }}
        moreActionsLabel="More actions"
        actions={[
          { label: 'Delete', onSelect: onDelete, destructive: true },
          { label: 'Edit', onSelect: vi.fn(), primary: true },
          { label: 'Clone', onSelect: vi.fn() },
          { label: 'Share', onSelect: vi.fn() },
          { label: 'Change owner', onSelect: vi.fn() },
        ]}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Aurelia renewal' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change owner' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByText('Lina Park')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Change owner', 'Delete']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalled();
  });
});

const pathLabels: PathLabels = {
  path: 'Opportunity stage',
  completed: 'completed',
  current: 'current stage',
  markComplete: 'Mark stage as complete',
  markCurrent: 'Mark as current stage',
  showGuidance: 'Show guidance',
  hideGuidance: 'Hide guidance',
  keyFields: 'Key fields',
  guidance: 'Guidance for success',
  saving: 'Saving…',
};
const stages: PathStage[] = [
  { value: 'prospecting', label: 'Prospecting' },
  {
    value: 'qualification',
    label: 'Qualification',
    keyFields: [{ label: 'Budget', value: '$120,000' }],
    guidance: 'Confirm budget and decision maker.',
  },
  { value: 'proposal', label: 'Proposal', guidance: 'Send the proposal within 3 days.' },
  { value: 'closed', label: 'Closed' },
];

describe('Path', () => {
  it('marks completed and current stages for assistive tech', () => {
    render(<Path stages={stages} current="qualification" labels={pathLabels} />);
    const list = screen.getByRole('list', { name: 'Opportunity stage' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons[0]?.getAttribute('data-state')).toBe('completed');
    expect(buttons[0]?.textContent).toContain('completed');
    expect(buttons[1]?.getAttribute('aria-current')).toBe('step');
    expect(buttons[2]?.getAttribute('data-state')).toBe('future');
    expect(screen.queryByRole('button', { name: 'Mark stage as complete' })).toBeNull();
  });

  it('marks the current stage complete, or moves to a selected stage', async () => {
    const onMarkComplete = vi.fn();
    const onMarkCurrent = vi.fn();
    render(
      <Path
        stages={stages}
        current="qualification"
        labels={pathLabels}
        onMarkComplete={onMarkComplete}
        onMarkCurrent={onMarkCurrent}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Mark stage as complete' }));
    expect(onMarkComplete).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: /^Proposal/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Mark as current stage' }));
    expect(onMarkCurrent).toHaveBeenCalledWith('proposal');
  });

  it('opens the guidance drawer for the selected stage', async () => {
    render(<Path stages={stages} current="qualification" labels={pathLabels} />);
    const toggle = screen.getByRole('button', { name: 'Show guidance' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    expect(screen.getByText('Confirm budget and decision maker.')).toBeTruthy();
    expect(screen.getByText('Budget')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^Proposal/ }));
    expect(screen.getByText('Send the proposal within 3 days.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Hide guidance' }));
    expect(screen.queryByText('Send the proposal within 3 days.')).toBeNull();
  });

  it('follows the current stage when it changes', async () => {
    const { rerender } = render(
      <Path
        stages={stages}
        current="qualification"
        labels={pathLabels}
        onMarkComplete={vi.fn()}
        onMarkCurrent={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^Proposal/ }));
    rerender(
      <Path
        stages={stages}
        current="proposal"
        labels={pathLabels}
        onMarkComplete={vi.fn()}
        onMarkCurrent={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Mark stage as complete' })).toBeTruthy();
  });

  it('offers no completion on the last stage', () => {
    render(<Path stages={stages} current="closed" labels={pathLabels} onMarkComplete={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Mark stage as complete' })).toBeNull();
  });
});

describe('RelatedList', () => {
  const base = {
    title: 'Contacts',
    empty: <p>Add the people you work with.</p>,
    countLabel: (n: number) => `${String(n)} contacts`,
  };

  it('shows the count, rows, New and View all', async () => {
    const onNew = vi.fn();
    render(
      <RelatedList
        {...base}
        count={12}
        rows={[
          {
            id: 'c1',
            title: 'Omar Haddad',
            href: '/o/contact/c1',
            fields: [{ label: 'Title', value: 'CFO' }],
          },
        ]}
        newLabel="New"
        onNew={onNew}
        viewAll={{ label: 'View all', href: '/o/account/a1/related/contacts' }}
      />,
    );
    const section = screen.getByRole('region', { name: 'Contacts' });
    expect(within(section).getByText('12 contacts')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Omar Haddad' }).getAttribute('href')).toBe(
      '/o/contact/c1',
    );
    expect(screen.getByText('CFO')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View all' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(onNew).toHaveBeenCalled();
  });

  it('renders empty, loading, error and no-permission states', () => {
    const { rerender, container } = render(<RelatedList {...base} rows={[]} />);
    expect(screen.getByText('Add the people you work with.')).toBeTruthy();
    expect(screen.getByText('0 contacts')).toBeTruthy();
    rerender(<RelatedList {...base} rows={[]} status="loading" />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    rerender(<RelatedList {...base} rows={[]} status="error" error={<p>Couldn’t load</p>} />);
    expect(screen.getByText('Couldn’t load')).toBeTruthy();
    rerender(
      <RelatedList {...base} rows={[]} status="no-permission" noPermission={<p>No access</p>} />,
    );
    expect(screen.getByText('No access')).toBeTruthy();
    expect(screen.queryByText('0 contacts')).toBeNull();
  });
});

describe('RecordForm', () => {
  it('submits without a page reload and groups fields under a section legend', () => {
    const onSubmit = vi.fn();
    render(
      <RecordForm aria-label="New lead" onSubmit={onSubmit} footer={<button>Save</button>}>
        <FormSection title="Lead information">
          <FormField label="Last name" required>
            <input />
          </FormField>
        </FormSection>
      </RecordForm>,
    );
    expect(screen.getByRole('group', { name: 'Lead information' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
