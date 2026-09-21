/**
 * RFC 8785 (JCS) canonical JSON.
 *
 * Signing raw JSON bytes is the usual way signature verification breaks in the field:
 * re-serialising with a different key order or whitespace invalidates a valid document.
 * Canonicalising first makes verification independent of serialisation.
 */
export function canonicalize(value: unknown): string {
  return ser(value);
}

function ser(v: unknown): string {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    const n = v as number;
    if (!Number.isFinite(n)) throw new Error('Cannot canonicalize non-finite number');
    // RFC 8785 requires ECMAScript Number::toString, which JSON.stringify produces.
    return JSON.stringify(n);
  }
  if (t === 'string') return serString(v as string);
  if (Array.isArray(v)) return `[${v.map(ser).join(',')}]`;
  if (t === 'object') {
    const o = v as Record<string, unknown>;
    // Sort by UTF-16 code units, per RFC 8785.
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${serString(k)}:${ser(o[k])}`).join(',')}}`;
  }
  throw new Error(`Cannot canonicalize value of type ${t}`);
}

function serString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    switch (ch) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\b': out += '\\b'; break;
      case '\f': out += '\\f'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      default:
        out += c < 0x20 ? `\\u${c.toString(16).padStart(4, '0')}` : ch;
    }
  }
  return out + '"';
}
