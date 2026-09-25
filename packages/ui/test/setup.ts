import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-cleans with test globals; this suite runs without them.
afterEach(() => {
  cleanup();
});

// jsdom lacks these browser APIs used by Radix (popper positioning) and cmdk (scrolling).
const noop = (): void => undefined;
if (typeof window !== 'undefined') {
  if (!('ResizeObserver' in window)) {
    Object.defineProperty(window, 'ResizeObserver', {
      value: class {
        observe = noop;
        unobserve = noop;
        disconnect = noop;
      },
    });
  }
  for (const method of ['scrollIntoView', 'releasePointerCapture'] as const) {
    if (!(method in Element.prototype))
      Object.defineProperty(Element.prototype, method, { value: noop });
  }
  if (!('hasPointerCapture' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'hasPointerCapture', { value: () => false });
  }
}
