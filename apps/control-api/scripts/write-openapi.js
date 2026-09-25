import { writeFileSync } from 'node:fs';

import { buildOpenApiDocument } from '@sm/contracts';

import { CONTROL_API_INFO, controlApiRoutes } from '../dist/openapi/routes.js';

writeFileSync(
  new URL('../openapi.snapshot.json', import.meta.url),
  `${JSON.stringify(buildOpenApiDocument(controlApiRoutes, CONTROL_API_INFO), null, 2)}\n`,
);
process.stdout.write('openapi.snapshot.json written\n');
