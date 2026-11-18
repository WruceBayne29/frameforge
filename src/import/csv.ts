/**
 * Splitting delimited text (CSV and its relatives) into rows of cells, as other programs and
 * spreadsheets write it: comma, tab, semicolon or whitespace separated, with optional
 * "quoted" cells (`""` inside quotes is a literal quote). Blank lines and lines starting with
 * `#` or `//` are skipped. Every row keeps its 1-based line number in the source text so
 * problems can be reported where they are.
 */

export type Separator = ',' | '\t' | ';' | ' ';

export interface CsvRow {
  /** 1-based line number in the text. */
  line: number;
  cells: string[];
}

export interface CsvTable {
  separator: Separator;
  rows: CsvRow[];
}

const isComment = (line: string) => {
  const t = line.trim();
  return t === '' || t.startsWith('#') || t.startsWith('//');
};

/** Counts `char` outside double quotes. */
function countOutsideQuotes(line: string, char: string): number {
  let quoted = false;
  let n = 0;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === char && !quoted) n++;
  }
  return n;
}

/**
 * Picks the separator from the first data line: tab, then semicolon, then comma, whichever
 * occurs (tabs and semicolons win because spreadsheets that use them may write decimal
 * commas); a line with none of them is whitespace separated.
 */
export function detectSeparator(text: string): Separator {
  const first = text.split(/\r\n|\n|\r/).find((l) => !isComment(l)) ?? '';
  if (countOutsideQuotes(first, '\t') > 0) return '\t';
  const semicolons = countOutsideQuotes(first, ';');
  const commas = countOutsideQuotes(first, ',');
  if (semicolons > 0 && semicolons >= commas) return ';';
  if (commas > 0) return ',';
  return ' ';
}

function splitLine(line: string, separator: Separator): string[] {
  if (separator === ' ') {
    // Whitespace separated: runs of spaces/tabs are one separator; quotes still group.
    const cells: string[] = [];
    const re = /"((?:[^"]|"")*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) cells.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]);
    return cells;
  }
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (quoted) {
      if (c === '"' && line[k + 1] === '"') {
        cell += '"';
        k++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (c === separator) {
      cells.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

/** Splits delimited text into rows (comments and blank lines dropped). */
export function parseCsv(text: string, separator: Separator = detectSeparator(text)): CsvTable {
  const rows: CsvRow[] = [];
  text.split(/\r\n|\n|\r/).forEach((raw, k) => {
    if (isComment(raw)) return;
    const cells = splitLine(raw, separator);
    // A trailing separator (common in exports) leaves an empty last cell.
    while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
    rows.push({ line: k + 1, cells });
  });
  return { separator, rows };
}

/**
 * Reads a number written by a person or a program: `1.5`, `-2e3`, `1,5` (decimal comma, only
 * when the separator is not a comma) and `1 500` are fine; anything else is NaN. An empty cell
 * is NaN too, so callers decide what blank means.
 */
export function parseNumber(cell: string, separator: Separator = ','): number {
  let t = cell.trim().replace(/[−–]/g, '-');
  if (t === '') return NaN;
  if (separator !== ',' && /^[-+]?\d+,\d+([eE][-+]?\d+)?$/.test(t)) t = t.replace(',', '.');
  if (separator !== ' ') t = t.replace(/(\d)[ \u00a0](?=\d{3}\b)/g, '$1');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return NaN;
  return Number(t);
}

/** Lower-case letters and digits only: "Node I (m)" → "nodei", "X [mm]" → "x". */
export function normaliseHeader(cell: string): string {
  return cell
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
