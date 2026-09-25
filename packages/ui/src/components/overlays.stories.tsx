import type { Meta, StoryObj } from '@storybook/react-vite';
import { Copy, MoreHorizontal, Pencil, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, IconButton } from './button.js';
import { FormField } from './form-field.js';
import { Input } from './input.js';
import { DropdownMenu } from './menu.js';
import { Dialog, Popover, Sheet } from './overlays.js';
import { Tabs } from './tabs.js';
import { ToastProvider, useToast } from './toast.js';

const meta: Meta = { title: 'Components/Overlays and navigation' };
export default meta;

const discardCopy = {
  title: 'Discard changes?',
  body: 'Your edits to this lead will be lost.',
  confirm: 'Discard',
  cancel: 'Keep editing',
};

export const DialogOpen: StoryObj = {
  name: 'Dialog',
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button
          variant="primary"
          onClick={() => {
            setOpen(true);
          }}
        >
          Convert lead
        </Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Convert lead"
          description="Creates an account, a contact and, optionally, an opportunity."
          closeLabel="Close"
          discardCopy={discardCopy}
          footer={
            <>
              <Button
                onClick={() => {
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button variant="primary">Convert lead</Button>
            </>
          }
        >
          <div className="flex flex-col gap-[var(--field-gap)]">
            <FormField label="Account name" required>
              <Input defaultValue="Pixelcraft Studio" />
            </FormField>
            <FormField label="Opportunity name" helper="Leave empty to skip the opportunity.">
              <Input defaultValue="Pixelcraft – Website redesign" />
            </FormField>
          </div>
        </Dialog>
      </>
    );
  },
};

export const SheetOpen: StoryObj = {
  name: 'Sheet',
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="New contact"
        closeLabel="Close"
        footer={<Button variant="primary">Save contact</Button>}
      >
        <FormField label="Full name" required>
          <Input placeholder="Amira Haddad" />
        </FormField>
      </Sheet>
    );
  },
};

export const MenuAndPopover: StoryObj = {
  name: 'Menu and popover',
  render: () => (
    <div className="flex items-start gap-24">
      {/* Non-modal so the static open state can be inspected; modal menus trap focus instead. */}
      <DropdownMenu
        defaultOpen
        modal={false}
        label="Record actions"
        trigger={
          <IconButton label="More actions" variant="secondary">
            <MoreHorizontal aria-hidden="true" />
          </IconButton>
        }
        items={[
          { type: 'label', label: 'Record' },
          {
            type: 'item',
            label: 'Edit',
            icon: <Pencil aria-hidden="true" />,
            shortcut: 'E',
            onSelect: () => undefined,
          },
          {
            type: 'item',
            label: 'Change owner',
            icon: <UserRound aria-hidden="true" />,
            onSelect: () => undefined,
          },
          {
            type: 'item',
            label: 'Copy link',
            icon: <Copy aria-hidden="true" />,
            onSelect: () => undefined,
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Delete',
            icon: <Trash2 aria-hidden="true" />,
            destructive: true,
            onSelect: () => undefined,
          },
        ]}
      />
    </div>
  ),
};

export const PopoverOpen: StoryObj = {
  name: 'Popover',
  render: () => (
    <Popover open label="Filters" trigger={<Button>Filter</Button>}>
      <p className="text-body-sm text-fg-secondary">Owner is me · Stage is Proposal</p>
    </Popover>
  ),
};

export const TabsStory: StoryObj = {
  name: 'Tabs',
  render: () => (
    <Tabs
      label="Record sections"
      items={[
        {
          value: 'overview',
          label: 'Overview',
          content: <p className="text-body text-fg-secondary">Key fields and related records.</p>,
        },
        { value: 'activity', label: 'Activity', count: 12, content: <p>Timeline</p> },
        { value: 'related', label: 'Related', count: 4, content: <p>Related lists</p> },
        { value: 'history', label: 'History', content: <p>Field history</p> },
        { value: 'ai', label: 'AI', content: <p>Insights</p> },
      ]}
    />
  ),
};

function ToastDemo() {
  const toast = useToast();
  useEffect(() => {
    toast({
      tone: 'success',
      title: 'Lead converted',
      description: 'Pixelcraft Studio is now an account.',
      action: { label: 'Undo', onClick: () => undefined },
      durationMs: Number.POSITIVE_INFINITY,
    });
    toast({
      tone: 'info',
      title: 'Import running',
      description: '12,408 rows · about 2 minutes left.',
      durationMs: Number.POSITIVE_INFINITY,
    });
    toast({
      tone: 'error',
      title: "Couldn't save the record",
      description: 'Someone else changed it. Reload to see their edits.',
    });
  }, [toast]);
  return (
    <p className="text-body-sm text-fg-secondary">Toasts stack at the bottom start, up to three.</p>
  );
}

export const Toasts: StoryObj = {
  render: () => (
    <ToastProvider closeLabel="Dismiss" viewportLabel="Notifications ({hotkey})">
      <ToastDemo />
    </ToastProvider>
  ),
};
