import type { Meta, StoryObj } from '@storybook/react-vite';
import { Building2, Copy, Pencil, Share2, Trash2, UserRound, Users } from 'lucide-react';
import { useState } from 'react';

import { Button } from './button.js';
import { FieldEditor, type FieldEditorLabels, type FieldEditorValue } from './field-editor.js';
import {
  FieldValue,
  type FieldType,
  type FieldValueLabels,
  type LookupValue,
} from './field-value.js';
import { Banner, EmptyState } from './feedback.js';
import { FormField } from './form-field.js';
import { HighlightsPanel } from './highlights-panel.js';
import { Path, type PathLabels, type PathStage } from './path.js';
import { FormSection, FormSpan, RecordForm } from './record-form.js';
import { RelatedList } from './related-list.js';
import { StatusChip } from './status-chip.js';

const meta: Meta = { title: 'Components/Record' };
export default meta;

/** Fixed so relative dates in the screenshots never drift. */
const NOW = new Date('2026-10-02T12:00:00Z');
const valueLabels: FieldValueLabels = {
  empty: '—',
  yes: 'Yes',
  no: 'No',
  opensInNewTab: '(opens in a new tab)',
};
const editorLabels: FieldEditorLabels = {
  select: 'Select an option',
  none: '--None--',
  search: 'Search accounts…',
  noResults: 'No accounts match',
  searching: 'Searching…',
};
const aurelia: LookupValue = { id: 'a1', name: 'Aurelia Bank', object: 'account' };
const ratings = [
  { value: 'hot', label: 'Hot', tone: 'danger' as const },
  { value: 'warm', label: 'Warm', tone: 'warning' as const },
  { value: 'cold', label: 'Cold', tone: 'info' as const },
];
const products = [
  { value: 'crm', label: 'CRM' },
  { value: 'telesales', label: 'Telesales' },
  { value: 'analytics', label: 'Analytics' },
];

const samples: { label: string; type: FieldType; value: unknown }[] = [
  { label: 'Account name', type: 'text', value: 'Aurelia Bank — Doha' },
  { label: 'Amount', type: 'currency', value: '1250000.50' },
  { label: 'Probability', type: 'percent', value: '60' },
  { label: 'Employees', type: 'number', value: '4200' },
  { label: 'Close date', type: 'date', value: '2026-10-05' },
  { label: 'Next step due', type: 'date', value: '2026-12-15' },
  { label: 'Last activity', type: 'datetime', value: '2026-10-02T09:00:00Z' },
  { label: 'Rating', type: 'picklist', value: 'hot' },
  { label: 'Products', type: 'multi_picklist', value: ['crm', 'analytics'] },
  { label: 'Account', type: 'lookup', value: aurelia },
  { label: 'Phone', type: 'phone', value: '+974 4400 1234' },
  { label: 'Email', type: 'email', value: 'omar.haddad@aurelia.example' },
  { label: 'Website', type: 'url', value: 'https://aurelia.example' },
  { label: 'Do not call', type: 'checkbox', value: true },
  { label: 'Fax', type: 'phone', value: null },
  {
    label: 'Description',
    type: 'long_text',
    value: 'Regional bank, 40 branches.\nEvaluating a CRM for relationship managers.',
  },
];

export const FieldValues: StoryObj = {
  render: () => (
    <dl className="grid max-w-2xl grid-cols-[12rem_1fr] gap-x-6 gap-y-3 rounded-md border border-line bg-surface p-4">
      {samples.map((s) => (
        <div key={s.label} className="contents">
          <dt className="text-label text-fg-secondary">{s.label}</dt>
          <dd>
            <FieldValue
              type={s.type}
              value={s.value}
              labels={valueLabels}
              locale="en"
              timeZone="UTC"
              currencyCode="QAR"
              now={NOW}
              options={s.type === 'multi_picklist' ? products : ratings}
              lookupHref={(v) => `#/o/${v.object}/${v.id}`}
              lookupIcon={() => <Building2 />}
              lookupCard={(v) => (
                <div className="grid gap-1 text-body-sm">
                  <p className="text-body-strong text-fg">{v.name}</p>
                  <p className="text-fg-secondary">Banking · Doha</p>
                </div>
              )}
            />
          </dd>
        </div>
      ))}
    </dl>
  ),
};

function EditorsDemo() {
  const [values, setValues] = useState<Record<string, FieldEditorValue>>({
    name: 'Aurelia Bank — Doha',
    amount: '1250000.50',
    probability: '60',
    close: '2026-10-05',
    rating: 'hot',
    products: ['crm'],
    account: aurelia,
    phone: '+974 4400 1234',
    email: 'omar.haddad@aurelia.example',
    dnc: false,
    description: '',
  });
  const set = (k: string) => (v: FieldEditorValue) => {
    setValues((s) => ({ ...s, [k]: v }));
  };
  const field = (
    k: string,
    label: string,
    type: FieldType,
    extra: { required?: boolean; error?: string; helper?: string } = {},
  ) => (
    <FormField label={label} {...extra}>
      <FieldEditor
        type={type}
        value={values[k]}
        onChange={set(k)}
        labels={editorLabels}
        currencyCode="QAR"
        options={type === 'multi_picklist' ? products : ratings}
        lookup={{
          results: [aurelia, { id: 'a2', name: 'Gulf Trading', object: 'account' }],
          onSearch: () => undefined,
          describe: () => 'Doha',
          icon: () => <Building2 />,
        }}
        maxLength={type === 'long_text' ? 500 : undefined}
      />
    </FormField>
  );
  return (
    <div className="max-w-3xl rounded-md border border-line bg-surface p-4">
      <RecordForm
        aria-label="Edit opportunity"
        onSubmit={() => undefined}
        errors={
          <Banner tone="danger" title="Review the errors on this page">
            Close date can’t be in the past for open opportunities.
          </Banner>
        }
        footer={
          <>
            <Button variant="secondary">Cancel</Button>
            <Button variant="primary" type="submit">
              Save
            </Button>
          </>
        }
      >
        <FormSection title="Opportunity information">
          {field('name', 'Opportunity name', 'text', { required: true })}
          {field('account', 'Account name', 'lookup', { required: true })}
          {field('amount', 'Amount', 'currency')}
          {field('probability', 'Probability', 'percent', {
            helper: 'Set by stage; you can override it.',
          })}
          {field('close', 'Close date', 'date', {
            required: true,
            error: 'Close date can’t be in the past.',
          })}
          {field('rating', 'Rating', 'picklist')}
        </FormSection>
        <FormSection title="Contact details">
          {field('phone', 'Phone', 'phone')}
          {field('email', 'Email', 'email')}
          {field('products', 'Products', 'multi_picklist')}
          {field('dnc', 'Do not call', 'checkbox')}
          <FormSpan>{field('description', 'Description', 'long_text')}</FormSpan>
        </FormSection>
      </RecordForm>
    </div>
  );
}

export const FieldEditors: StoryObj = { render: () => <EditorsDemo /> };

export const Highlights: StoryObj = {
  render: () => (
    <div className="max-w-5xl">
      <HighlightsPanel
        icon={<Building2 />}
        objectLabel="Opportunity"
        title="Aurelia Bank — CRM rollout"
        badge={<StatusChip tone="info">Commit</StatusChip>}
        moreActionsLabel="More actions"
        follow={<Button variant="secondary">Follow</Button>}
        owner={{ name: 'Lina Park', label: 'Opportunity owner' }}
        fields={[
          {
            label: 'Account name',
            value: (
              <a className="text-link" href="#a">
                Aurelia Bank
              </a>
            ),
          },
          {
            label: 'Amount',
            value: (
              <FieldValue
                type="currency"
                value="1250000"
                currencyCode="QAR"
                locale="en"
                labels={valueLabels}
              />
            ),
          },
          {
            label: 'Close date',
            value: (
              <FieldValue
                type="date"
                value="2026-10-05"
                locale="en"
                timeZone="UTC"
                now={NOW}
                labels={valueLabels}
              />
            ),
          },
          { label: 'Stage', value: 'Qualification' },
        ]}
        actions={[
          { label: 'Edit', icon: <Pencil />, onSelect: () => undefined, primary: true },
          { label: 'Clone', icon: <Copy />, onSelect: () => undefined },
          { label: 'Share', icon: <Share2 />, onSelect: () => undefined },
          { label: 'Change owner', icon: <UserRound />, onSelect: () => undefined },
          { label: 'Delete', icon: <Trash2 />, onSelect: () => undefined, destructive: true },
        ]}
      />
    </div>
  ),
};

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
    keyFields: [
      { label: 'Budget confirmed', value: 'Yes' },
      { label: 'Decision maker', value: 'Omar Haddad' },
    ],
    guidance: (
      <ul className="list-disc ps-4">
        <li>Confirm budget and timeline with the decision maker.</li>
        <li>Identify the competing vendors.</li>
      </ul>
    ),
  },
  { value: 'needs', label: 'Needs analysis' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'closed', label: 'Closed' },
];

function PathDemo() {
  const [current, setCurrent] = useState('qualification');
  return (
    <div className="grid max-w-5xl gap-4">
      <Path
        stages={stages}
        current={current}
        labels={pathLabels}
        defaultGuidanceOpen
        onMarkComplete={() => {
          const i = stages.findIndex((s) => s.value === current);
          setCurrent(stages[i + 1]?.value ?? current);
        }}
        onMarkCurrent={setCurrent}
      />
      <Path stages={stages} current="closed" labels={pathLabels} />
    </div>
  );
}

export const StagePath: StoryObj = { name: 'Path', render: () => <PathDemo /> };

const contactsEmpty = (
  <EmptyState
    icon={<Users />}
    title="No contacts yet"
    description="Add the people you work with at this account to track every conversation."
    action={<Button>New contact</Button>}
  />
);

export const RelatedLists: StoryObj = {
  render: () => (
    <div className="grid max-w-3xl gap-4">
      <RelatedList
        title="Contacts"
        icon={<Users />}
        count={12}
        countLabel={(n) => `${String(n)} contacts`}
        empty={contactsEmpty}
        newLabel="New"
        onNew={() => undefined}
        viewAll={{ label: 'View all', href: '#all' }}
        rows={[
          {
            id: 'c1',
            title: 'Omar Haddad',
            href: '#c1',
            fields: [
              { label: 'Title', value: 'Chief Financial Officer' },
              {
                label: 'Email',
                value: (
                  <FieldValue
                    type="email"
                    value="omar.haddad@aurelia.example"
                    labels={valueLabels}
                  />
                ),
              },
            ],
          },
          {
            id: 'c2',
            title: 'Priya Nair',
            href: '#c2',
            fields: [
              { label: 'Title', value: 'Head of Retail' },
              {
                label: 'Phone',
                value: <FieldValue type="phone" value="+974 4400 2210" labels={valueLabels} />,
              },
            ],
          },
        ]}
      />
      <RelatedList
        title="Contacts"
        icon={<Users />}
        rows={[]}
        empty={contactsEmpty}
        newLabel="New"
        onNew={() => undefined}
      />
      <RelatedList title="Opportunities" rows={[]} empty={contactsEmpty} status="loading" />
      <RelatedList
        title="Cases"
        rows={[]}
        empty={contactsEmpty}
        status="error"
        error={
          <Banner tone="danger" title="Couldn’t load cases">
            Check your connection, then try again.
          </Banner>
        }
      />
    </div>
  ),
};
