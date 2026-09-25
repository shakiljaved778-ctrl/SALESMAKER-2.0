import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Settings, Trash2 } from 'lucide-react';

import { Button, IconButton } from './button.js';

const meta: Meta<typeof Button> = { title: 'Components/Button', component: Button };
export default meta;

const variants = ['primary', 'secondary', 'ghost', 'danger', 'ai', 'link'] as const;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-4">
      {variants.map((variant) => (
        <div key={variant} className="flex flex-wrap items-center gap-3">
          <span className="w-20 text-label text-fg-secondary">{variant}</span>
          <Button variant={variant}>Log call</Button>
          <Button variant={variant} icon={<Plus aria-hidden="true" />}>
            New lead
          </Button>
          <Button variant={variant} disabled>
            Disabled
          </Button>
          <Button variant={variant} loading loadingLabel="Saving…">
            Save changes
          </Button>
        </div>
      ))}
    </div>
  ),
};

export const Sizes: StoryObj = {
  render: () => (
    <div className="flex items-center gap-3">
      <Button variant="primary" size="sm">
        Small
      </Button>
      <Button variant="primary" size="md">
        Medium
      </Button>
      <Button variant="primary" size="lg">
        Large
      </Button>
    </div>
  ),
};

export const IconOnly: StoryObj = {
  render: () => (
    <div className="flex items-center gap-2">
      <IconButton label="Settings" size="sm">
        <Settings aria-hidden="true" />
      </IconButton>
      <IconButton label="Add" variant="secondary">
        <Plus aria-hidden="true" />
      </IconButton>
      <IconButton label="Delete" variant="danger" size="lg">
        <Trash2 aria-hidden="true" />
      </IconButton>
    </div>
  ),
};
