import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-cleans with test globals; this suite runs without them.
afterEach(() => {
  cleanup();
});
