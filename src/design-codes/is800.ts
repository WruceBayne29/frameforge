/**
 * IS 800:2007 (limit state method) member check for rolled ISMB / ISMC sections under
 * axial force, major-axis bending and shear.
 *
 * Units: forces in kN, moments in kN·m, lengths in m at the API boundary; everything is
 * converted to N / mm / MPa internally.
 *
 * Scope and assumptions (each is repeated next to the code it affects):
 *  - Net area An = gross area Ag in tension (no bolt holes are modelled).
 *  - Bending about the major (z-z) axis only; no minor-axis moment.
 *  - The web is classified with the Table 2 limits for bending (neutral axis at mid-depth)
 *    for I-sections and with the 42ε limit for channels.
 *  - Lateral-torsional buckling uses the simplified doubly-symmetric expression of
 *    cl. 8.2.2.1. It is applied to channels as well, which is an approximation.
 *  - Slender sections are evaluated with the semi-compact formulas and flagged by a warning.
 *  - Shear buckling of the web (cl. 8.4.2) is not checked; no ISMB/ISMC web is slender
 *    enough to need it for the standard grades.
 */

import type { SteelSection } from './sections';

export interface SteelGrade {
  name: string;
  /** Yield stress, MPa */
  fy: number;
  /** Ultimate tensile stress, MPa */
  fu: number;
}

/** IS 2062 grades (fy for thickness < 20 mm). */
export const STEEL_GRADES: readonly SteelGrade[] = Object.freeze(
  [
    { name: 'E250', fy: 250, fu: 410 },
    { name: 'E300', fy: 300, fu: 440 },
    { name: 'E350', fy: 350, fu: 490 },
    { name: 'E410', fy: 410, fu: 540 },
    { name: 'E450', fy: 450, fu: 570 },
  ].map((g) => Object.freeze(g)),
);

export interface DesignInput {
  section: SteelSection;
  grade: SteelGrade;
  /** Young's modulus, MPa (default 200000) */
  E?: number;
  /** Member length, m */
  length: number;
  /** Axial force, kN — tension positive, compression negative (governing value) */
  axial: number;
  /** Maximum |major-axis moment| along the member, kN·m */
  moment: number;
  /** Maximum |shear|, kN */
  shear: number;
  /** Effective length factor, major-axis (z-z) buckling (default 1.0) */
  kz?: number;
  /** Effective length factor, minor-axis (y-y) buckling (default 1.0) */
  ky?: number;
  /** Compression flange restrained, so no lateral-torsional buckling (default false) */
  laterallyRestrained?: boolean;
  /** Effective length factor for lateral-torsional buckling (default 1.0) */
  kLT?: number;
  /** Equivalent uniform moment factor Cmz = CmLT (default 0.9) */
  cm?: number;
}

export type SectionClass = 'plastic' | 'compact' | 'semi-compact' | 'slender';

export interface CheckLine {
  id: string;
  name: string;
  clause: string;
  demand: number;
  capacity: number;
  ratio: number;
  unit: string;
  ok: boolean;
}

export interface DesignResult {
  sectionClass: SectionClass;
  epsilon: number;
  /** KL/r about the major axis */
  slendernessZ: number;
  /** KL/r about the minor axis */
  slendernessY: number;
  /** Design capacities, kN and kN·m */
  capacities: {
    /** Tension (cl. 6.2) */
    Td: number;
    /** Compression, buckling about z-z (cl. 7.1.2) */
    Pdz: number;
    /** Compression, buckling about y-y (cl. 7.1.2) */
    Pdy: number;
    /** Compression, min(Pdz, Pdy) */
    Pd: number;
    /** Governing bending capacity: LTB-reduced (cl. 8.2.2) unless laterally restrained */
    Md: number;
    /**
     * Section moment capacity without LTB (cl. 8.2.1.2), including the high-shear reduction
     * of cl. 9.2.2 when V > 0.6 Vd.
     */
    Mdz: number;
    /** Shear (cl. 8.4) */
    Vd: number;
  };
  checks: CheckLine[];
  /** Maximum ratio over all checks (0 when nothing is loaded) */
  utilisation: number;
  /** id of the governing check, or 'none' when there are no checks */
  governing: string;
  ok: boolean;
  warnings: string[];
}

/** Partial safety factor, resistance governed by yielding / buckling (Table 5). */
const GAMMA_M0 = 1.1;
/** Partial safety factor, resistance governed by ultimate stress (Table 5). */
const GAMMA_M1 = 1.25;
/** Imperfection factor for lateral-torsional buckling of rolled sections (cl. 8.2.2). */
const ALPHA_LT = 0.21;
/** Demands smaller than this (kN or kN·m) are treated as zero — solver round-off. */
const LOAD_EPS = 1e-6;
/** Table 3 maximum effective slenderness ratios. */
const MAX_SLENDERNESS_COMPRESSION = 180;
const MAX_SLENDERNESS_TENSION = 400;

const CLASS_ORDER: readonly SectionClass[] = ['plastic', 'compact', 'semi-compact', 'slender'];

/** Class for a width/thickness ratio given the plastic / compact / semi-compact limits. */
function classFromLimits(
  ratio: number,
  plastic: number,
  compact: number,
  semiCompact: number,
): SectionClass {
  if (ratio <= plastic) return 'plastic';
  if (ratio <= compact) return 'compact';
  if (ratio <= semiCompact) return 'semi-compact';
  return 'slender';
}

/**
 * Section classification, IS 800:2007 Table 2. The class is the worse of the flange
 * outstand and the web.
 *
 *  - Flange outstand of a rolled section: b/tf ≤ 9.4ε / 10.5ε / 15.7ε, with b = bf/2 for an
 *    I-section and b = bf for a channel.
 *  - I-section web (d = D − 2(tf + r1)): d/tw ≤ 84ε / 105ε / 126ε.
 *  - Channel web: Table 2 gives only the single limit d/tw ≤ 42ε, so a channel web is
 *    treated as plastic up to 42ε and slender beyond it.
 */
export function classifySection(section: SteelSection, fy: number): SectionClass {
  const eps = Math.sqrt(250 / fy);
  const isChannel = section.family === 'ISMC';

  const b = isChannel ? section.bf : section.bf / 2;
  const flange = classFromLimits(b / section.tf, 9.4 * eps, 10.5 * eps, 15.7 * eps);

  const d = section.D - 2 * (section.tf + section.r1);
  const web = isChannel
    ? classFromLimits(d / section.tw, 42 * eps, 42 * eps, 42 * eps)
    : classFromLimits(d / section.tw, 84 * eps, 105 * eps, 126 * eps);

  return CLASS_ORDER[Math.max(CLASS_ORDER.indexOf(flange), CLASS_ORDER.indexOf(web))];
}

/**
 * Imperfection factors α for flexural buckling, Tables 7 and 10.
 *  - Rolled I, D/bf > 1.2 (tf ≤ 40 mm): z-z curve a (0.21), y-y curve b (0.34).
 *  - Rolled I, D/bf ≤ 1.2 (tf ≤ 100 mm): z-z curve b (0.34), y-y curve c (0.49).
 *  - Channels: curve c (0.49) about both axes.
 * No ISMB/ISMC flange exceeds 40 mm, so the thick-flange rows are not needed.
 */
function imperfectionFactors(section: SteelSection): { z: number; y: number } {
  if (section.family === 'ISMC') return { z: 0.49, y: 0.49 };
  return section.D / section.bf > 1.2 ? { z: 0.21, y: 0.34 } : { z: 0.34, y: 0.49 };
}

/**
 * Buckling stress reduction factor χ = 1 / (φ + sqrt(φ² − λ²)) ≤ 1 with
 * φ = 0.5·[1 + α(λ − 0.2) + λ²]. Shared by cl. 7.1.2.1 (columns) and cl. 8.2.2 (LTB).
 */
function reductionFactor(lambda: number, alpha: number): number {
  const phi = 0.5 * (1 + alpha * (lambda - 0.2) + lambda * lambda);
  return Math.min(1 / (phi + Math.sqrt(phi * phi - lambda * lambda)), 1);
}

function requireFinite(name: string, value: number, min: number, exclusive = false): void {
  if (!Number.isFinite(value) || value < min || (exclusive && value === min)) {
    throw new RangeError(
      `checkMember: ${name} must be a finite number ${exclusive ? '>' : '≥'} ${min}, got ${value}`,
    );
  }
}

function makeLine(
  id: string,
  name: string,
  clause: string,
  demand: number,
  capacity: number,
  unit: string,
): CheckLine {
  const ratio = demand / capacity;
  return {
    id,
    name,
    clause: `IS 800 cl. ${clause}`,
    demand,
    capacity,
    ratio,
    unit,
    ok: ratio <= 1,
  };
}

/**
 * IS 800:2007 limit-state check of one member. Only the checks relevant to the supplied
 * actions are emitted (e.g. a tie gets no compression checks, a truss member no bending
 * checks), and an unloaded member returns utilisation 0 with no checks.
 *
 * @throws RangeError for non-finite or out-of-range inputs.
 */
export function checkMember(input: DesignInput): DesignResult {
  const { section, grade } = input;
  const E = input.E ?? 200000;
  const kz = input.kz ?? 1;
  const ky = input.ky ?? 1;
  const kLT = input.kLT ?? 1;
  const laterallyRestrained = input.laterallyRestrained ?? false;
  // Cl. 9.3.2.2 / Table 18 bounds the equivalent uniform moment factor below by 0.4, which
  // also keeps (CmLT − 0.25) safely positive. Values above 1 are not meaningful.
  const cm = Math.min(Math.max(input.cm ?? 0.9, 0.4), 1);

  requireFinite('grade.fy', grade.fy, 0, true);
  requireFinite('grade.fu', grade.fu, 0, true);
  requireFinite('E', E, 0, true);
  requireFinite('length', input.length, 0);
  requireFinite('kz', kz, 0);
  requireFinite('ky', ky, 0);
  requireFinite('kLT', kLT, 0);
  requireFinite('axial', input.axial, -Infinity);
  requireFinite('moment', input.moment, -Infinity);
  requireFinite('shear', input.shear, -Infinity);

  const { fy, fu } = grade;
  const warnings: string[] = [];

  // --- Section properties in N-mm units ---------------------------------------------------
  const A = section.A * 100; // mm²
  const Ze = section.Zez * 1e3; // mm³
  const Zp = section.Zpz * 1e3; // mm³
  const Iy = section.Iyy * 1e4; // mm⁴
  const rz = section.rzz * 10; // mm
  const ry = section.ryy * 10; // mm
  const L = input.length * 1000; // mm

  // --- Actions ----------------------------------------------------------------------------
  const T = input.axial > LOAD_EPS ? input.axial : 0; // kN, tension
  const P = input.axial < -LOAD_EPS ? -input.axial : 0; // kN, compression
  const M = Math.abs(input.moment) > LOAD_EPS ? Math.abs(input.moment) : 0; // kN·m
  const V = Math.abs(input.shear) > LOAD_EPS ? Math.abs(input.shear) : 0; // kN

  // --- Classification (Table 2) -----------------------------------------------------------
  const epsilon = Math.sqrt(250 / fy);
  const sectionClass = classifySection(section, fy);
  const plasticOrCompact = sectionClass === 'plastic' || sectionClass === 'compact';
  if (sectionClass === 'slender') {
    warnings.push(
      `${section.designation} is a slender section for fy = ${fy} MPa (IS 800 Table 2); ` +
        'capacities are computed with the semi-compact formulas and may be unconservative.',
    );
  }

  // --- Tension (cl. 6.2) ------------------------------------------------------------------
  // Assumption: no bolt holes, so the net area An equals the gross area Ag.
  const Tdg = (A * fy) / GAMMA_M0; // N, gross-section yielding (cl. 6.2)
  const Tdn = (0.9 * A * fu) / GAMMA_M1; // N, net-section rupture (cl. 6.3.1)
  const Td = Math.min(Tdg, Tdn) / 1e3; // kN

  // --- Compression (cl. 7.1.2) ------------------------------------------------------------
  const slendernessZ = (kz * L) / rz;
  const slendernessY = (ky * L) / ry;
  const alpha = imperfectionFactors(section);
  const eulerFactor = Math.sqrt(fy / (Math.PI * Math.PI * E)); // λ = (KL/r)·sqrt(fy / π²E)
  const lambdaZ = slendernessZ * eulerFactor;
  const lambdaY = slendernessY * eulerFactor;
  const Pdz = (A * reductionFactor(lambdaZ, alpha.z) * fy) / GAMMA_M0 / 1e3; // kN
  const Pdy = (A * reductionFactor(lambdaY, alpha.y) * fy) / GAMMA_M0 / 1e3; // kN
  const Pd = Math.min(Pdz, Pdy);
  /** Section (squash) capacity in compression, Nd of cl. 9.3.1.1. */
  const Nd = Tdg / 1e3; // kN

  // --- Shear (cl. 8.4) --------------------------------------------------------------------
  const Av = section.D * section.tw; // mm², rolled section, major-axis bending (cl. 8.4.1.1)
  const Vd = (Av * fy) / (Math.sqrt(3) * GAMMA_M0) / 1e3; // kN

  // --- Bending, laterally supported (cl. 8.2.1.2) -----------------------------------------
  const betaB = plasticOrCompact ? 1 : Ze / Zp;
  const MdCap = (1.2 * Ze * fy) / GAMMA_M0; // N·mm, limit for simply supported beams
  let MdSection = Math.min((betaB * Zp * fy) / GAMMA_M0, MdCap); // N·mm

  // High shear (cl. 9.2.2): V > 0.6 Vd reduces the plastic moment capacity towards that of
  // the flanges alone. Semi-compact sections keep Ze·fy/γm0, which MdSection already is.
  if (V > 0.6 * Vd && plasticOrCompact) {
    // β is capped at 1 so that a section already failing in shear (V > Vd) is not pushed
    // below the flange-only capacity.
    const beta = Math.min((2 * (V / Vd) - 1) ** 2, 1);
    const Mfd = (section.bf * section.tf * (section.D - section.tf) * fy) / GAMMA_M0; // N·mm
    MdSection = Math.min(MdSection - beta * Math.max(MdSection - Mfd, 0), MdCap);
  }
  const Mdz = MdSection / 1e6; // kN·m

  // --- Bending, laterally unsupported (cl. 8.2.2) -----------------------------------------
  let lambdaLT = 0;
  let Md = Mdz;
  const LLT = kLT * L;
  if (!laterallyRestrained && LLT > 0) {
    // Elastic critical moment, simplified expression of cl. 8.2.2.1 for doubly symmetric
    // I-sections (also applied to channels as an approximation).
    const hf = section.D - section.tf; // mm, centre-to-centre of flanges
    const slendernessRatio = LLT / ry / (hf / section.tf);
    const Mcr =
      ((Math.PI * Math.PI * E * Iy * hf) / (2 * LLT * LLT)) *
      Math.sqrt(1 + (slendernessRatio * slendernessRatio) / 20); // N·mm
    lambdaLT = Math.min(Math.sqrt((betaB * Zp * fy) / Mcr), Math.sqrt((1.2 * Ze * fy) / Mcr));
    // λLT ≤ 0.4: no allowance for LTB is needed (cl. 8.2.2); otherwise apply χLT.
    const chiLT = lambdaLT <= 0.4 ? 1 : reductionFactor(lambdaLT, ALPHA_LT);
    Md = Math.min(Mdz, (betaB * Zp * chiLT * fy) / GAMMA_M0 / 1e6); // kN·m
  }

  // --- Checks -----------------------------------------------------------------------------
  const checks: CheckLine[] = [];

  if (T > 0) {
    checks.push(makeLine('tension', 'Axial tension', '6.2', T, Td, 'kN'));
    if (Math.max(slendernessZ, slendernessY) > MAX_SLENDERNESS_TENSION) {
      warnings.push(
        `Slenderness KL/r = ${Math.max(slendernessZ, slendernessY).toFixed(0)} exceeds ` +
          `${MAX_SLENDERNESS_TENSION} for a tension member (IS 800 Table 3).`,
      );
    }
  }

  if (P > 0) {
    checks.push(
      makeLine('compression', 'Axial compression (flexural buckling)', '7.1.2', P, Pd, 'kN'),
    );
    if (Math.max(slendernessZ, slendernessY) > MAX_SLENDERNESS_COMPRESSION) {
      warnings.push(
        `Slenderness KL/r = ${Math.max(slendernessZ, slendernessY).toFixed(0)} exceeds ` +
          `${MAX_SLENDERNESS_COMPRESSION} for a compression member (IS 800 Table 3).`,
      );
    }
  }

  if (V > 0) {
    checks.push(makeLine('shear', 'Shear', '8.4', V, Vd, 'kN'));
  }

  if (M > 0) {
    checks.push(
      laterallyRestrained
        ? makeLine('bending', 'Bending (laterally supported)', '8.2.1.2', M, Md, 'kN·m')
        : makeLine('bending', 'Bending (lateral-torsional buckling)', '8.2.2', M, Md, 'kN·m'),
    );
    if (!laterallyRestrained && section.family === 'ISMC') {
      warnings.push(
        'Lateral-torsional buckling of a channel is estimated with the doubly-symmetric ' +
          'I-section formula (IS 800 cl. 8.2.2.1); torsion from shear-centre eccentricity ' +
          'is not considered.',
      );
    }
  }

  if (M > 0 && (T > 0 || P > 0)) {
    // Section strength, cl. 9.3.1.1 (conservative linear form): N/Nd + Mz/Mdz ≤ 1.
    const axialRatio = T > 0 ? T / Td : P / Nd;
    checks.push(
      makeLine(
        'interaction-section',
        'Combined axial force + bending (section strength)',
        '9.3.1.1',
        axialRatio + M / Mdz,
        1,
        '-',
      ),
    );
  }

  if (M > 0 && P > 0) {
    // Overall member strength, cl. 9.3.2.2 (bending about z-z only).
    const nz = P / Pdz;
    const ny = P / Pdy;
    const Kz = Math.min(1 + (lambdaZ - 0.2) * nz, 1 + 0.8 * nz);
    const KLT = Math.max(1 - (0.1 * lambdaLT * ny) / (cm - 0.25), 1 - (0.1 * ny) / (cm - 0.25));
    checks.push(
      makeLine(
        'buckling-y',
        'Combined compression + bending (minor-axis and lateral-torsional buckling)',
        '9.3.2.2',
        ny + (KLT * M) / Md,
        1,
        '-',
      ),
      makeLine(
        'buckling-z',
        'Combined compression + bending (major-axis buckling)',
        '9.3.2.2',
        nz + (Kz * cm * M) / Md,
        1,
        '-',
      ),
    );
  }

  if (M > 0 && T > 0) {
    // Overall member strength, cl. 9.3.2.1. The code permits a reduced effective moment
    // Meff = M − ψ·T·Zec/A; the linear sum with the LTB-reduced Md is the conservative form.
    checks.push(
      makeLine(
        'tension-bending',
        'Combined tension + bending (member strength)',
        '9.3.2.1',
        T / Td + M / Md,
        1,
        '-',
      ),
    );
  }

  let utilisation = 0;
  let governing = 'none';
  for (const check of checks) {
    if (check.ratio > utilisation || governing === 'none') {
      utilisation = check.ratio;
      governing = check.id;
    }
  }

  return {
    sectionClass,
    epsilon,
    slendernessZ,
    slendernessY,
    capacities: { Td, Pdz, Pdy, Pd, Md, Mdz, Vd },
    checks,
    utilisation,
    governing,
    ok: checks.every((c) => c.ok),
    warnings,
  };
}
