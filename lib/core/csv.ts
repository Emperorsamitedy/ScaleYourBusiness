// Shared, dependency-free CSV cell encoding: RFC 4180 quoting plus the
// OWASP CSV/formula-injection guard (a leading =, +, -, @, tab or CR is
// prefixed with ' so a spreadsheet reads it as text, never a formula).
// Pure on purpose — every CSV export in the app, server-side or
// client-bundled, uses this one function instead of re-implementing it.

/** A plain number ("-12.50", "0.750") is data, not a formula, and stays readable as one. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
/** What a spreadsheet would start evaluating (OWASP CSV injection), tab and CR included. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Pure: one CSV cell, neutralised against formula injection and quoted as needed. */
export function csvCell(raw: string): string {
  const safe = FORMULA_START.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
