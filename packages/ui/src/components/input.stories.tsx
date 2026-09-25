import type { Meta, StoryObj } from '@storybook/react-vite';
import { Mail, Search } from 'lucide-react';
import { useState } from 'react';

import { FormField } from './form-field.js';
import { Input, Textarea } from './input.js';

const meta: Meta = { title: 'Components/Input' };
export default meta;

function ClearableSearch() {
  const [value, setValue] = useState('Aurelia');
  return (
    <Input
      aria-label="Search leads"
      prefix={<Search aria-hidden="true" />}
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
      }}
      onClear={() => {
        setValue('');
      }}
      clearLabel="Clear search"
    />
  );
}

export const States: StoryObj = {
  render: () => (
    <div className="grid max-w-3xl grid-cols-1 gap-6 md:grid-cols-2">
      <FormField label="Company" helper="As it appears on invoices.">
        <Input placeholder="Pixelcraft Studio" />
      </FormField>
      <FormField label="Work email" required>
        <Input
          type="email"
          prefix={<Mail aria-hidden="true" />}
          defaultValue="amira@pixelcraft.test"
        />
      </FormField>
      <FormField label="Search">
        <ClearableSearch />
      </FormField>
      <FormField label="Deal name" helper="Short and specific.">
        <Input maxLength={80} showCount defaultValue="Pixelcraft – Website redesign" />
      </FormField>
      <FormField
        label="Close date"
        error="Close date can't be in the past for open deals. Pick today or later."
      >
        <Input defaultValue="2020-01-01" />
      </FormField>
      <FormField label="Record number" disabled>
        <Input defaultValue="L-000123" />
      </FormField>
      <FormField label="Owner">
        <Input readOnly defaultValue="Amira Haddad" />
      </FormField>
      <FormField label="Next step" helper="What happens next, and when.">
        <Textarea maxLength={255} showCount defaultValue="Send proposal by Thursday" />
      </FormField>
    </div>
  ),
};
