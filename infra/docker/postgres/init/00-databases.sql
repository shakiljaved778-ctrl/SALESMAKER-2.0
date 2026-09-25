-- Local-only bootstrap: creates the cell, control-plane and test databases.
-- Roles, extensions and grants for the cell are applied by `pnpm db:bootstrap`
-- (packages/db/scripts/bootstrap.js), the same script deployed cells use.
CREATE DATABASE salesmaker_cell;
CREATE DATABASE salesmaker_cp;
CREATE DATABASE salesmaker_test;
