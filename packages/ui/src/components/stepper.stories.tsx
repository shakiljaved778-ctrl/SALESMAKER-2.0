import type { Meta, StoryObj } from '@storybook/react-vite';

import { Stepper } from './stepper.js';

const meta: Meta<typeof Stepper> = { title: 'Components/Stepper', component: Stepper };
export default meta;

const steps = [
  { key: 'upload', label: 'Upload' },
  { key: 'headers', label: 'Sheet and headers' },
  { key: 'mapping', label: 'Map fields' },
  { key: 'duplicates', label: 'Duplicates' },
  { key: 'review', label: 'Review' },
  { key: 'run', label: 'Import' },
];
const labels = { label: 'Import steps', completedLabel: 'done', currentLabel: 'current step' };

export const First: StoryObj<typeof Stepper> = { args: { steps, current: 0, ...labels } };
export const Middle: StoryObj<typeof Stepper> = { args: { steps, current: 2, ...labels } };
export const Last: StoryObj<typeof Stepper> = { args: { steps, current: 5, ...labels } };
