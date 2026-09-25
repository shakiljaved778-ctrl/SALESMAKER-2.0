import { defineConfig } from 'prisma/config';

// Migrations run as the owner role (sm_migrator). The runtime uses sm_app, which has no DDL
// rights and no BYPASSRLS (§3.5).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env['CELL_DATABASE_URL_MIGRATOR'] ?? '',
    // Throwaway database used only by the schema-drift check (`pnpm db:schema-drift`).
    shadowDatabaseUrl: process.env['CELL_SHADOW_DATABASE_URL'],
  },
});
