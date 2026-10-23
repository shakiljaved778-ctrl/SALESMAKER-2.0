/**
 * Runs once when a server instance starts (Next.js instrumentation). Validating the environment
 * here puts a misconfigured deployment's problem in the first log line, not in the first request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { webEnv } = await import('./server/env');
  webEnv();
}
