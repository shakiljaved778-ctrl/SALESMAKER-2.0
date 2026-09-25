export interface CoverageGate {
  /** Minimum line coverage in percent (default 80, §13). */
  lines?: number;
  /** Source globs that count towards coverage (default `src/**\/*.{ts,tsx}`). */
  include?: string[];
  /** Extra globs to leave out, each with a reason in the caller. */
  exclude?: string[];
}

export declare function coverage(gate?: CoverageGate): {
  provider: 'v8';
  include: string[];
  exclude: string[];
  reporter: string[];
  thresholds: { lines: number };
};
