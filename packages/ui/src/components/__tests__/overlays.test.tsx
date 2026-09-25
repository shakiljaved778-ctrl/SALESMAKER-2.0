// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DropdownMenu } from '../menu.js';
import { Dialog } from '../overlays.js';
import { Tabs } from '../tabs.js';
import { ToastProvider, useToast } from '../toast.js';

const discardCopy = {
  title: 'Discard changes?',
  body: 'Edits will be lost.',
  confirm: 'Discard',
  cancel: 'Keep editing',
};

function DirtyDialog({ dirty }: { dirty: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span>{open ? 'open' : 'closed'}</span>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Edit lead"
        closeLabel="Close"
        dirty={dirty}
        discardCopy={discardCopy}
      >
        <input aria-label="Name" />
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('closes on Escape when there are no unsaved changes', async () => {
    render(<DirtyDialog dirty={false} />);
    expect(screen.getByRole('dialog', { name: 'Edit lead' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('closed')).toBeInTheDocument();
  });

  it('asks before discarding unsaved changes, and can keep editing', async () => {
    render(<DirtyDialog dirty />);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog', { name: 'Discard changes?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByText('open')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByText('closed')).toBeInTheDocument();
  });
});

describe('DropdownMenu', () => {
  it('opens from its trigger and runs the chosen item', async () => {
    const onEdit = vi.fn();
    render(
      <DropdownMenu
        label="Actions"
        trigger={<button type="button">More</button>}
        items={[{ type: 'item', label: 'Edit', onSelect: onEdit }]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it('offers exclusive choices as checked radio items and stays open to show the change', async () => {
    const onTheme = vi.fn();
    render(
      <DropdownMenu
        label="Account"
        trigger={<button type="button">Account</button>}
        items={[
          {
            type: 'radio',
            label: 'Theme',
            value: 'dark',
            options: [
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ],
            onValueChange: onTheme,
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }));
    expect(onTheme).toHaveBeenCalledWith('light');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('Tabs', () => {
  it('switches panels with arrow keys and shows counts', async () => {
    render(
      <Tabs
        label="Sections"
        items={[
          { value: 'a', label: 'Overview', content: <p>Overview panel</p> },
          { value: 'b', label: 'Activity', count: 12, content: <p>Activity panel</p> },
        ]}
      />,
    );
    expect(screen.getByText('12')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Activity/ })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Activity panel')).toBeVisible();
  });
});

describe('Toasts', () => {
  function Trigger({ n }: { n: number }) {
    const toast = useToast();
    return (
      <button
        type="button"
        onClick={() => {
          for (let i = 1; i <= n; i += 1) toast({ tone: 'info', title: `Toast ${String(i)}` });
        }}
      >
        Notify
      </button>
    );
  }

  it('keeps at most three visible, newest last', async () => {
    render(
      <ToastProvider closeLabel="Dismiss" viewportLabel="Notifications">
        <Trigger n={5} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Notify' }));
    expect(screen.queryByText('Toast 1')).toBeNull();
    expect(screen.queryByText('Toast 2')).toBeNull();
    for (const n of [3, 4, 5]) expect(screen.getByText(`Toast ${String(n)}`)).toBeInTheDocument();
  });

  it('runs the Undo action and can be dismissed', async () => {
    const undo = vi.fn();
    function UndoTrigger() {
      const toast = useToast();
      return (
        <button
          type="button"
          onClick={() => {
            toast({
              tone: 'success',
              title: 'Lead deleted',
              action: { label: 'Undo', onClick: undo },
            });
          }}
        >
          Delete
        </button>
      );
    }
    render(
      <ToastProvider closeLabel="Dismiss" viewportLabel="Notifications">
        <UndoTrigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    // Taking the action closes the toast.
    await waitFor(() => {
      expect(screen.queryByText('Lead deleted')).toBeNull();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });
    await waitFor(() => {
      expect(screen.queryByText('Lead deleted')).toBeNull();
    });
    expect(undo).toHaveBeenCalledOnce();
  });
});
