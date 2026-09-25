/**
 * Coverage gate shared by every package (§13): V8 line coverage over the package's own source,
 * enforced when tests run with `--coverage` (every package's `test` script does). Generated code,
 * stories and type declarations never count. §13 sets ≥ 90% for formula, permissions and
 * query-engine and ≥ 80% everywhere else; pass a higher `lines` for the engine packages.
 *
 * @param {{ lines?: number; include?: string[]; exclude?: string[] }} [gate]
 */
export function coverage({ lines = 80, include = ['src/**/*.{ts,tsx}'], exclude = [] } = {}) {
  return {
    provider: /** @type {const} */ ('v8'),
    include,
    exclude: [
      'src/generated/**',
      '**/*.stories.tsx',
      '**/*.d.ts',
      '**/*.test.{ts,tsx}',
      ...exclude,
    ],
    reporter: ['text-summary'],
    thresholds: { lines },
  };
}
