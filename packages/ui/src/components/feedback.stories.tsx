import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Building2,
  CircleUserRound,
  Compass,
  Handshake,
  Inbox,
  Moon,
  Phone,
  Plus,
  UserPlus,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from './button.js';
import { CommandPalette, type CommandSection } from './command-palette.js';
import { Banner, EmptyState, Skeleton } from './feedback.js';
import { Card } from './primitives.js';

const meta: Meta = { title: 'Components/Feedback and command palette' };
export default meta;

export const Banners: StoryObj = {
  render: () => {
    const [dismissed, setDismissed] = useState(false);
    return (
      <div className="flex max-w-2xl flex-col gap-3">
        <Banner tone="info" title="Import running">
          12,408 rows are being added. You can keep working.
        </Banner>
        <Banner
          tone="warning"
          action={
            <Button size="sm" variant="secondary">
              Review approval
            </Button>
          }
        >
          This record is locked for approval.
        </Banner>
        <Banner tone="danger" title="Couldn't save the record">
          Someone else changed it. Reload to see their edits.
        </Banner>
        {dismissed ? null : (
          <Banner
            tone="ai"
            dismissLabel="Dismiss"
            onDismiss={() => {
              setDismissed(true);
            }}
          >
            Suggested: 3 open deals have no next step.
          </Banner>
        )}
      </div>
    );
  },
};

export const EmptyStates: StoryObj = {
  name: 'Empty state',
  render: () => (
    <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
      <Card>
        <EmptyState
          icon={<UserPlus />}
          title="Add your first lead"
          description="Leads are people you haven't qualified yet. Add one or import a spreadsheet."
          action={
            <Button variant="primary">
              <Plus aria-hidden="true" />
              New lead
            </Button>
          }
          learnMore={{ label: 'How leads work', href: '#leads' }}
        />
      </Card>
      <Card>
        <EmptyState
          icon={<Inbox />}
          title="You're all caught up"
          description="New tasks and mentions will show up here."
        />
      </Card>
    </div>
  ),
};

export const Skeletons: StoryObj = {
  name: 'Skeleton',
  render: () => (
    <Card className="max-w-2xl" aria-busy="true" aria-label="Loading leads">
      <ul className="flex flex-col divide-y divide-line-subtle">
        {[0, 1, 2, 3].map((row) => (
          <li key={row} className="flex items-center gap-3 px-4 py-3">
            <Skeleton shape="circle" className="size-8" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton shape="text" className="w-1/3" />
              <Skeleton shape="text" className="w-1/2 text-caption" />
            </div>
            <Skeleton className="h-5 w-16" />
          </li>
        ))}
      </ul>
    </Card>
  ),
};

const noop = () => undefined;

const sections: CommandSection[] = [
  {
    id: 'recent',
    heading: 'Recent',
    items: [
      {
        id: 'r1',
        label: 'Pixelcraft Studio',
        description: 'Account',
        icon: <Building2 />,
        onSelect: noop,
      },
      {
        id: 'r2',
        label: 'Amira Haddad',
        description: 'Contact · Pixelcraft Studio',
        icon: <CircleUserRound />,
        onSelect: noop,
      },
    ],
  },
  {
    id: 'accounts',
    heading: 'Accounts',
    scope: 'account',
    items: [
      {
        id: 'a1',
        label: 'Pixelcraft Studio',
        description: 'Dubai',
        icon: <Building2 />,
        onSelect: noop,
      },
      {
        id: 'a2',
        label: 'Northwind Traders',
        description: 'Riyadh',
        icon: <Building2 />,
        onSelect: noop,
      },
    ],
  },
  {
    id: 'commands',
    heading: 'Commands',
    items: [
      {
        id: 'c1',
        label: 'Create lead',
        icon: <UserPlus />,
        shortcut: ['C'],
        keywords: ['new'],
        onSelect: noop,
      },
      { id: 'c2', label: 'Log a call', icon: <Phone />, onSelect: noop },
      {
        id: 'c3',
        label: 'Go to Opportunities',
        icon: <Handshake />,
        shortcut: ['G', 'O'],
        onSelect: noop,
      },
      {
        id: 'c4',
        label: 'Go to Forecast',
        icon: <Compass />,
        shortcut: ['G', 'F'],
        onSelect: noop,
      },
      { id: 'c5', label: 'Switch to dark mode', icon: <Moon />, onSelect: noop },
    ],
  },
];

const paletteCopy = {
  label: 'Command palette',
  placeholder: 'Search records or type a command…',
  emptyText: 'Nothing matches. Try a different word.',
  hints: { navigate: 'Navigate', select: 'Open', scope: 'Scope', close: 'Close' },
  scopes: [{ id: 'account', label: 'Accounts' }],
};

export const Palette: StoryObj = {
  name: 'Command palette',
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button
          onClick={() => {
            setOpen(true);
          }}
        >
          Open palette
        </Button>
        <CommandPalette open={open} onOpenChange={setOpen} sections={sections} {...paletteCopy} />
      </>
    );
  },
};

export const PaletteFiltered: StoryObj = {
  name: 'Command palette (fuzzy match)',
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        sections={sections}
        initialQuery="go"
        {...paletteCopy}
      />
    );
  },
};
