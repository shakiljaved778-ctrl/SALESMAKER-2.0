// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button, IconButton } from '../button.js';
import { Checkbox, Switch } from '../choice.js';
import { FormField } from '../form-field.js';
import { Input } from '../input.js';

describe('Button', () => {
  it('is a type="button" by default and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Log call</Button>);
    const button = screen.getByRole('button', { name: 'Log call' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('while loading: busy, disabled, label kept for width, loading text announced', async () => {
    const onClick = vi.fn();
    render(
      <Button loading loadingLabel="Saving…" onClick={onClick}>
        Save changes
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    expect(screen.getByText('Save changes')).toBeInTheDocument();
    expect(screen.getByText('Saving…')).toHaveClass('sr-only');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('adds the sparkle icon to the AI variant', () => {
    const { container } = render(<Button variant="ai">Draft reply</Button>);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('IconButton', () => {
  it('uses its label as the accessible name', () => {
    render(
      <IconButton label="Delete record">
        <svg />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Delete record' })).toBeInTheDocument();
  });
});

describe('FormField + Input', () => {
  it('wires label, helper, required and ids to the control', () => {
    render(
      <FormField label="Work email" helper="We never share it." required>
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText(/Work email/);
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toHaveAccessibleDescription('We never share it.');
  });

  it('replaces the helper with the error and marks the control invalid', () => {
    render(
      <FormField label="Close date" helper="When you expect to close." error="Pick today or later.">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText('Close date');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Pick today or later.');
    expect(screen.queryByText('When you expect to close.')).toBeNull();
  });

  it('offers a clear button while there is a value, and counts characters', async () => {
    function Harness() {
      const [value, setValue] = useState('abc');
      return (
        <Input
          aria-label="Search"
          value={value}
          maxLength={10}
          showCount
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
    render(<Harness />);
    expect(screen.getByText('3/10')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByLabelText('Search')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    expect(screen.getByText('0/10')).toBeInTheDocument();
  });

  it('renders read-only values without a frame', () => {
    render(<Input aria-label="Owner" readOnly defaultValue="Amira" />);
    expect(screen.getByLabelText('Owner')).toHaveAttribute('readonly');
  });
});

describe('Choice controls', () => {
  it('toggles a checkbox and a switch by their labels', async () => {
    render(
      <>
        <Checkbox label="Follow record" />
        <Switch label="Daily digest" />
      </>,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Follow record' });
    await userEvent.click(screen.getByText('Follow record'));
    expect(checkbox).toHaveAttribute('data-state', 'checked');
    const toggle = screen.getByRole('switch', { name: 'Daily digest' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});
