/**
 * A cell of a CSV file. Text a spreadsheet would run as a formula is given as text.
 * The check looks past leading spaces and control characters, because an importer may drop them first.
 * A number is a number, so a negative one keeps its sign.
 */
export function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value)
  const safe = typeof value !== 'number' && /^[\s\x00-\x1f]*[=+\-@]/.test(text) ? "'" + text : text
  return /[",\n\r]/.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe
}
