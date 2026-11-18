/**
 * Importing a model from tables — the form most structural programs and spreadsheets can
 * export: one table each for nodes, members, supports, nodal loads and member loads, plus
 * optional tables of custom sections and materials. See docs/IMPORT.md for the columns.
 *
 * Every table has a header row whose names are matched loosely (`node`, `id`, `Node ID`,
 * `start`, `i`, `node_i`, …); a table without a recognisable header is read in the default
 * column order. Values are in the chosen units (m or mm, kN or N) unless a column header
 * names its own unit, e.g. `x (mm)` or `A_cm2`.
 */
import type {
  CustomSection3D,
  EndRelease,
  Material3D,
  MemberType3D,
  Project3D,
  ProjectLoad3D,
  ProjectMember3D,
  ProjectNode3D,
  ProjectSupport3D,
  Restraints6,
} from '../model3d/types';
import { CONCRETE, DEFAULT_SECTION_3D, emptyProject3D, STEEL } from '../model3d/types';
import type { CsvRow } from './csv';
import { normaliseHeader, parseCsv, parseNumber } from './csv';
import type { ImportIssue, ImportResult, PlaneOption, Units } from './common';
import {
  DEFAULT_UNITS,
  FORCE_FACTOR,
  finishProject,
  LENGTH_FACTOR,
  memberDirection,
  rolledSectionName,
} from './common';

export interface TableTexts {
  nodes?: string;
  members?: string;
  supports?: string;
  nodalLoads?: string;
  memberLoads?: string;
  sections?: string;
  materials?: string;
}
export type TableName = keyof TableTexts;

export const TABLE_NAMES: readonly TableName[] = [
  'nodes',
  'members',
  'supports',
  'nodalLoads',
  'memberLoads',
  'sections',
  'materials',
];

export interface TableImportOptions {
  units?: Partial<Units>;
  name?: string;
  /** 'auto' (default): plane frame when every z = 0 and no load acts out of plane. */
  plane?: PlaneOption;
  selfWeight?: boolean;
}

/** Physical quantity of a column, which sets how its values are converted. */
type Quantity =
  | 'none'
  | 'length'
  | 'force'
  | 'moment'
  | 'distributed'
  | 'area'
  | 'inertia'
  | 'stress'
  | 'density';

interface Column {
  key: string;
  aliases: string[];
  quantity?: Quantity;
  required?: boolean;
}

const col = (key: string, aliases: string[], quantity: Quantity = 'none', required = false) => ({
  key,
  aliases: [key.toLowerCase(), ...aliases],
  quantity,
  required,
});

const SPECS: Record<TableName, Column[]> = {
  nodes: [
    col(
      'id',
      ['node', 'nodeid', 'joint', 'jointid', 'name', 'label', 'no', 'number', 'n'],
      'none',
      true,
    ),
    col('x', ['coordx', 'xcoord', 'xcoordinate'], 'length', true),
    col('y', ['coordy', 'ycoord', 'ycoordinate'], 'length', true),
    col('z', ['coordz', 'zcoord', 'zcoordinate'], 'length'),
  ],
  members: [
    col(
      'id',
      [
        'member',
        'memberid',
        'element',
        'elementid',
        'elem',
        'beam',
        'name',
        'label',
        'no',
        'number',
      ],
      'none',
      true,
    ),
    col(
      'i',
      [
        'start',
        'startnode',
        'nodei',
        'node1',
        'n1',
        'inode',
        'ni',
        'from',
        'jointi',
        'node_start',
        'nodestart',
        'joint1',
      ],
      'none',
      true,
    ),
    col(
      'j',
      [
        'end',
        'endnode',
        'nodej',
        'node2',
        'n2',
        'jnode',
        'nj',
        'to',
        'jointj',
        'nodeend',
        'joint2',
      ],
      'none',
      true,
    ),
    col('section', ['sec', 'profile', 'property', 'prop', 'sectionname', 'shape']),
    col('type', ['kind', 'membertype', 'elementtype']),
    col('material', ['mat', 'materialname']),
    col('beta', ['angle', 'roll', 'rollangle', 'rotation', 'betaangle', 'orientation']),
    col('releaseI', ['releasei', 'releasestart', 'startrelease', 'reli', 'relstart', 'release1']),
    col('releaseJ', ['releasej', 'releaseend', 'endrelease', 'relj', 'relend', 'release2']),
    col('kz', ['kzz']),
    col('ky', ['kyy']),
  ],
  supports: [
    col('node', ['id', 'nodeid', 'joint', 'jointid'], 'none', true),
    col('type', ['fixity', 'support', 'restraint', 'restraints', 'condition', 'kind']),
    col('ux', ['dx', 'tx']),
    col('uy', ['dy', 'ty']),
    col('uz', ['dz', 'tz']),
    col('rx', ['rotx']),
    col('ry', ['roty']),
    col('rz', ['rotz']),
  ],
  nodalLoads: [
    col('node', ['id', 'nodeid', 'joint', 'jointid'], 'none', true),
    col('fx', ['px', 'forcex'], 'force'),
    col('fy', ['py', 'forcey'], 'force'),
    col('fz', ['pz', 'forcez'], 'force'),
    col('mx', ['momentx'], 'moment'),
    col('my', ['momenty'], 'moment'),
    col('mz', ['momentz'], 'moment'),
  ],
  memberLoads: [
    col('member', ['id', 'memberid', 'element', 'elementid', 'elem', 'beam'], 'none', true),
    col('type', ['kind', 'loadtype']),
    col('direction', ['dir', 'axis']),
    col(
      'w1',
      ['w', 'value', 'load', 'magnitude', 'p', 'm', 'force', 'intensity', 'wstart', 'value1'],
      'distributed',
      true,
    ),
    col('w2', ['wend', 'value2', 'w2end'], 'distributed'),
    col(
      'a',
      ['d1', 'start', 'from', 'x', 'distance', 'dist', 'position', 'x1', 'astart'],
      'length',
    ),
    col('b', ['d2', 'end', 'to', 'x2', 'bend'], 'length'),
  ],
  sections: [
    col('name', ['section', 'id', 'designation', 'label'], 'none', true),
    col('A', ['area', 'ax'], 'area', true),
    col('Iz', ['izz', 'imajor', 'i'], 'inertia', true),
    col('Iy', ['iyy', 'iminor'], 'inertia', true),
    col('J', ['ix', 'it', 'torsion', 'jx'], 'inertia', true),
  ],
  materials: [
    col('name', ['material', 'id', 'label'], 'none', true),
    col('E', ['youngsmodulus', 'modulus', 'elasticity', 'emod'], 'stress', true),
    col('nu', ['poisson', 'poissonsratio', 'v'], 'none'),
    col('density', ['weightdensity', 'unitweight', 'gamma', 'weight', 'dens'], 'density'),
  ],
};

export const TABLE_LABELS: Record<TableName, string> = {
  nodes: 'Nodes',
  members: 'Members',
  supports: 'Supports',
  nodalLoads: 'Nodal loads',
  memberLoads: 'Member loads',
  sections: 'Sections',
  materials: 'Materials',
};

/** Default column order of each table (also the order used without a header). */
export const TABLE_COLUMNS: Record<TableName, string[]> = Object.fromEntries(
  TABLE_NAMES.map((t) => [t, SPECS[t].map((c) => c.key)]),
) as Record<TableName, string[]>;

/** Units that may follow a column name: `x (mm)`, `A [cm²]`, `E_MPa`, `Iz cm4`. */
const UNIT_SUFFIX =
  /^(.*?)[\s_]+(mm2|cm2|m2|mm4|cm4|m4|gpa|mpa|kpa|pa|kn\/m2|n\/mm2|kn\/mm2|kn\/m3|n\/mm3|n\/m3|kn\/m|n\/mm|n\/m|knm|kn\.m|nmm|n\.mm|nm|n\.m|kn|n|mm|cm|m)$/i;

function tidyUnit(unit: string): string {
  return unit
    .toLowerCase()
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/⁴/g, '4')
    .replace(/\^/g, '')
    .replace(/[\s·*]/g, '')
    .replace(/kn\.m|kn-m/g, 'knm')
    .replace(/n\.mm|n-mm/g, 'nmm')
    .replace(/n\.m|n-m/g, 'nm');
}

/** Splits a header cell into its normalised name and the unit it names, if any. */
function headerUnit(cell: string): { name: string; unit?: string } {
  const bracket = /[([]\s*([^)\]]+?)\s*[)\]]/.exec(cell);
  if (bracket) return { name: normaliseHeader(cell), unit: tidyUnit(bracket[1]) };
  const suffix = UNIT_SUFFIX.exec(cell.trim());
  if (suffix && normaliseHeader(suffix[1])) {
    return { name: normaliseHeader(suffix[1]), unit: tidyUnit(suffix[2]) };
  }
  return { name: normaliseHeader(cell) };
}

/** App units: m, kN, kN·m, kN/m, cm², cm⁴, GPa, kN/m³. Factor from a named unit. */
const NAMED_UNITS: Record<Quantity, Record<string, number>> = {
  none: {},
  length: { m: 1, cm: 1e-2, mm: 1e-3 },
  force: { kn: 1, n: 1e-3 },
  moment: { knm: 1, nm: 1e-3, nmm: 1e-6 },
  distributed: { 'kn/m': 1, 'n/mm': 1, 'n/m': 1e-3 },
  area: { m2: 1e4, cm2: 1, mm2: 1e-2 },
  inertia: { m4: 1e8, cm4: 1, mm4: 1e-4 },
  stress: { gpa: 1, mpa: 1e-3, 'n/mm2': 1e-3, 'kn/mm2': 1, kpa: 1e-6, 'kn/m2': 1e-6, pa: 1e-9 },
  density: { 'kn/m3': 1, 'n/m3': 1e-3, 'n/mm3': 1e6 },
};

/** Factor from the chosen unit system to app units, for each quantity. */
function systemFactors(units: Units): Record<Quantity, number> {
  const L = LENGTH_FACTOR[units.length];
  const F = FORCE_FACTOR[units.force];
  return {
    none: 1,
    length: L,
    force: F,
    moment: F * L,
    distributed: F / L,
    area: L ** 2 * 1e4,
    inertia: L ** 4 * 1e8,
    stress: (F / L ** 2) * 1e-6,
    density: F / L ** 3,
  };
}

interface Row {
  line: number;
  /** Raw cell text by column key ('' when absent). */
  text: Record<string, string>;
  /** Converts a numeric cell to app units; NaN when blank or not a number. */
  num: (key: string) => number;
}

interface Reader {
  rows: Row[];
}

/** Reads one table: finds the header, maps columns and sets up unit conversion. */
function readTable(
  table: TableName,
  text: string,
  units: Units,
  errors: ImportIssue[],
  warnings: ImportIssue[],
): Reader {
  const where = TABLE_LABELS[table].toLowerCase();
  const spec = SPECS[table];
  const { separator, rows } = parseCsv(text);
  const system = systemFactors(units);
  if (rows.length === 0) return { rows: [] };

  const lookup = new Map<string, Column>();
  for (const c of spec) for (const a of c.aliases) if (!lookup.has(a)) lookup.set(a, c);

  const header = rows[0].cells.map(headerUnit);
  const matched = header.map((h) => lookup.get(h.name));
  let columns: Array<{ column: Column; index: number; factor: number }> = [];
  let data: CsvRow[];
  // A header names at least one known column and holds no numbers (data rows always do).
  const isHeader =
    matched.some(Boolean) &&
    rows[0].cells.every((c) => !Number.isFinite(parseNumber(c, separator)));
  if (isHeader) {
    data = rows.slice(1);
    const used = new Set<string>();
    header.forEach((h, index) => {
      const column = matched[index];
      const cell = rows[0].cells[index];
      if (!column) {
        if (cell)
          warnings.push({ where, line: rows[0].line, message: `Column "${cell}" is not used.` });
        return;
      }
      if (used.has(column.key)) {
        warnings.push({
          where,
          line: rows[0].line,
          message: `Column "${cell}" repeats ${column.key}; the first one is used.`,
        });
        return;
      }
      used.add(column.key);
      const quantity = column.quantity ?? 'none';
      let factor = system[quantity];
      if (h.unit !== undefined && quantity !== 'none') {
        const named = NAMED_UNITS[quantity][h.unit];
        if (named === undefined) {
          errors.push({
            where,
            line: rows[0].line,
            message: `Unknown unit "${h.unit}" in column "${cell}".`,
          });
        } else factor = named;
      }
      columns.push({ column, index, factor });
    });
    for (const c of spec) {
      if (c.required && !used.has(c.key)) {
        errors.push({ where, line: rows[0].line, message: `Missing column "${c.key}".` });
      }
    }
  } else {
    data = rows;
    const required = spec.filter((c) => c.required).length;
    const width = Math.max(required, Math.min(spec.length, rows[0].cells.length));
    columns = spec.slice(0, width).map((column, index) => ({
      column,
      index,
      factor: system[column.quantity ?? 'none'],
    }));
    warnings.push({
      where,
      line: rows[0].line,
      message: `No header row found; reading columns as ${columns.map((c) => c.column.key).join(', ')}.`,
    });
  }

  const out: Row[] = data.map((row) => {
    const text: Record<string, string> = {};
    const factors: Record<string, number> = {};
    for (const c of columns) {
      text[c.column.key] = row.cells[c.index] ?? '';
      factors[c.column.key] = c.factor;
    }
    return {
      line: row.line,
      text,
      num: (key: string) => parseNumber(text[key] ?? '', separator) * (factors[key] ?? 1),
    };
  });
  return { rows: out };
}

const TRUE_CELLS = new Set(['1', 'true', 'yes', 'y', 'x', 'fixed', 'restrained', 'r', 't']);
const FALSE_CELLS = new Set(['0', 'false', 'no', 'n', 'free', '-', '', 'f']);

const SUPPORT_NAMES: Record<string, Restraints6> = {
  fixed: [true, true, true, true, true, true],
  fix: [true, true, true, true, true, true],
  encastre: [true, true, true, true, true, true],
  pinned: [true, true, true, false, false, false],
  pin: [true, true, true, false, false, false],
  hinge: [true, true, true, false, false, false],
  hinged: [true, true, true, false, false, false],
  roller: [false, true, false, false, false, false],
};

const RELEASE_KEYS = ['fx', 'fy', 'fz', 'mx', 'my', 'mz'] as const;

/** "mz", "my mz", "My+Mz", "pinned" (= My and Mz), "none" → an end release. */
function parseRelease(text: string): EndRelease | undefined | 'bad' {
  const t = text.trim().toLowerCase();
  if (t === '' || t === 'none' || t === '-' || t === 'fixed' || t === 'rigid') return undefined;
  if (['pin', 'pinned', 'hinge', 'hinged', 'moment', 'm'].includes(t))
    return { my: true, mz: true };
  const out: EndRelease = {};
  for (const part of t.split(/[\s+|/&;,]+/)) {
    if (!(RELEASE_KEYS as readonly string[]).includes(part)) return 'bad';
    out[part as (typeof RELEASE_KEYS)[number]] = true;
  }
  return out;
}

const MEMBER_TYPES: Record<string, MemberType3D> = {
  beam: 'beam',
  frame: 'beam',
  b: 'beam',
  truss: 'truss',
  t: 'truss',
  bar: 'truss',
  link: 'truss',
  axial: 'truss',
};

type LoadKind = 'udl' | 'linear' | 'point' | 'moment';
const LOAD_KINDS: Record<string, LoadKind> = {
  udl: 'udl',
  uniform: 'udl',
  uni: 'udl',
  distributed: 'udl',
  u: 'udl',
  linear: 'linear',
  lin: 'linear',
  trap: 'linear',
  trapezoidal: 'linear',
  varying: 'linear',
  uvl: 'linear',
  point: 'point',
  con: 'point',
  concentrated: 'point',
  p: 'point',
  force: 'point',
  moment: 'moment',
  cmom: 'moment',
  couple: 'moment',
};

/** Builds a project from the text of each table. */
export function importTables(tables: TableTexts, options: TableImportOptions = {}): ImportResult {
  const units: Units = { ...DEFAULT_UNITS, ...options.units };
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const counts: Record<string, number> = {};
  const project: Project3D = emptyProject3D(options.name?.trim() || 'Imported model');
  project.selfWeight = options.selfWeight === true;
  const read = (table: TableName) => {
    const text = tables[table];
    const reader = text?.trim() ? readTable(table, text, units, errors, warnings) : null;
    counts[table] = reader?.rows.length ?? 0;
    return reader;
  };
  const err = (where: string, line: number, message: string) =>
    errors.push({ where, line, message });

  // Materials and sections first, so members can refer to them.
  const materialsTable = read('materials');
  if (materialsTable) {
    const list: Material3D[] = [];
    for (const r of materialsTable.rows) {
      const name = r.text.name?.trim();
      const E = r.num('E');
      const nu = r.text.nu?.trim() ? r.num('nu') : 0.3;
      const density = r.text.density?.trim() ? r.num('density') : 0;
      if (!name) err('materials', r.line, 'Missing material name.');
      else if (list.some((m) => m.name === name))
        err('materials', r.line, `Material "${name}" is listed twice.`);
      else if (!(E > 0)) err('materials', r.line, `Material "${name}" needs a positive E.`);
      else if (!(nu > -1 && nu < 0.5))
        err('materials', r.line, `Material "${name}" needs a Poisson's ratio between -1 and 0.5.`);
      else if (!(density >= 0))
        err('materials', r.line, `Material "${name}" needs a density of zero or more.`);
      else list.push({ name, E, nu, density });
    }
    // The built-in materials stay available after the imported ones.
    for (const m of [STEEL, CONCRETE])
      if (!list.some((x) => x.name === m.name)) list.push({ ...m });
    project.materials = list;
  }

  const sectionsTable = read('sections');
  const customSections: CustomSection3D[] = [];
  if (sectionsTable) {
    for (const r of sectionsTable.rows) {
      const name = r.text.name?.trim();
      const values = { A: r.num('A'), Iz: r.num('Iz'), Iy: r.num('Iy'), J: r.num('J') };
      if (!name) err('sections', r.line, 'Missing section name.');
      else if (customSections.some((s) => s.name === name))
        err('sections', r.line, `Section "${name}" is listed twice.`);
      else if (!Object.values(values).every((v) => v > 0))
        err('sections', r.line, `Section "${name}" needs positive A, Iz, Iy and J.`);
      else customSections.push({ name, ...values });
    }
    project.customSections = customSections;
  }

  const nodesTable = read('nodes');
  const nodes: ProjectNode3D[] = [];
  const nodeById = new Map<string, ProjectNode3D>();
  if (!nodesTable || nodesTable.rows.length === 0)
    errors.push({ where: 'nodes', message: 'The nodes table is empty.' });
  for (const r of nodesTable?.rows ?? []) {
    const id = r.text.id?.trim();
    const x = r.num('x');
    const y = r.num('y');
    const z = r.text.z?.trim() ? r.num('z') : 0;
    if (!id) err('nodes', r.line, 'Missing node id.');
    else if (nodeById.has(id)) err('nodes', r.line, `Node "${id}" is listed twice.`);
    else if (![x, y, z].every(Number.isFinite))
      err('nodes', r.line, `Node "${id}" needs numeric x, y and z.`);
    else {
      const node = { id, x, y, z };
      nodes.push(node);
      nodeById.set(id, node);
    }
  }
  project.nodes = nodes;

  const membersTable = read('members');
  const members: ProjectMember3D[] = [];
  const memberLength = new Map<string, number>();
  const materialNames = new Set(project.materials.map((m) => m.name));
  let defaulted = 0;
  for (const r of membersTable?.rows ?? []) {
    const t = r.text;
    const id = t.id?.trim();
    const i = t.i?.trim();
    const j = t.j?.trim();
    if (!id) {
      err('members', r.line, 'Missing member id.');
      continue;
    }
    if (memberLength.has(id)) {
      err('members', r.line, `Member "${id}" is listed twice.`);
      continue;
    }
    const ni = nodeById.get(i ?? '');
    const nj = nodeById.get(j ?? '');
    if (!ni || !nj) {
      err(
        'members',
        r.line,
        `Member "${id}" refers to node "${ni ? j : i}", which is not in the nodes table.`,
      );
      continue;
    }
    const L = Math.hypot(nj.x - ni.x, nj.y - ni.y, nj.z - ni.z);
    if (!(L > 0)) {
      err('members', r.line, `Member "${id}" has zero length (its nodes are at the same point).`);
      continue;
    }
    let section = t.section?.trim() ?? '';
    if (!section) {
      section = DEFAULT_SECTION_3D;
      defaulted++;
    } else if (!customSections.some((s) => s.name === section)) {
      const rolled = rolledSectionName(section);
      if (!rolled) {
        err(
          'members',
          r.line,
          `Section "${section}" of member "${id}" is not a built-in section (ISMB / ISMC) and is not in the sections table.`,
        );
        continue;
      }
      section = rolled;
    }
    const typeText = t.type?.trim().toLowerCase() ?? '';
    const type = typeText ? MEMBER_TYPES[typeText] : 'beam';
    if (!type) {
      err('members', r.line, `Member "${id}" has type "${t.type}"; use beam or truss.`);
      continue;
    }
    const material = t.material?.trim() || project.materials[0].name;
    if (!materialNames.has(material)) {
      err(
        'members',
        r.line,
        `Material "${material}" of member "${id}" is not in the materials table.`,
      );
      continue;
    }
    const member: ProjectMember3D = { id, i: ni.id, j: nj.id, type, section, material };
    if (t.beta?.trim()) {
      const beta = r.num('beta');
      if (!Number.isFinite(beta)) {
        err('members', r.line, `Member "${id}" needs a numeric roll angle beta (degrees).`);
        continue;
      }
      if (beta !== 0) member.beta = beta;
    }
    let bad = false;
    for (const [key, label] of [
      ['releaseI', 'start'],
      ['releaseJ', 'end'],
    ] as const) {
      const release = parseRelease(t[key] ?? '');
      if (release === 'bad') {
        err(
          'members',
          r.line,
          `Member "${id}" ${label} release "${t[key]}" is not understood; use components such as "my mz" or "pinned".`,
        );
        bad = true;
      } else if (release) member[key] = release;
    }
    for (const key of ['kz', 'ky'] as const) {
      if (!t[key]?.trim()) continue;
      const k = r.num(key);
      if (!(k > 0)) {
        err('members', r.line, `Member "${id}" needs a positive effective length factor ${key}.`);
        bad = true;
      } else member[key] = k;
    }
    if (bad) continue;
    members.push(member);
    memberLength.set(id, L);
  }
  if (defaulted > 0) {
    warnings.push({
      where: 'members',
      message: `${defaulted} member(s) had no section and use ${DEFAULT_SECTION_3D}.`,
    });
  }
  project.members = members;
  if (members.length === 0 && errors.length === 0) {
    errors.push({ where: 'members', message: 'There are no members to analyse.' });
  }

  const supportsTable = read('supports');
  const supports: ProjectSupport3D[] = [];
  for (const r of supportsTable?.rows ?? []) {
    const node = r.text.node?.trim() ?? '';
    if (!nodeById.has(node)) {
      err('supports', r.line, `Support at node "${node}", which is not in the nodes table.`);
      continue;
    }
    const type = r.text.type?.trim().toLowerCase() ?? '';
    let restraints: Restraints6 | undefined;
    if (type) {
      restraints = SUPPORT_NAMES[type];
      if (!restraints && /^[01]{6}$/.test(type))
        restraints = [...type].map((c) => c === '1') as Restraints6;
      if (!restraints) {
        err(
          'supports',
          r.line,
          `Support type "${r.text.type}" is not understood; use fixed, pinned, roller or a mask such as 111000.`,
        );
        continue;
      }
    } else {
      const dofs = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'].map((k) =>
        (r.text[k] ?? '').trim().toLowerCase(),
      );
      const bad = dofs.find((v) => !TRUE_CELLS.has(v) && !FALSE_CELLS.has(v));
      if (bad !== undefined) {
        err('supports', r.line, `Restraint "${bad}" is not understood; use 1 / 0 (or yes / no).`);
        continue;
      }
      restraints = dofs.map((v) => TRUE_CELLS.has(v)) as Restraints6;
    }
    if (!restraints.some(Boolean)) {
      warnings.push({
        where: 'supports',
        line: r.line,
        message: `Support at node "${node}" restrains nothing and is skipped.`,
      });
      continue;
    }
    if (supports.some((s) => s.node === node)) {
      warnings.push({
        where: 'supports',
        line: r.line,
        message: `Node "${node}" already has a support; this row is skipped.`,
      });
      continue;
    }
    supports.push({ node, restraints: [...restraints] as Restraints6 });
  }
  project.supports = supports;

  const loads: ProjectLoad3D[] = [];
  const nodalTable = read('nodalLoads');
  for (const r of nodalTable?.rows ?? []) {
    const node = r.text.node?.trim() ?? '';
    if (!nodeById.has(node)) {
      err('nodal loads', r.line, `Load at node "${node}", which is not in the nodes table.`);
      continue;
    }
    const keys = ['fx', 'fy', 'fz', 'mx', 'my', 'mz'] as const;
    const v = keys.map((k) => (r.text[k]?.trim() ? r.num(k) : 0));
    if (!v.every(Number.isFinite)) {
      err('nodal loads', r.line, `Load at node "${node}" has a value that is not a number.`);
      continue;
    }
    if (v.every((x) => x === 0)) {
      warnings.push({
        where: 'nodal loads',
        line: r.line,
        message: `Load at node "${node}" is zero and is skipped.`,
      });
      continue;
    }
    const [fx, fy, fz, mx, my, mz] = v;
    loads.push({
      id: `L${loads.length + 1}`,
      kind: 'nodal',
      nodes: [node],
      fx,
      fy,
      fz,
      mx,
      my,
      mz,
    });
  }

  const memberTable = read('memberLoads');
  for (const r of memberTable?.rows ?? []) {
    const member = r.text.member?.trim() ?? '';
    const where = 'member loads';
    const L = memberLength.get(member);
    if (L === undefined) {
      err(where, r.line, `Load on member "${member}", which is not in the members table.`);
      continue;
    }
    const kindText = r.text.type?.trim().toLowerCase() ?? '';
    const kind = kindText ? LOAD_KINDS[kindText] : 'udl';
    if (!kind) {
      err(
        where,
        r.line,
        `Load type "${r.text.type}" is not understood; use udl, linear, point or moment.`,
      );
      continue;
    }
    const direction = memberDirection(r.text.direction ?? '');
    if (!direction) {
      err(
        where,
        r.line,
        `Direction "${r.text.direction ?? ''}" is not understood; use GX, GY, GZ (global) or X, Y, Z (member axes).`,
      );
      continue;
    }
    // Point loads and moments are a force / moment, not a force per length.
    const unitFix = kind === 'point' ? 'force' : kind === 'moment' ? 'moment' : null;
    const scale = unitFix ? systemFactors(units)[unitFix] / systemFactors(units).distributed : 1;
    const w1 = r.num('w1') * scale;
    const w2 = r.text.w2?.trim() ? r.num('w2') : undefined;
    const a = r.text.a?.trim() ? r.num('a') : undefined;
    const b = r.text.b?.trim() ? r.num('b') : undefined;
    if (!Number.isFinite(w1) || [w2, a, b].some((v) => v !== undefined && !Number.isFinite(v))) {
      err(where, r.line, `Load on member "${member}" has a value that is not a number.`);
      continue;
    }
    const tol = 1e-9 * Math.max(1, L);
    const inside = (v: number | undefined) => v === undefined || (v >= -tol && v <= L + tol);
    if (!inside(a) || !inside(b) || (a !== undefined && b !== undefined && b < a)) {
      err(
        where,
        r.line,
        `Load position on member "${member}" must lie between 0 and its length ${+L.toFixed(4)} m (with start before end).`,
      );
      continue;
    }
    const id = `L${loads.length + 1}`;
    if (kind === 'point' || kind === 'moment') {
      if (a === undefined) {
        err(where, r.line, `A ${kind} load on member "${member}" needs its position a.`);
        continue;
      }
      loads.push(
        kind === 'point'
          ? { id, kind: 'point', members: [member], direction, P: w1, a }
          : { id, kind: 'moment', members: [member], direction, M: w1, a },
      );
      continue;
    }
    if (kind === 'linear' && w2 === undefined) {
      err(where, r.line, `A linear load on member "${member}" needs w2.`);
      continue;
    }
    const load: ProjectLoad3D = { id, kind: 'distributed', members: [member], direction, w1 };
    if (kind === 'linear' && w2 !== undefined && w2 !== w1) load.w2 = w2;
    if (a !== undefined && a > tol) load.a = a;
    if (b !== undefined && b < L - tol) load.b = b;
    loads.push(load);
  }
  project.loads = loads;

  const finished = finishProject(project, options.plane ?? 'auto', errors);
  return { ...finished, errors, warnings, counts, format: 'csv' };
}

/** Section names accepted by `parseBundle`, with the table each one fills. */
const BUNDLE_SECTIONS: Record<string, TableName | 'settings'> = {
  nodes: 'nodes',
  joints: 'nodes',
  members: 'members',
  elements: 'members',
  supports: 'supports',
  restraints: 'supports',
  nodalloads: 'nodalLoads',
  jointloads: 'nodalLoads',
  memberloads: 'memberLoads',
  elementloads: 'memberLoads',
  sections: 'sections',
  materials: 'materials',
  settings: 'settings',
  options: 'settings',
  units: 'settings',
};

/**
 * A CSV bundle: several tables in one text file, each starting with a line such as
 * `[nodes]`, `[members]`, `[supports]`, `[nodal loads]`, `[member loads]`, `[sections]`,
 * `[materials]`, and an optional `[settings]` table of `key,value` rows (length = m | mm,
 * force = kN | N, name, plane = auto | XY | none, selfweight = yes | no).
 */
export function parseBundle(text: string): {
  tables: TableTexts;
  options: TableImportOptions;
  errors: ImportIssue[];
} {
  const tables: TableTexts = {};
  const options: TableImportOptions = {};
  const errors: ImportIssue[] = [];
  const buffers = new Map<TableName | 'settings', string[]>();
  let current: TableName | 'settings' | null = null;
  text.split(/\r\n|\n|\r/).forEach((line, k) => {
    const heading = /^\s*\[([^\]]+)\]\s*[,;\t]*\s*$/.exec(line);
    if (heading) {
      const key = BUNDLE_SECTIONS[normaliseHeader(heading[1])];
      if (!key)
        errors.push({ where: 'bundle', line: k + 1, message: `Unknown table [${heading[1]}].` });
      current = key ?? null;
      // Every table keeps one entry per line of the file, so line numbers stay the file's.
      if (key && !buffers.has(key)) buffers.set(key, new Array<string>(k).fill(''));
    } else if (!current && line.trim() && !/^\s*(#|\/\/)/.test(line)) {
      errors.push({
        where: 'bundle',
        line: k + 1,
        message: 'Text before the first [table] heading.',
      });
    }
    for (const [key, lines] of buffers) lines.push(!heading && key === current ? line : '');
  });
  for (const [key, lines] of buffers) {
    if (key !== 'settings') {
      tables[key] = lines.join('\n');
      continue;
    }
    const { rows, separator } = parseCsv(lines.join('\n'));
    for (const row of rows) {
      const name = normaliseHeader(row.cells[0] ?? '');
      const value = (row.cells[1] ?? '').trim();
      const units = (options.units ??= {});
      if (name === 'key' || name === 'setting') continue;
      if (name === 'length' && (value === 'm' || value === 'mm')) units.length = value;
      else if (name === 'force' && (value.toLowerCase() === 'kn' || value.toUpperCase() === 'N')) {
        units.force = value.toLowerCase() === 'kn' ? 'kN' : 'N';
      } else if (name === 'name' && value) options.name = value;
      else if (name === 'plane' && ['auto', 'XY', 'none'].includes(value))
        options.plane = value as PlaneOption;
      else if (name === 'selfweight') options.selfWeight = /^(1|yes|y|true|on)$/i.test(value);
      else
        errors.push({
          where: 'settings',
          line: row.line,
          message: `Setting "${row.cells.join(separator)}" is not understood.`,
        });
    }
  }
  return { tables, options, errors };
}

/** Imports a CSV bundle (see `parseBundle`); `options` override the bundle's settings. */
export function importBundle(text: string, options: TableImportOptions = {}): ImportResult {
  const bundle = parseBundle(text);
  const merged: TableImportOptions = {
    ...bundle.options,
    ...options,
    units: { ...bundle.options.units, ...options.units },
  };
  const result = importTables(bundle.tables, merged);
  if (bundle.errors.length === 0) return result;
  return { ...result, project: null, errors: [...bundle.errors, ...result.errors] };
}

/** True when the text looks like a CSV bundle (has a `[nodes]` heading). */
export function looksLikeBundle(text: string): boolean {
  return /^\s*\[\s*(nodes|joints)\s*\]/im.test(text);
}
