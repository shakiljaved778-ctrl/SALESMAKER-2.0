import './instrument.js';

import { loadConfig } from './config.js';
import { createWorker } from './worker.js';

const worker = await createWorker(loadConfig());
await worker.start();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    worker.logger.info({ signal }, 'worker stopping');
    void worker.stop().then(() => process.exit(0));
  });
}
