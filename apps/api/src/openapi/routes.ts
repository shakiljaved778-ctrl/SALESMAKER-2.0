import {
  accessRoutes,
  auditRoutes,
  sessionRoutes,
  setupRoutes,
  userRoutes,
  authRoutes,
  mfaRoutes,
  oidcRoutes,
  openApiRoute,
  signupRoutes,
  systemRoutes,
  type RouteContract,
} from '@sm/contracts';

/**
 * Every route this service serves, by contract (golden rule 7). A test fails if Fastify serves a
 * route that is missing here, and CI fails if the generated document drifts from the committed
 * snapshot (§10.1).
 */
export const apiRoutes: readonly RouteContract[] = [
  systemRoutes.health,
  systemRoutes.ready,
  openApiRoute,
  ...Object.values(authRoutes),
  ...Object.values(mfaRoutes),
  ...Object.values(oidcRoutes),
  ...Object.values(signupRoutes),
  ...Object.values(accessRoutes),
  ...Object.values(auditRoutes),
  ...Object.values(sessionRoutes),
  ...Object.values(userRoutes),
  ...Object.values(setupRoutes),
];

export const API_INFO = {
  title: 'SalesMaker cell API',
  version: '1.0.0',
  description: 'Regional data-plane API. Public routes are also served at /v1/openapi.json.',
};
