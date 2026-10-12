import { inject } from 'vitest';

import { startHarness as start, type Harness } from '../src/testing.js';

export { allFields, fakeCurrency, FULL, type Harness } from '../src/testing.js';

/** The harness on this run's test database. */
export const startHarness = (tenantId: string): Promise<Harness> =>
  start(tenantId, inject('pgServerAdminUrl'));
