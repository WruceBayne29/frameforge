/**
 * Indian standard rolled steel sections — medium-weight beams (ISMB) and channels (ISMC).
 *
 * Dimensions and elastic properties follow IS 808 as tabulated in SP 6(1) (the classic
 * handbook values, e.g. ISMC 200 at 22.1 kg/m). Plastic section moduli follow IS 800:2007
 * Annex H (Table 46). `sections.test.ts` cross-checks every row against idealised-geometry
 * formulas so a mistyped digit cannot slip through unnoticed.
 *
 * Axis convention (IS 800:2007): z-z is the major axis, y-y the minor axis.
 */

export type SectionFamily = 'ISMB' | 'ISMC';

export interface SteelSection {
  /** e.g. 'ISMB 300' */
  designation: string;
  family: SectionFamily;
  /** Mass per metre, kg/m */
  mass: number;
  /** Cross-sectional area, cm² */
  A: number;
  /** Overall depth, mm */
  D: number;
  /** Flange width, mm */
  bf: number;
  /** Flange thickness (mean, for the tapered flange), mm */
  tf: number;
  /** Web thickness, mm */
  tw: number;
  /** Root radius, mm */
  r1: number;
  /** Major-axis second moment of area, cm⁴ */
  Izz: number;
  /** Minor-axis second moment of area, cm⁴ */
  Iyy: number;
  /** Major-axis radius of gyration, cm */
  rzz: number;
  /** Minor-axis radius of gyration, cm */
  ryy: number;
  /** Elastic section modulus, major axis, cm³ */
  Zez: number;
  /** Elastic section modulus, minor axis, cm³ (channels: about the flange toe) */
  Zey: number;
  /** Plastic section modulus, major axis, cm³ */
  Zpz: number;
}

type Row = readonly [
  size: number,
  mass: number,
  A: number,
  bf: number,
  tf: number,
  tw: number,
  r1: number,
  Izz: number,
  Iyy: number,
  rzz: number,
  ryy: number,
  Zez: number,
  Zey: number,
  Zpz: number,
];

// prettier-ignore
const ISMB_ROWS: readonly Row[] = [
  // size  mass     A      bf    tf    tw   r1     Izz      Iyy    rzz    ryy    Zez     Zey     Zpz
  [100,   11.5,  14.60,   75,  7.2,  4.0,  9.0,   257.5,   40.8,  4.20, 1.67,   51.5,  10.9,   58.65],
  [125,   13.0,  16.60,   75,  7.6,  4.4,  9.0,   449.0,   43.7,  5.20, 1.62,   71.8,  11.7,   81.85],
  [150,   14.9,  19.00,   80,  7.6,  4.8,  9.0,   726.4,   52.6,  6.18, 1.66,   96.9,  13.1,  110.48],
  [175,   19.3,  24.62,   90,  8.6,  5.5, 10.0,  1272.0,   85.0,  7.19, 1.86,  145.4,  18.9,  166.08],
  [200,   25.4,  32.33,  100, 10.8,  5.7, 11.0,  2235.4,  150.0,  8.32, 2.15,  223.5,  30.0,  253.86],
  [225,   31.2,  39.72,  110, 11.8,  6.5, 12.0,  3441.8,  218.3,  9.31, 2.34,  305.9,  39.7,  348.27],
  [250,   37.3,  47.55,  125, 12.5,  6.9, 13.0,  5131.6,  334.5, 10.39, 2.65,  410.5,  53.5,  465.71],
  [300,   44.2,  56.26,  140, 12.4,  7.5, 14.0,  8603.6,  453.9, 12.37, 2.84,  573.6,  64.8,  651.74],
  [350,   52.4,  66.71,  140, 14.2,  8.1, 14.0, 13630.3,  537.7, 14.29, 2.84,  778.9,  76.8,  889.57],
  [400,   61.6,  78.46,  140, 16.0,  8.9, 14.0, 20458.4,  622.1, 16.15, 2.82, 1022.9,  88.9, 1176.18],
  [450,   72.4,  92.27,  150, 17.4,  9.4, 15.0, 30390.8,  834.0, 18.15, 3.01, 1350.7, 111.2, 1533.36],
  [500,   86.9, 110.74,  180, 17.2, 10.2, 17.0, 45218.3, 1369.8, 20.21, 3.52, 1808.7, 152.2, 2074.67],
  [550,  103.7, 132.11,  190, 19.3, 11.2, 18.0, 64893.6, 1833.8, 22.16, 3.73, 2359.8, 193.0, 2711.98],
  [600,  122.6, 156.21,  210, 20.8, 12.0, 20.0, 91813.0, 2651.0, 24.24, 4.12, 3060.4, 252.5, 3510.63],
];

// prettier-ignore
const ISMC_ROWS: readonly Row[] = [
  // size  mass     A      bf    tf    tw   r1     Izz      Iyy    rzz    ryy    Zez     Zey     Zpz
  [ 75,    6.8,   8.67,   40,  7.3,  4.4,  8.5,    76.0,   12.6,  2.96, 1.21,   20.3,   4.7,   24.17],
  [100,    9.2,  11.70,   50,  7.5,  4.7,  9.0,   186.7,   25.9,  4.00, 1.49,   37.3,   7.5,   43.83],
  [125,   12.7,  16.19,   65,  8.1,  5.0,  9.5,   416.4,   59.9,  5.07, 1.92,   66.6,  13.1,   77.15],
  [150,   16.4,  20.88,   75,  9.0,  5.4, 10.0,   779.4,  102.3,  6.11, 2.21,  103.9,  19.4,  119.82],
  [175,   19.1,  24.38,   75, 10.2,  5.7, 10.5,  1223.3,  121.0,  7.08, 2.23,  139.8,  22.8,  161.65],
  [200,   22.1,  28.21,   75, 11.4,  6.1, 11.0,  1819.3,  140.4,  8.03, 2.23,  181.9,  26.3,  211.25],
  [225,   25.9,  33.01,   80, 12.4,  6.4, 12.0,  2694.6,  187.2,  9.03, 2.38,  239.5,  32.8,  277.93],
  [250,   30.4,  38.67,   80, 14.1,  7.1, 12.0,  3816.8,  219.1,  9.94, 2.38,  305.3,  38.4,  356.72],
  [300,   35.8,  45.64,   90, 13.6,  7.6, 13.0,  6362.6,  310.8, 11.81, 2.61,  424.2,  46.8,  496.77],
  [350,   42.1,  53.66,  100, 13.5,  8.1, 14.0, 10008.0,  430.6, 13.66, 2.83,  571.9,  57.0,  672.19],
  [400,   49.4,  62.93,  100, 15.3,  8.6, 15.0, 15082.8,  504.8, 15.48, 2.83,  754.1,  66.6,  891.03],
];

function build(family: SectionFamily, rows: readonly Row[]): SteelSection[] {
  return rows.map(
    ([size, mass, A, bf, tf, tw, r1, Izz, Iyy, rzz, ryy, Zez, Zey, Zpz]): SteelSection => ({
      designation: `${family} ${size}`,
      family,
      mass,
      A,
      D: size,
      bf,
      tf,
      tw,
      r1,
      Izz,
      Iyy,
      rzz,
      ryy,
      Zez,
      Zey,
      Zpz,
    }),
  );
}

/** All sections, ISMB first then ISMC, each family in order of increasing depth. */
export const SECTIONS: readonly SteelSection[] = Object.freeze(
  [...build('ISMB', ISMB_ROWS), ...build('ISMC', ISMC_ROWS)].map((s) => Object.freeze(s)),
);

const BY_DESIGNATION: ReadonlyMap<string, SteelSection> = new Map(
  SECTIONS.map((s) => [normalise(s.designation), s]),
);

/** 'ismb300', ' ISMB  300 ' and 'ISMB 300' all resolve to the same key. */
function normalise(designation: string): string {
  return designation.replace(/\s+/g, '').toUpperCase();
}

/** Look a section up by designation (case- and whitespace-insensitive). */
export function getSection(designation: string): SteelSection | undefined {
  return BY_DESIGNATION.get(normalise(designation));
}

/** Sections of one family, in order of increasing depth. Returns a fresh array. */
export function sectionsByFamily(family: SectionFamily): SteelSection[] {
  return SECTIONS.filter((s) => s.family === family);
}
