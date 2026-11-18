/**
 * Importing a STAAD.Pro input file (.std). STAAD is what most Indian engineering students use,
 * so a frame modelled there can be checked or explored here. Only the parts of the command
 * language that describe a frame or truss and one load case are read:
 *
 *  - STAAD SPACE / PLANE / TRUSS, SET Z UP, UNIT (any time; values are converted as read)
 *  - JOINT COORDINATES with generation (`i1 x1 y1 z1 i2 x2 y2 z2 i3`), REPEAT and REPEAT ALL
 *  - MEMBER INCIDENCES with generation (`i1 i2 i3 i4 i5 i6`), REPEAT and REPEAT ALL
 *  - START / END GROUP DEFINITION (groups can then be used in lists)
 *  - DEFINE MATERIAL, CONSTANTS (E, POISSON, DENSITY, BETA, MATERIAL)
 *  - MEMBER PROPERTY: TABLE ST ISMB… / ISMC… (built-in table), PRIS YD ZD (rectangle),
 *    PRIS YD (circle) and PRIS AX IX IY IZ
 *  - MEMBER RELEASE, MEMBER TRUSS
 *  - SUPPORTS: FIXED, PINNED, FIXED BUT …
 *  - LOAD n with JOINT LOAD, MEMBER LOAD (UNI, CON, CMOM, LIN, TRAP in X/Y/Z, GX/GY/GZ and
 *    PX/PY/PZ) and SELFWEIGHT
 *
 * Anything else (plates, design parameters, load combinations, analysis commands, …) is
 * listed as a warning; it never stops the import.
 *
 * Axes: STAAD's default global axes are Y up, like FrameForge. A file with SET Z UP is
 * rotated so that its Z becomes FrameForge's Y: (X, Y, Z) → (X, Z, −Y).
 */
import { getSection } from '../design-codes';
import type {
  CustomSection3D,
  EndRelease,
  GlobalDirection,
  Material3D,
  MemberLoadDirection,
  Project3D,
  ProjectLoad3D,
  ProjectMember3D,
  Restraints6,
} from '../model3d/types';
import { DEFAULT_SECTION_3D, emptyProject3D } from '../model3d/types';
import type { ImportIssue, ImportResult, PlaneOption } from './common';
import { finishProject, rolledSectionName, uniqueName } from './common';

export interface StaadImportOptions {
  /** Number of the primary load case to import (default: the first one in the file). */
  loadCase?: number;
  /** Overrides the plane-frame choice (default: plane frame for STAAD PLANE). */
  plane?: PlaneOption;
  name?: string;
}

export interface StaadLoadCase {
  number: number;
  title: string;
}

export interface StaadImportResult extends ImportResult {
  /** Primary load cases found in the file. */
  loadCases: StaadLoadCase[];
  /** The load case that was imported (undefined when the file has none). */
  loadCase?: number;
}

/** Metres per STAAD length unit. */
const LENGTH_UNITS: Record<string, number> = {
  INCH: 0.0254,
  INCHES: 0.0254,
  IN: 0.0254,
  FEET: 0.3048,
  FOOT: 0.3048,
  FT: 0.3048,
  CM: 0.01,
  CMS: 0.01,
  MM: 0.001,
  MMS: 0.001,
  METER: 1,
  METERS: 1,
  METRE: 1,
  METRES: 1,
  MET: 1,
  M: 1,
  KM: 1000,
  DME: 0.1,
};

/** Kilonewtons per STAAD force unit. */
const FORCE_UNITS: Record<string, number> = {
  KIP: 4.4482216,
  KIPS: 4.4482216,
  POUND: 0.0044482216,
  POUNDS: 0.0044482216,
  LB: 0.0044482216,
  LBS: 0.0044482216,
  KG: 0.00980665,
  KGS: 0.00980665,
  MTON: 9.80665,
  MTONS: 9.80665,
  NEWTON: 0.001,
  NEWTONS: 0.001,
  N: 0.001,
  KN: 1,
  KNS: 1,
  DNS: 0.01,
  MNS: 1000,
};

/** STAAD's built-in materials, in kN and m (E kN/m², density kN/m³). */
const BUILT_IN_MATERIALS: Record<string, { E: number; nu: number; density: number }> = {
  STEEL: { E: 2.05e8, nu: 0.3, density: 76.8195 },
  CONCRETE: { E: 2.17185e7, nu: 0.17, density: 23.5616 },
  ALUMINUM: { E: 6.89476e7, nu: 0.33, density: 26.6018 },
  ALUMINIUM: { E: 6.89476e7, nu: 0.33, density: 26.6018 },
};

interface Statement {
  line: number;
  tokens: string[];
  up: string[];
}

/** Lines → statements: drops `*` comments, joins `-` continuations, splits on `;`. */
function statements(text: string): Statement[] {
  const out: Statement[] = [];
  let pending = '';
  let pendingLine = 0;
  text.split(/\r\n|\n|\r/).forEach((raw, k) => {
    const line = raw.replace(/\t/g, ' ');
    if (!pending && /^\s*\*/.test(line)) return;
    if (!pending) pendingLine = k + 1;
    const cont = /(^|\s)-\s*$/.test(line);
    pending += ' ' + (cont ? line.replace(/-\s*$/, '') : line);
    if (cont) return;
    for (const part of pending.split(';')) {
      const tokens = part
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .flatMap(expandRepeat);
      if (tokens.length > 0)
        out.push({ line: pendingLine, tokens, up: tokens.map((t) => t.toUpperCase()) });
    }
    pending = '';
  });
  return out;
}

/** `15*0` → fifteen zeros (STAAD's shorthand for repeated values). */
function expandRepeat(token: string): string[] {
  const m = /^(\d+)\*([-+]?[\d.]+(?:[eE][-+]?\d+)?)$/.exec(token);
  if (!m) return [token];
  return Array.from({ length: Math.min(Number(m[1]), 10000) }, () => m[2]);
}

const isNumber = (t: string | undefined) =>
  t !== undefined && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t);
const isInteger = (t: string | undefined) => t !== undefined && /^\d+$/.test(t);

type Block =
  | 'none'
  | 'joints'
  | 'members'
  | 'groups'
  | 'material'
  | 'constants'
  | 'property'
  | 'release'
  | 'truss'
  | 'supports'
  | 'load'
  | 'jointLoad'
  | 'memberLoad'
  | 'skip'
  | 'skipToEnd';

const CONSTANT_KEYS = new Set([
  'E',
  'DENSITY',
  'POISSON',
  'BETA',
  'MATERIAL',
  'G',
  'ALPHA',
  'DAMP',
  'CDAMP',
]);
const MATERIAL_KEYS = new Set([
  'ISOTROPIC',
  'E',
  'POISSON',
  'DENSITY',
  'ALPHA',
  'DAMP',
  'G',
  'TYPE',
  'STRENGTH',
  'CDAMP',
]);
const DOF_NAMES = ['FX', 'FY', 'FZ', 'MX', 'MY', 'MZ'] as const;

interface MemberLoadRecord {
  line: number;
  members: string[];
  type: string;
  dir: string;
  values: number[];
  /** Force and length units in force at the time the line was read. */
  F: number;
  L: number;
}

/** Imports the text of a STAAD.Pro .std file. */
export function importStaad(text: string, options: StaadImportOptions = {}): StaadImportResult {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const warned = new Set<string>();
  const warnOnce = (key: string, line: number, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push({ line, message });
  };
  const fail = (line: number | undefined, message: string) =>
    errors.push(line === undefined ? { message } : { line, message });

  let kind: 'SPACE' | 'PLANE' | 'TRUSS' | 'FLOOR' | null = null;
  let title = '';
  let zUp = false;
  let L = 1; // metres per current length unit
  let F = 1; // kN per current force unit
  let unitSeen = false;

  // Raw model in STAAD's own axes and kN, m.
  const joints = new Map<number, [number, number, number]>();
  const jointOrder: number[] = [];
  let lastJointLine: number[] = [];
  let jointAllStart = 0;
  const members = new Map<number, [number, number]>();
  const memberOrder: number[] = [];
  let lastMemberLine: number[] = [];
  let memberAllStart = 0;
  const groups = new Map<string, number[]>();
  let groupKind: 'JOINT' | 'MEMBER' = 'MEMBER';

  interface MatProps {
    E?: number;
    nu?: number;
    density?: number;
  }
  const materials = new Map<string, MatProps>();
  for (const [name, m] of Object.entries(BUILT_IN_MATERIALS)) materials.set(name, { ...m });
  let currentMaterial: string | null = null;
  const memberMat = new Map<number, MatProps & { name?: string }>();
  const memberBeta = new Map<number, number>();
  const memberSection = new Map<number, { name: string; custom?: CustomSection3D }>();
  const memberRelease = new Map<number, { i: EndRelease; j: EndRelease }>();
  const trussMembers = new Set<number>();
  const supports = new Map<number, Restraints6>();

  const loadCases: StaadLoadCase[] = [];
  let currentCase: number | null = null;
  let wanted = options.loadCase;
  const jointLoads: Array<{ line: number; joints: number[]; values: number[] }> = [];
  const memberLoads: MemberLoadRecord[] = [];
  const selfWeights: Array<{
    line: number;
    dir: string;
    factor: number;
    members: number[] | null;
  }> = [];
  const inWantedCase = () => currentCase !== null && currentCase === wanted;

  /** Reads a list (`1 2 5 TO 9 BY 2`, `ALL`, `_GROUP`) starting at `k`. */
  function readList(
    st: Statement,
    k: number,
    all: () => number[],
  ): { ids: number[]; next: number } {
    const ids: number[] = [];
    while (k < st.up.length) {
      const t = st.up[k];
      if (isInteger(t)) {
        ids.push(Number(t));
        k++;
      } else if (t === 'TO' && ids.length > 0 && isInteger(st.up[k + 1])) {
        const from = ids[ids.length - 1];
        const to = Number(st.up[k + 1]);
        let step = 1;
        k += 2;
        if (st.up[k] === 'BY' && isInteger(st.up[k + 1])) {
          step = Math.max(1, Number(st.up[k + 1]));
          k += 2;
        }
        if (to - from > 1e6) {
          fail(st.line, 'A list range is too long.');
          break;
        }
        for (let n = from + step; n <= to; n += step) ids.push(n);
      } else if (t === 'ALL') {
        ids.push(...all());
        k++;
      } else if (t.startsWith('_') && groups.has(t)) {
        ids.push(...(groups.get(t) ?? []));
        k++;
      } else break;
    }
    return { ids, next: k };
  }
  const allMembers = () => [...memberOrder];
  const allJoints = () => [...jointOrder];

  const num = (st: Statement, k: number): number => (isNumber(st.up[k]) ? Number(st.up[k]) : NaN);

  function addJoint(st: Statement, id: number, xyz: [number, number, number]): void {
    if (!joints.has(id)) jointOrder.push(id);
    else
      warnOnce(`joint-again-${id}`, st.line, `Joint ${id} is defined twice; the last one is used.`);
    joints.set(id, xyz);
  }

  function addMember(st: Statement, id: number, i: number, j: number): void {
    if (!members.has(id)) memberOrder.push(id);
    else
      warnOnce(
        `member-again-${id}`,
        st.line,
        `Member ${id} is defined twice; the last one is used.`,
      );
    members.set(id, [i, j]);
  }

  /** Increment sets of a REPEAT: a zero set (or a missing one) repeats the previous set. */
  function increments(values: number[], n: number, width: number): number[][] {
    const sets: number[][] = [];
    let last = new Array(width).fill(0);
    for (let k = 0; k < n; k++) {
      const set = values.slice(k * width, k * width + width);
      if (set.length === width && set.some((v) => v !== 0)) last = set;
      sets.push(last);
    }
    return sets;
  }

  function jointLine(st: Statement): void {
    if (st.up[0] === 'REPEAT') {
      const all = st.up[1] === 'ALL';
      const start = all ? 2 : 1;
      const n = Number(st.up[start]);
      if (!isInteger(st.up[start])) {
        fail(st.line, 'REPEAT needs a number of repetitions.');
        return;
      }
      const values = st.up.slice(start + 1).map(Number);
      if (values.some((v) => !Number.isFinite(v))) {
        fail(st.line, 'REPEAT increments must be numbers.');
        return;
      }
      const source = all ? jointOrder.slice(jointAllStart) : lastJointLine;
      const sets = increments(
        values.map((v) => v * L),
        n,
        3,
      );
      let offset = [0, 0, 0];
      for (let r = 0; r < n; r++) {
        offset = offset.map((o, a) => o + sets[r][a]);
        let next = Math.max(0, ...jointOrder) + 1;
        for (const id of source) {
          const p = joints.get(id) as [number, number, number];
          addJoint(st, next++, [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]]);
        }
      }
      if (all) jointAllStart = jointOrder.length;
      return;
    }
    const v = st.up.map(Number);
    if (v.some((x) => !Number.isFinite(x))) {
      fail(st.line, 'A joint line must contain only numbers.');
      return;
    }
    const at = (k: number): [number, number, number] => [
      v[k + 1] * L,
      v[k + 2] * L,
      (v.length === 3 ? 0 : v[k + 3]) * L,
    ];
    const created: number[] = [];
    if (v.length === 3 || v.length === 4) {
      addJoint(st, v[0], at(0));
      created.push(v[0]);
    } else if (v.length === 8 || v.length === 9) {
      const [i1, i2] = [v[0], v[4]];
      const step = v.length === 9 ? v[8] : 1;
      if (!(step > 0) || i2 <= i1 || (i2 - i1) % step !== 0 || (i2 - i1) / step > 1e5) {
        fail(st.line, 'Joint generation needs i2 > i1 and an increment that divides i2 − i1.');
        return;
      }
      const a = at(0);
      const b = at(4);
      const count = (i2 - i1) / step;
      for (let s = 0; s <= count; s++) {
        const t = s / count;
        addJoint(st, i1 + s * step, [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ]);
        created.push(i1 + s * step);
      }
    } else {
      fail(
        st.line,
        'A joint line needs: number x y z (or a generation: i1 x1 y1 z1 i2 x2 y2 z2 [step]).',
      );
      return;
    }
    lastJointLine = created;
  }

  function memberLine(st: Statement): void {
    if (st.up[0] === 'REPEAT') {
      const all = st.up[1] === 'ALL';
      const s = all ? 2 : 1;
      const [n, mi, ji] = [Number(st.up[s]), Number(st.up[s + 1] ?? 0), Number(st.up[s + 2] ?? 0)];
      if (![n, mi, ji].every(Number.isInteger)) {
        fail(st.line, 'REPEAT needs: n, member increment, joint increment.');
        return;
      }
      const source = all ? memberOrder.slice(memberAllStart) : lastMemberLine;
      for (let r = 1; r <= n; r++) {
        for (const id of source) {
          const [i, j] = members.get(id) as [number, number];
          addMember(st, id + r * mi, i + r * ji, j + r * ji);
        }
      }
      if (all) memberAllStart = memberOrder.length;
      return;
    }
    const v = st.up.map(Number);
    if (v.length < 3 || v.length > 6 || !v.every(Number.isInteger)) {
      fail(
        st.line,
        'A member line needs: number start-joint end-joint (or a generation i1 i2 i3 i4 [i5 i6]).',
      );
      return;
    }
    const [id, i, j] = v;
    const last = v[3] ?? id;
    const mStep = v[4] ?? 1;
    const jStep = v[5] ?? 1;
    if (!(mStep > 0) || last < id || (last - id) / mStep > 1e5) {
      fail(st.line, 'Member generation needs a last member number above the first.');
      return;
    }
    const created: number[] = [];
    for (let s = 0; id + s * mStep <= last; s++) {
      addMember(st, id + s * mStep, i + s * jStep, j + s * jStep);
      created.push(id + s * mStep);
    }
    lastMemberLine = created;
  }

  /** Target list after a constant's value: `ALL`, `MEMB list`, `MEMBER list`, `BEAM`, `list`. */
  function constantTargets(st: Statement, k: number): number[] {
    const t = st.up[k];
    if (t === undefined) {
      warnOnce(
        `const-target-${st.line}`,
        st.line,
        `"${st.tokens.join(' ')}" has no member list; ALL is assumed.`,
      );
      return allMembers();
    }
    if (t === 'BEAM' || t === 'MEMBERS') return allMembers();
    if (t === 'PLATE' || t === 'SOLID' || t === 'ELEMENT') return [];
    if (t === 'MEMB' || t === 'MEMBER') k++;
    const { ids, next } = readList(st, k, allMembers);
    if (next < st.up.length)
      warnOnce(
        `const-extra-${st.line}`,
        st.line,
        `Part of "${st.tokens.join(' ')}" was not understood.`,
      );
    return ids;
  }

  function constantsLine(st: Statement): void {
    const key = st.up[0];
    const value = st.up[1];
    if (key === 'MATERIAL') {
      const props = materials.get(value);
      if (!props) {
        fail(st.line, `Material ${st.tokens[1]} is not defined.`);
        return;
      }
      for (const id of constantTargets(st, 2))
        memberMat.set(id, { ...memberMat.get(id), ...props, name: value });
      return;
    }
    if (key === 'E' || key === 'POISSON' || key === 'DENSITY') {
      const prop = key === 'E' ? 'E' : key === 'POISSON' ? 'nu' : 'density';
      let v: number | undefined;
      let name: string | undefined;
      if (isNumber(value)) {
        const n = Number(value);
        v = key === 'E' ? (n * F) / L ** 2 : key === 'DENSITY' ? (n * F) / L ** 3 : n;
      } else if (materials.has(value)) {
        v = materials.get(value)?.[prop];
        name = value;
      } else {
        fail(st.line, `${key} needs a value or a defined material name.`);
        return;
      }
      for (const id of constantTargets(st, 2)) {
        const m = { ...memberMat.get(id), [prop]: v };
        // A numeric E makes the member's material its own; ν and density keep the name.
        if (key === 'E') {
          if (name) m.name = name;
          else delete m.name;
        }
        memberMat.set(id, m);
      }
      return;
    }
    if (key === 'BETA') {
      if (!isNumber(value)) {
        warnOnce(
          `beta-${st.line}`,
          st.line,
          `BETA ${st.tokens[1] ?? ''} is not supported (only an angle in degrees).`,
        );
        return;
      }
      for (const id of constantTargets(st, 2)) memberBeta.set(id, Number(value));
      return;
    }
    warnOnce(`const-${key}`, st.line, `CONSTANTS ${key} is not used by FrameForge.`);
  }

  function materialLine(st: Statement): void {
    const key = st.up[0];
    if (key === 'ISOTROPIC') {
      currentMaterial = st.up[1] ?? null;
      if (currentMaterial) materials.set(currentMaterial, {});
      return;
    }
    const m = currentMaterial ? materials.get(currentMaterial) : undefined;
    if (!m) return;
    const v = num(st, 1);
    if (key === 'E' && Number.isFinite(v)) m.E = (v * F) / L ** 2;
    else if (key === 'POISSON' && Number.isFinite(v)) m.nu = v;
    else if (key === 'DENSITY' && Number.isFinite(v)) m.density = (v * F) / L ** 3;
  }

  const sectionNames = new Set<string>();
  const customSections: CustomSection3D[] = [];
  const customByKey = new Map<string, CustomSection3D>();
  function custom(
    name: string,
    A: number,
    Iz: number,
    Iy: number,
    J: number,
  ): { name: string; custom: CustomSection3D } {
    const key = [A, Iz, Iy, J].map((x) => x.toPrecision(10)).join('|');
    const found = customByKey.get(key);
    if (found) return { name: found.name, custom: found };
    const section = { name: uniqueName(name, sectionNames), A, Iz, Iy, J };
    customByKey.set(key, section);
    customSections.push(section);
    return { name: section.name, custom: section };
  }

  /** Rectangle b (along local z) × d (along local y): cm², cm⁴. */
  function rectangle(d: number, b: number) {
    const [long, short] = d >= b ? [d, b] : [b, d];
    const r = short / long;
    const J = long * short ** 3 * (1 / 3 - 0.21 * r * (1 - r ** 4 / 12));
    return {
      A: d * b * 1e4,
      Iz: ((b * d ** 3) / 12) * 1e8,
      Iy: ((d * b ** 3) / 12) * 1e8,
      J: J * 1e8,
    };
  }

  const fmt = (m: number) => `${+(m * 1000).toFixed(1)}`;

  function propertyLine(st: Statement): void {
    const { ids, next } = readList(st, 0, allMembers);
    if (ids.length === 0) {
      warnOnce(`prop-${st.line}`, st.line, `"${st.tokens.join(' ')}" was not understood.`);
      return;
    }
    const type = st.up[next] ?? '';
    let assigned: { name: string; custom?: CustomSection3D };
    if (type === 'TABLE' || type === 'TA') {
      const spec = st.up[next + 1];
      // "ISMB300", or "ISMB 300" split over two tokens.
      const raw = [st.tokens[next + 2] ?? '', isInteger(st.up[next + 3]) ? st.tokens[next + 3] : '']
        .join(' ')
        .trim();
      const rolled = spec === 'ST' ? rolledSectionName(raw) : undefined;
      if (rolled) assigned = { name: rolled };
      else {
        warnings.push({
          line: st.line,
          message:
            spec === 'ST'
              ? `Section ${raw} is not in FrameForge's table (ISMB / ISMC); those members use ${DEFAULT_SECTION_3D} — change it after importing.`
              : `TABLE ${spec ?? ''} sections are not supported; those members use ${DEFAULT_SECTION_3D} — change it after importing.`,
        });
        assigned = { name: DEFAULT_SECTION_3D };
      }
    } else if (type.startsWith('PRI')) {
      const p: Record<string, number> = {};
      for (let k = next + 1; k + 1 < st.up.length; k += 2) {
        const v = Number(st.up[k + 1]);
        if (!Number.isFinite(v)) {
          fail(st.line, `PRIS value ${st.up[k]} must be a number.`);
          return;
        }
        p[st.up[k]] = v;
      }
      const len = (key: string) => (p[key] !== undefined ? p[key] * L : undefined);
      const [YD, ZD] = [len('YD'), len('ZD')];
      if (p.YB !== undefined || p.ZB !== undefined) {
        warnOnce(
          `pris-tee-${st.line}`,
          st.line,
          'PRIS YB / ZB (T-shapes and trapezoids) are not supported; the rectangle YD × ZD is used.',
        );
      }
      let props: { A: number; Iz: number; Iy: number; J: number } | null = null;
      let name = 'PRIS';
      if (p.AX !== undefined) {
        const A = p.AX * L ** 2 * 1e4;
        const fill = (key: string, estimate: number) => {
          if (p[key] !== undefined) return p[key] * L ** 4 * 1e8;
          warnOnce(
            `pris-${key}-${st.line}`,
            st.line,
            `PRIS AX without ${key}: ${key} is estimated as for a solid square of the same area.`,
          );
          return estimate;
        };
        props = {
          A,
          Iz: fill('IZ', A ** 2 / 12),
          Iy: fill('IY', A ** 2 / 12),
          J: fill('IX', 0.141 * A ** 2),
        };
        name = 'Prismatic';
      } else if (YD !== undefined && ZD !== undefined) {
        props = rectangle(YD, ZD);
        name = `Rect ${fmt(YD)}x${fmt(ZD)}`;
      } else if (YD !== undefined) {
        const d = YD;
        props = {
          A: ((Math.PI * d ** 2) / 4) * 1e4,
          Iz: ((Math.PI * d ** 4) / 64) * 1e8,
          Iy: ((Math.PI * d ** 4) / 64) * 1e8,
          J: ((Math.PI * d ** 4) / 32) * 1e8,
        };
        name = `Circle ${fmt(d)}`;
      }
      if (!props) {
        fail(st.line, 'PRIS needs YD (and ZD), or AX with IX, IY and IZ.');
        return;
      }
      // Explicit values override the computed ones.
      if (p.AX === undefined) {
        if (p.IZ !== undefined) props.Iz = p.IZ * L ** 4 * 1e8;
        if (p.IY !== undefined) props.Iy = p.IY * L ** 4 * 1e8;
        if (p.IX !== undefined) props.J = p.IX * L ** 4 * 1e8;
      }
      if (!(props.A > 0 && props.Iz > 0 && props.Iy > 0 && props.J > 0)) {
        fail(st.line, 'PRIS section properties must be positive.');
        return;
      }
      assigned = custom(name, props.A, props.Iz, props.Iy, props.J);
    } else {
      warnings.push({
        line: st.line,
        message: `Member property "${st.tokens.slice(next).join(' ')}" is not supported; those members use ${DEFAULT_SECTION_3D}.`,
      });
      assigned = { name: DEFAULT_SECTION_3D };
    }
    for (const id of ids) memberSection.set(id, assigned);
  }

  function releaseLine(st: Statement): void {
    const { ids, next } = readList(st, 0, allMembers);
    const where = st.up[next];
    if (!['START', 'END', 'BOTH'].includes(where)) {
      warnOnce(`rel-${st.line}`, st.line, `Release "${st.tokens.join(' ')}" was not understood.`);
      return;
    }
    const release: EndRelease = {};
    for (const t of st.up.slice(next + 1)) {
      const dof = DOF_NAMES.find((d) => d === t);
      if (dof) release[dof.toLowerCase() as keyof EndRelease] = true;
      else {
        warnOnce(
          `rel-part-${st.line}`,
          st.line,
          `Partial or spring releases ("${t}") are not supported and are ignored.`,
        );
        break;
      }
    }
    for (const id of ids) {
      const r = memberRelease.get(id) ?? { i: {}, j: {} };
      if (where !== 'END') r.i = { ...r.i, ...release };
      if (where !== 'START') r.j = { ...r.j, ...release };
      memberRelease.set(id, r);
    }
  }

  /** Global DOF index (STAAD axes) of FX…MZ. */
  function supportLine(st: Statement): void {
    const { ids, next } = readList(st, 0, allJoints);
    const type = st.up[next];
    let restraints: Restraints6;
    if (type === 'FIXED') {
      restraints = [true, true, true, true, true, true];
      if (st.up[next + 1] === 'BUT') {
        for (let k = next + 2; k < st.up.length; k++) {
          const t = st.up[k];
          const dof = DOF_NAMES.indexOf(t as (typeof DOF_NAMES)[number]);
          if (dof >= 0) restraints[dof] = false;
          else if (/^K[FM][XYZ]$/.test(t)) {
            warnOnce(
              `spring-${st.line}`,
              st.line,
              `Spring supports (${t}) are not supported; that direction is left free.`,
            );
            restraints[DOF_NAMES.indexOf(t.slice(1) as (typeof DOF_NAMES)[number])] = false;
            k++;
          } else if (!isNumber(t))
            warnOnce(`but-${st.line}`, st.line, `"${t}" in FIXED BUT is not supported.`);
        }
      }
    } else if (type === 'PINNED') restraints = [true, true, true, false, false, false];
    else {
      warnOnce(
        `support-${type}`,
        st.line,
        `Support type "${st.tokens.slice(next).join(' ')}" is not supported.`,
      );
      return;
    }
    for (const id of ids) supports.set(id, restraints);
  }

  function jointLoadLine(st: Statement): void {
    const { ids, next } = readList(st, 0, allJoints);
    const values = [0, 0, 0, 0, 0, 0];
    for (let k = next; k < st.up.length; k += 2) {
      const dof = DOF_NAMES.indexOf(st.up[k] as (typeof DOF_NAMES)[number]);
      const v = num(st, k + 1);
      if (dof < 0 || !Number.isFinite(v)) {
        fail(st.line, `Joint load "${st.tokens.slice(k).join(' ')}" was not understood.`);
        return;
      }
      values[dof] += v * (dof < 3 ? F : F * L);
    }
    if (ids.length > 0) jointLoads.push({ line: st.line, joints: ids, values });
  }

  function memberLoadLine(st: Statement): void {
    const { ids, next } = readList(st, 0, allMembers);
    const type = st.up[next];
    const dir = st.up[next + 1];
    const values = st.up.slice(next + 2).map(Number);
    if (!type || !dir || values.some((v) => !Number.isFinite(v))) {
      fail(st.line, `Member load "${st.tokens.join(' ')}" was not understood.`);
      return;
    }
    memberLoads.push({ line: st.line, members: ids.map(String), type, dir, values, F, L });
  }

  function selfWeightLine(st: Statement): void {
    let dir = 'Y';
    let factor = -1;
    let k = 1;
    if (['X', 'Y', 'Z'].includes(st.up[1])) {
      dir = st.up[1];
      k = 2;
    }
    if (isNumber(st.up[k])) factor = Number(st.up[k++]);
    let list: number[] | null = null;
    if (k < st.up.length) {
      if (st.up[k] === 'LIST') k++;
      list = readList(st, k, allMembers).ids;
    }
    selfWeights.push({ line: st.line, dir, factor, members: list });
  }

  // ---- the command loop ----
  let block: Block = 'none';
  let skipEnd = '';
  const loadSubBlock = (st: Statement, b: Block): Block => {
    if (currentCase !== null) return b;
    warnOnce(
      `outside-${st.line}`,
      st.line,
      `"${st.tokens.slice(0, 2).join(' ')}" outside a LOAD case is ignored.`,
    );
    return 'skip';
  };

  for (const st of statements(text)) {
    const [a, b] = st.up;
    if (block === 'skipToEnd') {
      if (a === 'END' && (!skipEnd || b === skipEnd)) block = 'none';
      continue;
    }
    if (a === 'UNIT' || a === 'UNITS') {
      for (const t of st.up.slice(1)) {
        if (LENGTH_UNITS[t] !== undefined) L = LENGTH_UNITS[t];
        else if (FORCE_UNITS[t] !== undefined) F = FORCE_UNITS[t];
        else warnOnce(`unit-${t}`, st.line, `Unit "${t}" is not known.`);
      }
      unitSeen = true;
      continue;
    }
    // Block data first, so that e.g. "E 2.05e8 ALL" is a constant rather than a command.
    if (block === 'constants' && CONSTANT_KEYS.has(a)) {
      constantsLine(st);
      continue;
    }
    if (block === 'material' && MATERIAL_KEYS.has(a)) {
      materialLine(st);
      continue;
    }
    if (
      block === 'groups' &&
      (a === 'JOINT' || a === 'MEMBER' || a === 'GEOMETRY' || a === 'ELEMENT' || a === 'SOLID')
    ) {
      groupKind = a === 'JOINT' ? 'JOINT' : 'MEMBER';
      continue;
    }
    if (block === 'groups' && a.startsWith('_')) {
      const all = groupKind === 'JOINT' ? allJoints : allMembers;
      groups.set(a, readList(st, 1, all).ids);
      continue;
    }
    const data =
      isInteger(a) || a === 'REPEAT' || a === 'ALL' || (a.startsWith('_') && groups.has(a));
    if (data && block !== 'none' && block !== 'skip') {
      switch (block) {
        case 'joints':
          jointLine(st);
          break;
        case 'members':
          memberLine(st);
          break;
        case 'property':
          propertyLine(st);
          break;
        case 'release':
          releaseLine(st);
          break;
        case 'truss':
          for (const id of readList(st, 0, allMembers).ids) trussMembers.add(id);
          break;
        case 'supports':
          supportLine(st);
          break;
        case 'jointLoad':
          if (inWantedCase()) jointLoadLine(st);
          break;
        case 'memberLoad':
          if (inWantedCase()) memberLoadLine(st);
          break;
        default:
          warnOnce(`data-${st.line}`, st.line, `"${st.tokens.join(' ')}" was not understood here.`);
      }
      continue;
    }
    if (data && block === 'skip') continue;

    // Commands.
    if (a === 'STAAD') {
      if (b === 'SPACE' || b === 'PLANE' || b === 'TRUSS' || b === 'FLOOR') kind = b;
      title = st.tokens.slice(2).join(' ');
      if (b === 'FLOOR')
        warnOnce('floor', st.line, 'STAAD FLOOR is analysed as a space structure.');
      block = 'none';
    } else if (a === 'SET') {
      if (b === 'Z' && st.up[2] === 'UP') {
        if (joints.size > 0)
          warnOnce('zup-late', st.line, 'SET Z UP after the joints have been read is ignored.');
        else zUp = true;
      }
    } else if (a === 'JOINT' && b?.startsWith('COORD')) {
      if (st.up.includes('CYLINDRICAL')) {
        warnOnce('cyl', st.line, 'Cylindrical joint coordinates are not supported.');
        block = 'skip';
      } else block = 'joints';
    } else if (a === 'MEMBER' && b?.startsWith('INCI')) block = 'members';
    else if (a === 'MEMBER' && b?.startsWith('PROP')) block = 'property';
    else if (a === 'MEMBER' && b?.startsWith('REL')) block = 'release';
    else if (a === 'MEMBER' && b === 'TRUSS') block = 'truss';
    else if (a === 'MEMBER' && b === 'LOAD') block = loadSubBlock(st, 'memberLoad');
    else if (a === 'JOINT' && b?.startsWith('LOAD')) block = loadSubBlock(st, 'jointLoad');
    else if (a === 'START' && b === 'GROUP') block = 'groups';
    else if (a === 'START') {
      block = 'skipToEnd';
      skipEnd = b ?? '';
    } else if (a === 'DEFINE' && b === 'MATERIAL') block = 'material';
    else if (a === 'END') block = 'none';
    else if (a.startsWith('CONSTANT')) block = 'constants';
    else if (a === 'SUPPORTS' || a === 'SUPPORT') block = 'supports';
    else if (a === 'LOAD' && (b === 'COMB' || b === 'COMBINATION')) {
      warnOnce(
        'comb',
        st.line,
        'Load combinations are not imported (FrameForge analyses one load case).',
      );
      block = 'skip';
    } else if (a === 'LOAD' && b === 'LIST') block = 'skip';
    else if (a === 'LOAD' && isInteger(b)) {
      const n = Number(b);
      const t = st.up.indexOf('TITLE');
      loadCases.push({ number: n, title: t >= 0 ? st.tokens.slice(t + 1).join(' ') : '' });
      currentCase = n;
      wanted ??= n;
      block = 'load';
    } else if (a === 'SELFWEIGHT' || a === 'SELF') {
      if (inWantedCase()) selfWeightLine(st);
      block = currentCase === null ? 'none' : 'load';
    } else if (
      a === 'PERFORM' ||
      a === 'FINISH' ||
      a === 'PRINT' ||
      a === 'INPUT' ||
      a === 'PAGE' ||
      a === 'PDELTA' ||
      a === 'ANALYSIS'
    ) {
      block = 'skip';
    } else if (['PARAMETER', 'PARAMETERS', 'CODE', 'CHECK', 'SELECT', 'DESIGN'].includes(a)) {
      warnOnce(
        'design',
        st.line,
        'Design commands (PARAMETER, CHECK CODE, SELECT …) are ignored; use the Design tab instead.',
      );
      block = 'skip';
    } else if (block === 'skip' && !isKnownCommand(a)) {
      // Data of an unsupported command.
    } else {
      const what = st.tokens.slice(0, 2).join(' ');
      const inLoad =
        currentCase !== null && ['load', 'jointLoad', 'memberLoad', 'skip'].includes(block);
      if (!inLoad || inWantedCase()) {
        warnOnce(
          `cmd-${st.up.slice(0, 2).join(' ')}`,
          st.line,
          `"${what}" is not supported and is ignored.`,
        );
      }
      block = 'skip';
    }
  }

  if (!kind)
    warnings.unshift({
      message: 'No STAAD SPACE / PLANE / TRUSS line found; read as a space frame.',
    });
  if (!unitSeen)
    warnings.unshift({ message: 'No UNIT command found; values are read as metres and kN.' });

  // ---- build the project ----
  const map = (p: [number, number, number]): [number, number, number] =>
    zUp ? [p[0], p[2], p[1] === 0 ? 0 : -p[1]] : p;
  const project: Project3D = emptyProject3D(options.name?.trim() || title.trim() || 'STAAD model');
  if (title.trim()) project.description = `Imported from STAAD.Pro: ${title.trim()}`;
  else project.description = 'Imported from STAAD.Pro';
  project.nodes = jointOrder.map((id) => {
    const [x, y, z] = map(joints.get(id) as [number, number, number]);
    return { id: String(id), x, y, z };
  });

  // Materials: one per distinct (E, ν, density), named after the STAAD material when known.
  const materialList: Material3D[] = [];
  const materialKey = new Map<string, string>();
  const takenMaterials = new Set<string>();
  let noE = 0;
  const memberMaterial = (id: number): string => {
    let m = memberMat.get(id) ?? {};
    if (m.E === undefined) {
      noE++;
      m = {
        ...BUILT_IN_MATERIALS.STEEL,
        ...m,
        E: BUILT_IN_MATERIALS.STEEL.E,
        name: m.name ?? 'STEEL',
      };
    }
    const nu = m.nu ?? 0.3;
    const density = m.density ?? 0;
    const E = (m.E as number) * 1e-6; // kN/m² → GPa
    const key = [E, nu, density].map((v) => v.toPrecision(10)).join('|');
    const found = materialKey.get(key);
    if (found) return found;
    const base = m.name
      ? m.name.charAt(0) + m.name.slice(1).toLowerCase()
      : `E ${+E.toPrecision(4)} GPa`;
    const name = uniqueName(base, takenMaterials);
    materialKey.set(key, name);
    materialList.push({ name, E, nu: nu > -1 && nu < 0.5 ? nu : 0.3, density });
    return name;
  };

  const nodeIds = new Set(jointOrder);
  let noSection = 0;
  const memberList: ProjectMember3D[] = [];
  for (const id of memberOrder) {
    const [i, j] = members.get(id) as [number, number];
    if (!nodeIds.has(i) || !nodeIds.has(j)) {
      fail(
        undefined,
        `Member ${id} refers to joint ${nodeIds.has(i) ? j : i}, which is not defined.`,
      );
      continue;
    }
    if (i === j) {
      fail(undefined, `Member ${id} starts and ends at joint ${i}.`);
      continue;
    }
    let section = memberSection.get(id)?.name;
    if (!section) {
      noSection++;
      section = DEFAULT_SECTION_3D;
    }
    const member: ProjectMember3D = {
      id: String(id),
      i: String(i),
      j: String(j),
      type: kind === 'TRUSS' || trussMembers.has(id) ? 'truss' : 'beam',
      section,
      material: memberMaterial(id),
    };
    const beta = memberBeta.get(id);
    if (beta) member.beta = beta;
    const release = memberRelease.get(id);
    if (release && member.type === 'beam') {
      if (Object.keys(release.i).length > 0) member.releaseI = release.i;
      if (Object.keys(release.j).length > 0) member.releaseJ = release.j;
    }
    memberList.push(member);
  }
  if (noE > 0)
    warnings.push({ message: `${noE} member(s) had no E in CONSTANTS and use STAAD's STEEL.` });
  if (noSection > 0)
    warnings.push({
      message: `${noSection} member(s) had no MEMBER PROPERTY and use ${DEFAULT_SECTION_3D}.`,
    });
  project.members = memberList;
  project.materials = materialList.length > 0 ? materialList : project.materials;
  project.customSections = customSections.filter((s) =>
    memberList.some((m) => m.section === s.name),
  );
  if (zUp && memberList.some((m) => m.beta)) {
    warnings.push({
      message:
        'SET Z UP file with BETA angles: check member orientations (local axes follow FrameForge’s Y-up rule).',
    });
  }

  // Supports, mapping STAAD's axes to FrameForge's.
  const dofMap = zUp ? [0, 2, 1, 3, 5, 4] : [0, 1, 2, 3, 4, 5];
  for (const [id, r] of supports) {
    if (!nodeIds.has(id)) {
      fail(undefined, `A support refers to joint ${id}, which is not defined.`);
      continue;
    }
    const restraints = [false, false, false, false, false, false] as Restraints6;
    r.forEach((v, k) => (restraints[dofMap[k]] = v));
    project.supports.push({ node: String(id), restraints });
  }

  // Loads.
  /** A global vector (STAAD axes) in FrameForge axes. */
  const vec = (v: [number, number, number]): [number, number, number] =>
    zUp ? [v[0], v[2], v[1] === 0 ? 0 : -v[1]] : v;
  const loads: ProjectLoad3D[] = [];
  const nextId = () => `L${loads.length + 1}`;
  for (const jl of jointLoads) {
    const [fx, fy, fz] = vec([jl.values[0], jl.values[1], jl.values[2]]);
    const [mx, my, mz] = vec([jl.values[3], jl.values[4], jl.values[5]]);
    const targets = jl.joints.filter((id) => nodeIds.has(id)).map(String);
    if (targets.length < jl.joints.length)
      fail(jl.line, 'A joint load refers to a joint that is not defined.');
    if (targets.length > 0)
      loads.push({ id: nextId(), kind: 'nodal', nodes: targets, fx, fy, fz, mx, my, mz });
  }

  const memberById = new Map(memberList.map((m) => [m.id, m]));
  const nodePos = new Map(
    project.nodes.map((n) => [n.id, [n.x, n.y, n.z] as [number, number, number]]),
  );
  /** Global direction (FrameForge) and sign of a STAAD global axis. */
  const globalAxis = (axis: 'X' | 'Y' | 'Z'): { direction: GlobalDirection; sign: number } => {
    if (!zUp) return { direction: `global${axis}` as GlobalDirection, sign: 1 };
    if (axis === 'X') return { direction: 'globalX', sign: 1 };
    if (axis === 'Y') return { direction: 'globalZ', sign: -1 };
    return { direction: 'globalY', sign: 1 };
  };
  for (const ml of memberLoads) {
    const type = ml.type;
    const dirText = ml.dir;
    let direction: MemberLoadDirection;
    let sign = 1;
    let projected: 'X' | 'Y' | 'Z' | null = null;
    if (/^G[XYZ]$/.test(dirText)) ({ direction, sign } = globalAxis(dirText[1] as 'X'));
    else if (/^P[XYZ]$/.test(dirText)) {
      ({ direction, sign } = globalAxis(dirText[1] as 'X'));
      projected = dirText[1] as 'X';
    } else if (/^[XYZ]$/.test(dirText)) direction = `local${dirText}` as MemberLoadDirection;
    else {
      fail(ml.line, `Member load direction ${dirText} is not supported.`);
      continue;
    }
    const [v0, v1, v2, v3] = ml.values;
    const len = (v: number | undefined) => (v === undefined ? undefined : v * ml.L);
    const dist = (v: number) => (v * ml.F) / ml.L; // force per length
    for (const id of ml.members) {
      const member = memberById.get(id);
      if (!member) {
        fail(ml.line, `A member load refers to member ${id}, which is not defined.`);
        continue;
      }
      const pi = nodePos.get(member.i) as [number, number, number];
      const pj = nodePos.get(member.j) as [number, number, number];
      const d = [pj[0] - pi[0], pj[1] - pi[1], pj[2] - pi[2]];
      const Lm = Math.hypot(d[0], d[1], d[2]);
      // Projected loads act per unit length projected on the plane normal to the axis.
      let factor = sign;
      if (projected) {
        const k = { X: 0, Y: 1, Z: 2 }[projected];
        const axisIndex = zUp ? [0, 2, 1][k] : k;
        factor *= Math.sqrt(Math.max(0, Lm ** 2 - d[axisIndex] ** 2)) / Lm;
      }
      const within = (x: number | undefined) => x === undefined || (x >= -1e-9 && x <= Lm + 1e-9);
      const clamp = (x: number) => Math.min(Lm, Math.max(0, x));
      const base = { members: [id], direction };
      if (type === 'UNI' || type === 'UNIFORM') {
        const a = len(v1);
        const b = len(v2);
        if (v3 !== undefined && v3 !== 0)
          warnOnce(`offset-${ml.line}`, ml.line, 'Load offsets (d3) are ignored.');
        if (!within(a) || !within(b)) {
          fail(ml.line, `UNI load position is outside member ${id}.`);
          continue;
        }
        const load: ProjectLoad3D = {
          id: nextId(),
          kind: 'distributed',
          ...base,
          w1: dist(v0) * factor,
        };
        if (a !== undefined && a > 1e-9) load.a = clamp(a);
        if (b !== undefined && b < Lm - 1e-9) load.b = clamp(b);
        if (load.a !== undefined && load.b !== undefined && load.b <= load.a) {
          fail(ml.line, `UNI load on member ${id} ends before it starts.`);
          continue;
        }
        loads.push(load);
      } else if (type === 'CON' || type === 'CONCENTRATED' || type === 'CMOM') {
        const a = len(v1) ?? Lm / 2;
        if (!within(a)) {
          fail(ml.line, `${type} load position is outside member ${id}.`);
          continue;
        }
        if (v2 !== undefined && v2 !== 0)
          warnOnce(`offset-${ml.line}`, ml.line, 'Load offsets are ignored.');
        if (type === 'CMOM')
          loads.push({
            id: nextId(),
            kind: 'moment',
            ...base,
            M: v0 * ml.F * ml.L * factor,
            a: clamp(a),
          });
        else
          loads.push({ id: nextId(), kind: 'point', ...base, P: v0 * ml.F * factor, a: clamp(a) });
      } else if (type === 'LIN' || type === 'LINEAR') {
        if (ml.values.length >= 3 && v2 !== 0) {
          // Triangular load peaking at mid-span: two linear pieces.
          const w = dist(v2) * factor;
          loads.push({ id: nextId(), kind: 'distributed', ...base, w1: 0, w2: w, b: Lm / 2 });
          loads.push({ id: nextId(), kind: 'distributed', ...base, w1: w, w2: 0, a: Lm / 2 });
        } else {
          loads.push({
            id: nextId(),
            kind: 'distributed',
            ...base,
            w1: dist(v0) * factor,
            w2: dist(v1 ?? v0) * factor,
          });
        }
      } else if (type === 'TRAP' || type === 'TRAPEZOIDAL') {
        const a = len(v2);
        const b = len(v3);
        if (!within(a) || !within(b)) {
          fail(ml.line, `TRAP load position is outside member ${id}.`);
          continue;
        }
        const load: ProjectLoad3D = {
          id: nextId(),
          kind: 'distributed',
          ...base,
          w1: dist(v0) * factor,
          w2: dist(v1 ?? v0) * factor,
        };
        if (a !== undefined && a > 1e-9) load.a = clamp(a);
        if (b !== undefined && b < Lm - 1e-9) load.b = clamp(b);
        loads.push(load);
      } else {
        warnOnce(
          `mload-${type}`,
          ml.line,
          `Member load type ${type} is not supported and is ignored.`,
        );
        break;
      }
    }
  }

  for (const sw of selfWeights) {
    const gravity = zUp ? sw.dir === 'Z' : sw.dir === 'Y';
    if (gravity && sw.factor === -1 && sw.members === null) {
      project.selfWeight = true;
      continue;
    }
    // Anything else becomes member line loads: w = factor · density · A.
    const { direction, sign } = globalAxis(sw.dir as 'X');
    const targets =
      sw.members === null
        ? memberList
        : memberList.filter((m) => sw.members?.includes(Number(m.id)));
    for (const m of targets) {
      const density = project.materials.find((x) => x.name === m.material)?.density ?? 0;
      const rolled = getSection(m.section);
      const A = rolled
        ? rolled.A
        : (project.customSections.find((s) => s.name === m.section)?.A ?? 0);
      const w = sw.factor * sign * density * A * 1e-4;
      if (w !== 0)
        loads.push({ id: nextId(), kind: 'distributed', members: [m.id], direction, w1: w });
    }
    warnOnce(
      `sw-${sw.line}`,
      sw.line,
      `SELFWEIGHT ${sw.dir} ${sw.factor} was applied as member line loads (density × area).`,
    );
  }
  if (project.selfWeight && project.materials.every((m) => m.density === 0)) {
    warnings.push({
      message: 'SELFWEIGHT is on but no material has a density, so it adds no load.',
    });
  }
  project.loads = loads;
  if (loadCases.length > 1) {
    warnings.push({
      message: `The file has ${loadCases.length} load cases; load case ${wanted} was imported.`,
    });
  }
  if (wanted !== undefined && !loadCases.some((c) => c.number === wanted)) {
    errors.push({ message: `Load case ${wanted} is not in the file.` });
  }
  if (memberList.length === 0 && errors.length === 0)
    errors.push({ message: 'The file has no members.' });

  const plane = options.plane ?? (kind === 'PLANE' ? 'XY' : kind === 'TRUSS' ? 'auto' : 'none');
  const finished = finishProject(project, plane, errors);
  return {
    ...finished,
    errors,
    warnings,
    counts: {
      nodes: project.nodes.length,
      members: memberList.length,
      supports: project.supports.length,
      loads: loads.length,
    },
    format: 'std',
    loadCases,
    loadCase: wanted,
  };
}

const KNOWN_COMMANDS = new Set([
  'STAAD',
  'SET',
  'JOINT',
  'MEMBER',
  'START',
  'DEFINE',
  'END',
  'CONSTANTS',
  'CONSTANT',
  'SUPPORTS',
  'SUPPORT',
  'LOAD',
  'SELFWEIGHT',
  'SELF',
  'PERFORM',
  'FINISH',
  'PRINT',
  'INPUT',
  'PAGE',
  'PDELTA',
  'ANALYSIS',
  'PARAMETER',
  'PARAMETERS',
  'CODE',
  'CHECK',
  'SELECT',
  'DESIGN',
  'ELEMENT',
  'FLOOR',
  'TEMPERATURE',
  'TEMP',
  'REPEAT',
  'AREA',
  'ONEWAY',
  'SPECTRUM',
  'CUT',
  'CHANGE',
  'SECTION',
]);

function isKnownCommand(word: string): boolean {
  return KNOWN_COMMANDS.has(word);
}

/** True when the text looks like a STAAD input file. */
export function looksLikeStaad(text: string): boolean {
  return /^\s*STAAD\s+(SPACE|PLANE|TRUSS|FLOOR)\b/im.test(text) || /^\s*JOINT\s+COORD/im.test(text);
}
