import { controlPlaneRoutes, systemRoutes, type RouteContract } from '@sm/contracts';

export const controlApiRoutes: readonly RouteContract[] = [
  systemRoutes.health,
  systemRoutes.ready,
  ...Object.values(controlPlaneRoutes),
];

export const CONTROL_API_INFO = {
  title: 'SalesMaker control plane API',
  version: '1.0.0',
  description: 'Global tenant directory and routing. Internal: called by the web app and by cells.',
};
