/**
 * Runs once when a server instance starts (Next.js instrumentation). A misconfigured deployment
 * logs which variables are wrong as its first line; it still starts, so /api/health and the
 * not-configured page (proxy.ts) can say what to fix instead of a bare 500.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { webEnvProblems } = await import('./server/env');
  const problems = webEnvProblems();
  if (problems.length > 0) {
    process.stderr.write(
      `[config] Missing or invalid environment variables: ${problems.join(', ')}. ` +
        'Set them for this environment (Vercel → Settings → Environment Variables) and redeploy.\n',
    );
  }
}
