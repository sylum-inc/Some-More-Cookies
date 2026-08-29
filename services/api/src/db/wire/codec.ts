/**
 * Text-format parameter encoding and result decoding.
 *
 * Everything goes over the wire in the text format. That is a deliberate
 * simplification: binary format would save a little parsing, but it would also
 * mean a hand-written codec per type, and this service's hot path is JSONB
 * documents and short text ids where the difference is noise.
 */

/** The handful of OIDs worth decoding into something other than a string. */
const OID = {
  bool: 16,
  int8: 20,
  int2: 21,
  int4: 23,
  json: 114,
  float4: 700,
  float8: 701,
  numeric: 1700,
  jsonb: 3802,
  textArray: 1009,
} as const;

export type SqlParameter =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | Buffer
  | readonly string[]
  | Record<string, unknown>;

function escapeArrayElement(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Encode one bound parameter as PostgreSQL text, or `null` for SQL NULL. */
export function encodeParameter(value: SqlParameter): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : value < 0 ? '-Infinity' : 'NaN';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (Array.isArray(value)) return `{${value.map((item) => escapeArrayElement(String(item))).join(',')}}`;
  return JSON.stringify(value);
}

/** Decode one result cell from its text representation, using the column OID. */
export function decodeValue(oid: number, raw: string): unknown {
  switch (oid) {
    case OID.bool:
      return raw === 't';
    case OID.int2:
    case OID.int4:
      return Number.parseInt(raw, 10);
    case OID.int8: {
      const asNumber = Number(raw);
      return Number.isSafeInteger(asNumber) ? asNumber : raw;
    }
    case OID.float4:
    case OID.float8:
    case OID.numeric:
      return Number(raw);
    case OID.json:
    case OID.jsonb:
      return JSON.parse(raw) as unknown;
    case OID.textArray:
      return parseTextArray(raw);
    default:
      return raw;
  }
}

/** Minimal one-dimensional `text[]` literal parser. */
export function parseTextArray(raw: string): string[] {
  if (!raw.startsWith('{') || !raw.endsWith('}')) return [];
  const body = raw.slice(1, -1);
  if (body.length === 0) return [];
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}
