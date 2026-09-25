import { CellSummary } from '@sm/contracts';
import { z } from 'zod';

export type Cell = z.infer<typeof CellSummary>;

const CellList = z.object({ cells: z.array(CellSummary) });

/** Public control-plane calls the web tier makes: the region list and "find my workspaces". */
export class ControlPlane {
  private cells: { value: Cell[]; expiresAt: number } | undefined;

  constructor(
    private readonly options: {
      baseUrl: string;
      ttlMs: number;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}

  private get fetchImpl() {
    return this.options.fetch ?? fetch;
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  /** Data regions a new organisation can choose (cached like the tenant directory). */
  async listCells(): Promise<Cell[] | null> {
    if (this.cells && this.cells.expiresAt > this.now()) return this.cells.value;
    try {
      const response = await this.fetchImpl(new URL('/cp/v1/cells', this.options.baseUrl), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return null;
      const parsed = CellList.safeParse(await response.json());
      if (!parsed.success) return null;
      this.cells = { value: parsed.data.cells, expiresAt: this.now() + this.options.ttlMs };
      return parsed.data.cells;
    } catch {
      return null;
    }
  }

  /** Always 202 upstream; the list goes by email so nothing leaks about who belongs where. */
  async findWorkspaces(email: string, locale: string | undefined): Promise<boolean> {
    try {
      const response = await this.fetchImpl(
        new URL('/cp/v1/workspaces/find', this.options.baseUrl),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ email, ...(locale ? { locale } : {}) }),
          signal: AbortSignal.timeout(5000),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
