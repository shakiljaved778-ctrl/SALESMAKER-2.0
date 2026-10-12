// Create the local/CI object-storage bucket with CORS for the web app (`pnpm storage:setup`, after
// `docker compose up -d s3`). Deployed cells get theirs from Terraform.
import { s3StorageFrom } from '../packages/integrations/dist/index.js';

const env = process.env;
const storage = s3StorageFrom({
  S3_ENDPOINT: env.S3_ENDPOINT,
  S3_REGION: env.S3_REGION ?? 'eu-central-1',
  S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
  S3_BUCKET: env.S3_BUCKET,
});
if (!storage) {
  process.stderr.write('S3_* is not configured; nothing to set up\n');
  process.exit(1);
}
const scheme = env.WEB_URL_SCHEME ?? 'http';
const base = env.WEB_BASE_DOMAIN ?? 'localhost:3000';
// Every workspace host and the apex. The store may still be starting: try for a minute.
for (let attempt = 1; ; attempt += 1) {
  try {
    await storage.ensureBucket([`${scheme}://${base}`, `${scheme}://*.${base}`]);
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
process.stdout.write(`bucket ${env.S3_BUCKET} ready\n`);
