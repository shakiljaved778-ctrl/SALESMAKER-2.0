// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { fuzzyMatch } from '../../lib/fuzzy.js';
import { CommandPalette, type CommandSection } from '../command-palette.js';
import { Banner, EmptyState, Skeleton } from '../feedback.js';

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively and reports positions', () => {
    expect(fuzzyMatch('crl', 'Create lead')?.positions).toEqual([0, 1, 7]);
    expect(fuzzyMatch('xyz', 'Create lead')).toBeNull();
    expect(fuzzyMatch('', 'Anything')).toEqual({ score: 0, positions: [] });
  });

  it('prefers contiguous matches at word starts', () => {
    const lead = fuzzyMatch('lead', 'Create lead');
    const pleaded = fuzzyMatch('lead', 'Pleaded');
    expect(lead?.positions).toEqual([7, 8, 9, 10]);
    expect(lead?.score ?? 0).toBeGreaterThan(pleaded?.score ?? Infinity);
    // Word-start initials beat scattered letters.
    expect(fuzzyMatch('cl', 'Create lead')?.score ?? 0).toBeGreaterThan(
      fuzzyMatch('cl', 'Cancel')?.score ?? Infinity,
    );
  });

  it('falls back to leftmost matching when jumping to a word start would strand a letter', () => {
    expect(fuzzyMatch('ab', 'xa-b a')?.positions).toEqual([1, 3]);
  });
});

describe('Banner', () => {
  it('announces danger assertively and others politely', () => {
    render(
      <>
        <Banner tone="danger">Couldn't save</Banner>
        <Banner tone="info">Import running</Banner>
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save");
    expect(screen.getByRole('status')).toHaveTextContent('Import running');
  });

  it('is dismissible only when given a handler and a label', async () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Banner tone="ai">Suggested</Banner>);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      <Banner tone="ai" onDismiss={onDismiss} dismissLabel="Dismiss">
        Suggested
      </Banner>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe('EmptyState and Skeleton', () => {
  it('renders a headline, a teaching sentence, one action and a learn-more link', () => {
    render(
      <EmptyState
        icon={<svg />}
        title="Add your first lead"
        description="Leads are people you haven't qualified yet."
        action={<button type="button">New lead</button>}
        learnMore={{ label: 'How leads work', href: '/help/leads' }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Add your first lead' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New lead' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How leads work' })).toHaveAttribute(
      'href',
      '/help/leads',
    );
  });

  it('hides skeletons from assistive tech and stops the shimmer under reduced motion', () => {
    const { container } = render(<Skeleton className="h-4" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el.className).toContain('motion-reduce:animate-none');
  });
});

describe('CommandPalette', () => {
  function setup(extra: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
    const createLead = vi.fn();
    const openAccount = vi.fn();
    const sections: CommandSection[] = [
      {
        id: 'accounts',
        heading: 'Accounts',
        scope: 'account',
        items: [
          { id: 'a1', label: 'Pixelcraft Studio', onSelect: openAccount },
          { id: 'a2', label: 'Northwind Traders', onSelect: vi.fn() },
        ],
      },
      {
        id: 'commands',
        heading: 'Commands',
        items: [
          { id: 'c1', label: 'Create lead', keywords: ['new'], onSelect: createLead },
          { id: 'c2', label: 'Log a call', onSelect: vi.fn() },
        ],
      },
    ];
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <CommandPalette
          open={open}
          onOpenChange={setOpen}
          label="Command palette"
          placeholder="Search"
          emptyText="Nothing matches"
          sections={sections}
          scopes={[{ id: 'account', label: 'Accounts' }]}
          hints={{ navigate: 'Navigate', select: 'Open', scope: 'Scope', close: 'Close' }}
          {...extra}
        />
      );
    }
    render(<Harness />);
    return { createLead, openAccount, input: screen.getByRole('combobox') };
  }

  it('is a named dialog with every section when the query is empty', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('filters fuzzily, highlights the match, and runs the command on Enter', async () => {
    const { createLead, input } = setup();
    await userEvent.type(input, 'crl');
    const [option, ...rest] = screen.getAllByRole('option');
    expect(rest).toHaveLength(0);
    const marks = within(option as HTMLElement).getAllByText((_, el) => el?.tagName === 'MARK');
    expect(marks.map((m) => m.textContent)).toEqual(['Cr', 'l']);
    await userEvent.keyboard('{Enter}');
    expect(createLead).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('matches hidden keywords and shows the empty text when nothing matches', async () => {
    const { input } = setup();
    await userEvent.type(input, 'new');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Create lead']);
    await userEvent.clear(input);
    await userEvent.type(input, 'zzzz');
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
  });

  it('moves with the arrow keys', async () => {
    const { openAccount, input } = setup();
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    expect(openAccount).toHaveBeenCalledOnce();
  });

  it('scopes with Tab, and Backspace on an empty query clears the scope', async () => {
    const { input } = setup();
    await userEvent.click(input);
    await userEvent.tab();
    expect(input).toHaveFocus();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Pixelcraft Studio',
      'Northwind Traders',
    ]);
    await userEvent.keyboard('{Backspace}');
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('shows at most limitPerSection matches per section while typing', async () => {
    const { input } = setup({ limitPerSection: 1 });
    await userEvent.type(input, 'r');
    const accounts = screen.getByRole('group', { name: 'Accounts' });
    expect(within(accounts).getAllByRole('option')).toHaveLength(1);
  });
});
