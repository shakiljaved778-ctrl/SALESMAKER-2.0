// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Avatar, initialsOf, toneOf } from '../avatar.js';
import { Combobox } from '../combobox.js';
import { StatusChip } from '../status-chip.js';

describe('Avatar', () => {
  it('derives initials and a stable tone, never the AI (Iris) slot', () => {
    expect(initialsOf('Amira Haddad')).toBe('AH');
    expect(initialsOf('priya')).toBe('P');
    expect(initialsOf('  ')).toBe('?');
    expect(toneOf('Amira Haddad')).toBe(toneOf('Amira Haddad'));
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
      expect(toneOf(n)).not.toContain('cat-3');
  });

  it('names the person and labels the presence dot', async () => {
    render(<Avatar name="Jonas Weber" presence="busy" presenceLabel="On a call" />);
    expect(await screen.findByText('Jonas Weber')).toHaveClass('sr-only');
    expect(screen.getByRole('img', { name: 'On a call' })).toBeInTheDocument();
  });
});

describe('StatusChip', () => {
  it('always shows its text (colour is never the only signal)', () => {
    render(
      <StatusChip tone="danger" dot>
        Breached 3h
      </StatusChip>,
    );
    expect(screen.getByText('Breached 3h')).toBeVisible();
  });
});

describe('Combobox', () => {
  const options = [
    { value: 'a1', label: 'Pixelcraft Studio', description: 'Dubai' },
    { value: 'a2', label: 'Aurelia Bank', description: 'Doha' },
  ];

  it('filters by typing and selects with the keyboard', async () => {
    const onValueChange = vi.fn();
    render(
      <Combobox
        options={options}
        onValueChange={onValueChange}
        placeholder="Choose"
        searchPlaceholder="Search"
        emptyText="None"
        aria-label="Account"
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    await userEvent.type(screen.getByPlaceholderText('Search'), 'doha');
    expect(screen.queryByText('Pixelcraft Studio')).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('a2');
  });

  it('offers "create new" for an unmatched query', async () => {
    const onCreate = vi.fn();
    render(
      <Combobox
        options={options}
        placeholder="Choose"
        searchPlaceholder="Search"
        emptyText="None"
        aria-label="Account"
        onCreate={onCreate}
        createLabel={(q) => `Create “${q}”`}
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    await userEvent.type(screen.getByPlaceholderText('Search'), 'Zenith');
    await userEvent.click(screen.getByText('Create “Zenith”'));
    expect(onCreate).toHaveBeenCalledWith('Zenith');
  });
});
