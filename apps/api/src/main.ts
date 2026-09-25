import './instrument.js';

import { createApiApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = await createApiApp(config);
await app.listen({ port: config.PORT, host: '0.0.0.0' });
