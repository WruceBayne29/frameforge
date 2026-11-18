import { describe, expect, it } from 'vitest';
import { detectSeparator, normaliseHeader, parseCsv, parseNumber } from './csv';

describe('detectSeparator', () => {
  it('prefers tab, then semicolon, then comma, else whitespace', () => {
    expect(detectSeparator('id\tx\ty')).toBe('\t');
    expect(detectSeparator('id;x;y')).toBe(';');
    expect(detectSeparator('id,x,y')).toBe(',');
    expect(detectSeparator('id x y')).toBe(' ');
    // Decimal commas in a semicolon file do not make it comma separated.
    expect(detectSeparator('1;0,5;2,5')).toBe(';');
    // Comments and blank lines before the first data line are skipped.
    expect(detectSeparator('# a, b, c\n\n// x;y\nid;x')).toBe(';');
    // Separators inside quotes do not count.
    expect(detectSeparator('"a,b" c')).toBe(' ');
    expect(detectSeparator('')).toBe(' ');
  });
});

describe('parseCsv', () => {
  it('keeps line numbers and drops comments, blanks and trailing separators', () => {
    const t = parseCsv('id,x\n\n# comment\n1,2,\r\n// note\n3,4');
    expect(t.separator).toBe(',');
    expect(t.rows).toEqual([
      { line: 1, cells: ['id', 'x'] },
      { line: 4, cells: ['1', '2'] },
      { line: 6, cells: ['3', '4'] },
    ]);
  });

  it('reads quoted cells with separators and escaped quotes', () => {
    const t = parseCsv('name,section\n"Beam, roof","ISMB ""300"""\n  "x" ,y');
    expect(t.rows[1].cells).toEqual(['Beam, roof', 'ISMB "300"']);
    expect(t.rows[2].cells).toEqual(['x', 'y']);
  });

  it('splits tab, semicolon and whitespace separated text', () => {
    expect(parseCsv('a\tb\t c').rows[0].cells).toEqual(['a', 'b', 'c']);
    expect(parseCsv('a;b;;c').rows[0].cells).toEqual(['a', 'b', '', 'c']);
    expect(parseCsv('a   b  "c d"  "e ""f"""').rows[0].cells).toEqual(['a', 'b', 'c d', 'e "f"']);
  });
});

describe('parseNumber', () => {
  it('reads plain, signed, exponent and decimal-comma numbers', () => {
    expect(parseNumber('1.5')).toBe(1.5);
    expect(parseNumber(' -2e3 ')).toBe(-2000);
    expect(parseNumber('+.5')).toBe(0.5);
    expect(parseNumber('3.')).toBe(3);
    expect(parseNumber('−4')).toBe(-4);
    expect(parseNumber('1,5', ';')).toBe(1.5);
    expect(parseNumber('1 500', ',')).toBe(1500);
  });

  it('gives NaN for blank or malformed cells', () => {
    expect(parseNumber('')).toBeNaN();
    expect(parseNumber('abc')).toBeNaN();
    expect(parseNumber('1,5', ',')).toBeNaN();
    expect(parseNumber('1.2.3')).toBeNaN();
    expect(parseNumber('0x10')).toBeNaN();
    expect(parseNumber('Infinity')).toBeNaN();
  });
});

describe('normaliseHeader', () => {
  it('keeps lower-case letters and digits, dropping units in brackets', () => {
    expect(normaliseHeader('Node I (m)')).toBe('nodei');
    expect(normaliseHeader('X [mm]')).toBe('x');
    expect(normaliseHeader('node_j')).toBe('nodej');
  });
});
