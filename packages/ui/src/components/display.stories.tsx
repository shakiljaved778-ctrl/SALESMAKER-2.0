import type { Meta, StoryObj } from '@storybook/react-vite';
import { Building2, MoreHorizontal, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Avatar } from './avatar.js';
import { IconButton } from './button.js';
import { Combobox } from './combobox.js';
import { FormField } from './form-field.js';
import { Card, Kbd, Separator } from './primitives.js';
import { Select } from './select.js';
import { StatusChip } from './status-chip.js';

const meta: Meta = { title: 'Components/Selection and display' };
export default meta;

const stages = [
  { value: 'discovery', label: 'Discovery' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'won', label: 'Closed won' },
  { value: 'lost', label: 'Closed lost', disabled: true },
];

const accounts = [
  { value: 'a1', label: 'Pixelcraft Studio', description: 'Dubai · Agency' },
  { value: 'a2', label: 'Aurelia Bank', description: 'Doha · Banking' },
  { value: 'a3', label: 'Gulf Trading Co', description: 'Riyadh · Wholesale' },
  { value: 'a4', label: 'Northwind Foods', description: 'London · Retail' },
].map((a) => ({ ...a, icon: <Building2 aria-hidden="true" className="text-fg-secondary" /> }));

function AccountLookup() {
  const [value, setValue] = useState<string | undefined>('a2');
  return (
    <Combobox
      options={accounts}
      value={value}
      onValueChange={setValue}
      placeholder="Choose an account"
      searchPlaceholder="Search accounts"
      emptyText="No accounts match. Try another name."
      onCreate={() => undefined}
      createLabel={(q) => `Create account “${q}”`}
    />
  );
}

export const Selection: StoryObj = {
  render: () => (
    <div className="grid max-w-3xl grid-cols-1 gap-6 md:grid-cols-2">
      <FormField label="Stage">
        <Select options={stages} defaultValue="proposal" />
      </FormField>
      <FormField label="Account" helper="Search by name, city or industry.">
        <AccountLookup />
      </FormField>
      <FormField label="Stage (empty)">
        <Select options={stages} placeholder="Choose a stage" />
      </FormField>
      <FormField label="Stage (disabled)" disabled>
        <Select options={stages} defaultValue="won" />
      </FormField>
    </div>
  ),
};

export const ChipsAndAvatars: StoryObj = {
  name: 'Chips, avatars, keys',
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="success" dot>
          Won
        </StatusChip>
        <StatusChip tone="neutral">Lost</StatusChip>
        <StatusChip tone="warning" dot>
          At risk
        </StatusChip>
        <StatusChip tone="danger" dot>
          Breached 3h
        </StatusChip>
        <StatusChip tone="info">New</StatusChip>
        <StatusChip tone="ai">AI suggested</StatusChip>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(['cat-1', 'cat-2', 'cat-4', 'cat-5', 'cat-6', 'cat-7', 'cat-8'] as const).map(
          (tone, i) => (
            <StatusChip key={tone} tone={tone}>
              {
                [
                  'Discovery',
                  'Qualified',
                  'Proposal',
                  'Negotiation',
                  'Contract',
                  'Onboarding',
                  'Renewal',
                ][i]
              }
            </StatusChip>
          ),
        )}
      </div>
      <div className="flex items-end gap-3">
        <Avatar name="Amira Haddad" size={16} />
        <Avatar name="Omar Khalil" size={20} />
        <Avatar name="Priya Nair" size={24} presence="available" presenceLabel="Available" />
        <Avatar name="Jonas Weber" size={32} presence="busy" presenceLabel="On a call" />
        <Avatar name="Fatima Al-Sayed" size={40} presence="away" presenceLabel="On break" />
      </div>
      <div className="flex items-center gap-1 text-body-sm text-fg-secondary">
        Open the command palette with <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </div>
    </div>
  ),
};

export const CardAndSeparator: StoryObj = {
  render: () => (
    <Card
      className="max-w-md"
      title="Pipeline this quarter"
      subtitle="As of 09:30"
      actions={
        <>
          <IconButton label="Refresh" size="sm">
            <RefreshCw aria-hidden="true" />
          </IconButton>
          <IconButton label="More actions" size="sm">
            <MoreHorizontal aria-hidden="true" />
          </IconButton>
        </>
      }
    >
      <p className="tabular text-display text-fg">$1.24M</p>
      <Separator className="my-3" />
      <p className="text-body-sm text-fg-secondary">42 open opportunities across 3 pipelines.</p>
    </Card>
  ),
};
