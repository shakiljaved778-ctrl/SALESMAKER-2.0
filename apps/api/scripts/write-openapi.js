// Regenerates openapi.snapshot.json (all routes, including internal ones). Commit the result;
// the drift test fails when the snapshot and the contracts disagree (§10.1).
import { writeFileSync } from 'node:fs';

import { buildOpenApiDocument } from '@sm/contracts';

import { API_INFO, apiRoutes } from '../dist/openapi/routes.js';

writeFileSync(
  new URL('../openapi.snapshot.json', import.meta.url),
  `${JSON.stringify(buildOpenApiDocument(apiRoutes, API_INFO), null, 2)}\n`,
);
process.stdout.write('openapi.snapshot.json written\n');
