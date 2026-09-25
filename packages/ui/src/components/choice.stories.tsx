import type { Meta, StoryObj } from '@storybook/react-vite';

import { Checkbox, Radio, RadioGroup, Switch } from './choice.js';
import { FormField } from './form-field.js';

const meta: Meta = { title: 'Components/Choice controls' };
export default meta;

export const All: StoryObj = {
  render: () => (
    <div className="flex flex-wrap gap-12">
      <div className="flex flex-col gap-2">
        <Checkbox label="Unchecked" />
        <Checkbox label="Checked" defaultChecked />
        <Checkbox label="Indeterminate" checked="indeterminate" />
        <Checkbox label="Disabled" disabled />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-label text-fg-secondary">Forecast category</legend>
        <RadioGroup defaultValue="commit" aria-label="Forecast category">
          <Radio value="pipeline" label="Pipeline" />
          <Radio value="best" label="Best case" />
          <Radio value="commit" label="Commit" />
          <Radio value="omitted" label="Omitted" disabled />
        </RadioGroup>
      </fieldset>
      <div className="flex flex-col gap-3">
        <Switch label="Email notifications" defaultChecked />
        <Switch label="Daily digest" />
        <Switch label="Web push (coming soon)" disabled />
      </div>
      <FormField label="Terms" required>
        <Checkbox label="I agree to the terms" />
      </FormField>
    </div>
  ),
};
