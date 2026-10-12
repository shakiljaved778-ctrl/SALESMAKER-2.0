import type { Readable } from 'node:stream';

import { parse as parseCsv } from 'csv-parse';
import { strFromU8, unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';

/*
 * Reading import files (§7.1): CSV (streamed, delimiter detected among , ; tab, BOM stripped) and
 * XLSX (sheets listed and read row by row; shared strings, inline strings, booleans, numbers and
 * dates by number format). Every cell comes out as text; types are decided by the mapping.
 */

export type FileType = 'csv' | 'xlsx';

/** Text of a stream, for formats that need the whole file (XLSX is a zip). */
async function bytes(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return new Uint8Array(Buffer.concat(chunks));
}

/** Rows of a CSV file, as text cells, in order (header row included). */
export async function* csvRows(stream: Readable): AsyncGenerator<string[]> {
  const parser = stream.pipe(
    parseCsv({
      bom: true,
      delimiter: [',', ';', '\t'],
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: true,
    }),
  );
  for await (const record of parser) yield (record as string[]).map((c) => c);
}

interface Workbook {
  entries: Record<string, Uint8Array>;
  sheets: { name: string; path: string }[];
  shared: string[];
  dateStyles: Set<number>;
}

/** Events of an XML document, without building a tree. */
function walk(
  xml: string,
  onOpen: (name: string, attrs: Record<string, string>) => void,
  onText: (text: string) => void = () => undefined,
  onClose: (name: string) => void = () => undefined,
) {
  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    // Without namespace processing, attributes are plain strings.
    onOpen(tag.name, { ...tag.attributes });
  });
  parser.on('text', onText);
  parser.on('closetag', (tag) => {
    onClose(tag.name);
  });
  parser.write(xml).close();
}

/** Built-in number formats that are dates (ECMA-376 §18.8.30). */
const BUILT_IN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function openWorkbook(data: Uint8Array): Workbook {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (f) =>
        f.name === 'xl/workbook.xml' ||
        f.name === 'xl/_rels/workbook.xml.rels' ||
        f.name === 'xl/sharedStrings.xml' ||
        f.name === 'xl/styles.xml' ||
        f.name.startsWith('xl/worksheets/'),
    });
  } catch {
    throw new Error('not an XLSX workbook');
  }
  const text = (name: string) => (entries[name] ? strFromU8(entries[name]) : '');
  if (!entries['xl/workbook.xml']) throw new Error('not an XLSX workbook');

  const targets = new Map<string, string>();
  walk(text('xl/_rels/workbook.xml.rels'), (name, a) => {
    if (name === 'Relationship' && a['Id'] && a['Target'])
      targets.set(a['Id'], a['Target'].replace(/^\/?(xl\/)?/, 'xl/'));
  });
  const sheets: Workbook['sheets'] = [];
  walk(text('xl/workbook.xml'), (name, a) => {
    const rel = a['r:id'];
    if (name === 'sheet' && a['name'] && rel && targets.has(rel))
      sheets.push({ name: a['name'], path: targets.get(rel) ?? '' });
  });

  const shared: string[] = [];
  let current: string | null = null;
  let inT = false;
  walk(
    text('xl/sharedStrings.xml'),
    (name) => {
      if (name === 'si') current = '';
      if (name === 't') inT = true;
    },
    (t) => {
      if (inT && current !== null) current += t;
    },
    (name) => {
      if (name === 't') inT = false;
      if (name === 'si') {
        shared.push(current ?? '');
        current = null;
      }
    },
  );

  // Styles whose number format is a date: built-ins, and custom formats with d/m/y but no 0/#.
  const customDates = new Set<number>();
  const dateStyles = new Set<number>();
  let inXfs = false;
  let xf = 0;
  walk(
    text('xl/styles.xml'),
    (name, a) => {
      if (name === 'numFmt') {
        const code = (a['formatCode'] ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
        if (/[dmy]/i.test(code) && !/[0#]/.test(code)) customDates.add(Number(a['numFmtId']));
      }
      if (name === 'cellXfs') inXfs = true;
      if (name === 'xf' && inXfs) {
        const id = Number(a['numFmtId'] ?? 0);
        if (BUILT_IN_DATES.has(id) || customDates.has(id)) dateStyles.add(xf);
        xf += 1;
      }
    },
    undefined,
    (name) => {
      if (name === 'cellXfs') inXfs = false;
    },
  );
  return { entries, sheets, shared, dateStyles };
}

/** An Excel serial day number (1900 system) as `YYYY-MM-DD`, or with a time when it has one. */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

const columnIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** The sheet names of an XLSX file, in workbook order. */
export async function xlsxSheets(stream: Readable): Promise<string[]> {
  return openWorkbook(await bytes(stream)).sheets.map((s) => s.name);
}

/** Rows of one XLSX sheet (the first when none is named), as text cells, gaps filled with ''. */
export async function* xlsxRows(stream: Readable, sheet?: string | null): AsyncGenerator<string[]> {
  const book = openWorkbook(await bytes(stream));
  const target = sheet ? book.sheets.find((s) => s.name === sheet) : book.sheets[0];
  if (!target) throw new Error(`no sheet ${sheet ?? ''}`);
  const data = book.entries[target.path];
  if (!data) throw new Error(`sheet ${target.name} is missing from the workbook`);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell: { col: number; type: string; style: number; value: string } | null = null;
  let inValue = false;
  walk(
    strFromU8(data),
    (name, a) => {
      if (name === 'row') row = [];
      if (name === 'c')
        cell = {
          col: columnIndex(a['r'] ?? 'A'),
          type: a['t'] ?? 'n',
          style: Number(a['s'] ?? 0),
          value: '',
        };
      if (name === 'v' || name === 't') inValue = true;
    },
    (t) => {
      if (inValue && cell) cell.value += t;
    },
    (name) => {
      if (name === 'v' || name === 't') inValue = false;
      if (name === 'c' && cell) {
        const c: { col: number; type: string; style: number; value: string } = cell;
        let text = c.value;
        if (c.type === 's') text = book.shared[Number(c.value)] ?? '';
        else if (c.type === 'b') text = c.value === '1' ? 'true' : 'false';
        else if (c.type === 'n' && c.value !== '' && book.dateStyles.has(c.style))
          text = excelDate(Number(c.value));
        while (row.length < c.col) row.push('');
        row[c.col] = text.trim();
        cell = null;
      }
      if (name === 'row' && row.some((v) => v !== '')) rows.push(row);
    },
  );
  for (const r of rows) yield r;
}

/** Rows of a file of either type. */
export function readRows(
  stream: Readable,
  type: FileType,
  sheet?: string | null,
): AsyncGenerator<string[]> {
  return type === 'csv' ? csvRows(stream) : xlsxRows(stream, sheet);
}
