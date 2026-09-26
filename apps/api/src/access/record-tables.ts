/**
 * Where an object's records live. Standard objects get tables named after them in P02 and custom
 * objects share custom_record; until then no table exists and every record lookup is a 404. Tests
 * inject fixture tables with the §4.1 columns (tenant_id, id, owner_id, …).
 */
export type RecordTables = (object: string) => string;

export const defaultRecordTables: RecordTables = (object) => object;
