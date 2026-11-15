// Test helper: translates the small BigQuery subset used in sql/ into DuckDB SQL, so the
// views can be checked locally against the same demo data. The .sql files themselves stay
// pure BigQuery dialect; this file is never used in production.
//
// Handles: DATE_SUB / DATE_ADD with INTERVAL n DAY, DATE_DIFF(a, b, DAY), SAFE_DIVIDE,
// COUNTIF, and the INT64 / FLOAT64 / NUMERIC type names.

function splitArgs(s) {
  const args = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

// Replace every call NAME(...) (case-insensitive, balanced parens) using fn(args).
function rewriteCalls(sql, name, fn) {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'i');
  let out = '';
  let rest = sql;
  let m;
  while ((m = re.exec(rest))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < rest.length && depth; i++) {
      if (rest[i] === '(') depth++;
      if (rest[i] === ')') depth--;
    }
    const inner = rest.slice(start, i - 1);
    out += rest.slice(0, m.index) + fn(splitArgs(rewriteCalls(inner, name, fn)));
    rest = rest.slice(i);
  }
  return out + rest;
}

const intervalDays = (arg) => {
  const m = arg.match(/^INTERVAL\s+(.+)\s+DAY$/i);
  if (!m) throw new Error(`Unsupported interval: ${arg}`);
  return m[1];
};

export function bqToDuckdb(sql) {
  let s = sql.replace(/--[^\n]*/g, '');
  s = rewriteCalls(s, 'DATE_SUB', ([d, iv]) => `CAST((${d}) - to_days(CAST(${intervalDays(iv)} AS INTEGER)) AS DATE)`);
  s = rewriteCalls(s, 'DATE_ADD', ([d, iv]) => `CAST((${d}) + to_days(CAST(${intervalDays(iv)} AS INTEGER)) AS DATE)`);
  s = rewriteCalls(s, 'DATE_DIFF', ([a, b, part]) => {
    if (!/^DAY$/i.test(part)) throw new Error('DATE_DIFF only supports DAY here');
    return `date_diff('day', ${b}, ${a})`;
  });
  s = rewriteCalls(s, 'SAFE_DIVIDE', ([a, b]) => `(CASE WHEN (${b}) = 0 THEN NULL ELSE (${a}) / (${b}) END)`);
  s = rewriteCalls(s, 'COUNTIF', ([c]) => `count_if(${c})`);
  s = s.replace(/\bINT64\b/g, 'BIGINT').replace(/\bFLOAT64\b/g, 'DOUBLE').replace(/\bNUMERIC\b/g, 'DOUBLE');
  return s;
}

/** Split a .sql file into statements on semicolons at the end of a line. */
export function statements(sql) {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((x) => x.trim())
    .filter((x) => x.replace(/--[^\n]*/g, '').trim());
}
