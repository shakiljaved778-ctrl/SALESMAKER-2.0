import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SERVICE_KEY } from './support.js';

const BASE = {
  CELL_ID: 'eu-central-1',
  CELL_DATABASE_URL: 'postgresql://sm_app:x@localhost:5432/cell',
  REDIS_URL: 'redis://localhost:6379',
  CONTROL_API_BASE_URL: 'http://localhost:4100',
};

describe('loadConfig', () => {
  it('applies defaults and reads the service key from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sm-worker-'));
    const path = join(dir, 'cell.pem');
    writeFileSync(path, SERVICE_KEY);
    const config = loadConfig({ ...BASE, CELL_SERVICE_PRIVATE_KEY_PATH: path });
    expect(config).toMatchObject({
      CELL_SERVICE_PRIVATE_KEY_PEM: SERVICE_KEY,
      QUEUE_PREFIX: 'sm',
      RELAY_BATCH: 100,
      JOB_ATTEMPTS: 5,
      WORKER_CONCURRENCY: 10,
    });
    expect(config.CELL_DATABASE_LISTEN_URL).toBeUndefined();
  });

  it('prefers an inline key and fails fast on a bad value', () => {
    expect(
      loadConfig({ ...BASE, CELL_SERVICE_PRIVATE_KEY_PEM: SERVICE_KEY, RELAY_BATCH: '5' })
        .RELAY_BATCH,
    ).toBe(5);
    expect(() =>
      loadConfig({ ...BASE, CELL_SERVICE_PRIVATE_KEY_PEM: SERVICE_KEY, JOB_ATTEMPTS: '0' }),
    ).toThrow();
    expect(() => loadConfig(BASE)).toThrow(/CELL_SERVICE_PRIVATE_KEY_PEM/);
  });
});
