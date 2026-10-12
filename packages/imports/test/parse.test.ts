import { Readable } from 'node:stream';

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { csvRows, excelDate, xlsxRows, xlsxSheets } from '../src/index.js';

const stream = (data: string | Uint8Array) => Readable.from([Buffer.from(data)]);
const all = async (rows: AsyncGenerator<string[]>) => {
  const out: string[][] = [];
  for await (const r of rows) out.push(r);
  return out;
};

/** A small workbook written by hand: two sheets, shared and inline strings, a date, a boolean. */
function workbook(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(
      '<workbook xmlns:r="r"><sheets><sheet name="Notes" r:id="rId2"/><sheet name="Leads" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    ),
    'xl/sharedStrings.xml': strToU8(
      '<sst><si><t>Name</t></si><si><t>Joined</t></si><si><r><t>Gulf </t></r><r><t>Trading</t></r></si></sst>',
    ),
    'xl/styles.xml': strToU8(
      '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Active</t></is></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>46307</v></c><c r="C2" s="2"><v>1234.5</v></c><c r="D2" t="b"><v>1</v></c></row>' +
        '<row r="3"></row>' +
        '</sheetData></worksheet>',
    ),
    'xl/worksheets/sheet2.xml': strToU8(
      '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>note</v></c></row></sheetData></worksheet>',
    ),
  });
}

describe('reading files (§7.1)', () => {
  it('reads CSV with any common delimiter, a BOM and quoted fields', async () => {
    expect(await all(csvRows(stream('﻿Name;City\n"Haddad, Omar";Doha\n\nChen;"Dubai"\n')))).toEqual(
      [
        ['Name', 'City'],
        ['Haddad, Omar', 'Doha'],
        ['Chen', 'Dubai'],
      ],
    );
    expect(await all(csvRows(stream('a\tb\n1\t2\n')))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('lists XLSX sheets and reads one: shared, rich and inline strings, dates, numbers, booleans', async () => {
    expect(await xlsxSheets(stream(workbook()))).toEqual(['Notes', 'Leads']);
    expect(await all(xlsxRows(stream(workbook()), 'Leads'))).toEqual([
      ['Name', 'Joined', '', 'Active'],
      ['Gulf Trading', '2026-10-12', '1234.5', 'true'],
    ]);
    // The first sheet when none is named.
    expect(await all(xlsxRows(stream(workbook())))).toEqual([['note']]);
    await expect(all(xlsxRows(stream(workbook()), 'Nope'))).rejects.toThrow('no sheet Nope');
    await expect(xlsxSheets(stream(zipSync({ 'a.txt': strToU8('x') })))).rejects.toThrow(
      'not an XLSX',
    );
  });

  it('turns Excel serial days into dates', () => {
    expect(excelDate(46307)).toBe('2026-10-12');
    expect(excelDate(46307.5)).toBe('2026-10-12 12:00:00');
  });
});
