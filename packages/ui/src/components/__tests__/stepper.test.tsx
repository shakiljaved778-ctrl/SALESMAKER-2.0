// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Stepper } from '../stepper.js';

describe('Stepper', () => {
  it('names the steps, marks the current one and says which are done', () => {
    render(
      <Stepper
        steps={[
          { key: 'a', label: 'Upload' },
          { key: 'b', label: 'Map' },
          { key: 'c', label: 'Run' },
        ]}
        current={1}
        label="Import steps"
        completedLabel="done"
        currentLabel="current step"
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Import steps' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    const current = screen.getByText('Map').closest('[aria-current]');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Upload')).toHaveTextContent('Upload, done');
    expect(screen.getByText('Run')).not.toHaveTextContent('done');
  });
});
