/** Injection tokens for infrastructure the app module receives from createApiApp(). */
export const CONFIG = Symbol('ApiConfig');
export const PRISMA = Symbol('CellPrisma');
export const REDIS = Symbol('Redis');
export const LOGGER = Symbol('Logger');
