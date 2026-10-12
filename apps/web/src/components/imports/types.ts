import type {
  CreateImportResponse,
  ImportAnalysisDto,
  ImportColumnMapping,
  ImportJobDto,
  ImportRowDto,
} from '@sm/contracts';
import type { z } from 'zod';

export type ImportJob = z.infer<typeof ImportJobDto>;
export type ImportAnalysis = z.infer<typeof ImportAnalysisDto>;
export type ColumnMapping = z.infer<typeof ImportColumnMapping>;
export type Created = z.infer<typeof CreateImportResponse>;
export type ImportRow = z.infer<typeof ImportRowDto>;
export interface NamedRule {
  id: string;
  name: string;
  object: string;
  active?: boolean;
}

/** Objects with an import wizard (§7.1); the API decides who may use it. */
export const IMPORTABLE = new Set(['lead', 'account', 'contact']);

/** Field types the mapping step offers transforms for. */
export const DATE_TYPES = new Set(['date', 'datetime']);
export const PICKLIST_TYPES = new Set(['picklist', 'multi_picklist']);

export const fileTypeOf = (name: string): 'csv' | 'xlsx' | null =>
  /\.csv$/i.test(name) ? 'csv' : /\.xlsx$/i.test(name) ? 'xlsx' : null;

/** Statuses after which the job only changes on its own (worker) or by undo. */
export const STARTED = new Set(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'UNDOING', 'UNDONE']);

/**
 * PUT the file to its pre-signed URL (§3.12), reporting progress. Resolves with the HTTP status
 * (0 when the request could not be made).
 */
export function uploadFile(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      resolve(xhr.status);
    };
    xhr.onerror = () => {
      resolve(0);
    };
    xhr.send(file);
  });
}

/** A job status as its message key (`imports.status.*`). */
export const statusKey = (status: ImportJob['status']) =>
  status.toLowerCase() as Lowercase<ImportJob['status']>;
