import './instrument.js';

import { createControlApiApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = await createControlApiApp(config);
await app.listen({ port: config.PORT, host: '0.0.0.0' });
