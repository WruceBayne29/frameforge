/**
 * Pure geometry for the 3D viewer: plain arrays of positions, colours, arrows, glyphs and
 * labels built from a project and its results. Nothing here touches WebGL, so it is unit
 * tested directly; `scene.ts` turns the arrays into three.js objects (merged buffers and
 * instanced meshes, never one mesh per element).
 */
import {
  colorMap,
  fieldFraction,
  isPlane,
  loadTargets,
  withLoadTargets,
  type DiagramKind3D,
  type NodalField,
  type Project3D,
  type ProjectLoad3D,
} from '../../model3d';
import { memberAxes, plateAxes, SOLID_FACES } from '../../solver3d';
import type { AnalysisResult3D, MemberResult3D, Vec3 } from '../../solver3d';
import { fmt, loadValueText } from '../format3d';
import type { SelectionKind } from '../state';

export type { Vec3 };

export type LabelKind =
  'node' | 'member' | 'plate' | 'solid' | 'load' | 'reaction' | 'diagram' | 'selected';

export interface Label {
  position: Vec3;
  text: string;
  kind: LabelKind;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const mean = (points: Vec3[]): Vec3 => {
  const c: Vec3 = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k++) c[k] += p[k] / points.length;
  return c;
};

/** Node positions by id. */
export type Positions = Map<string, Vec3>;

export function nodePositions(project: Project3D): Positions {
  return new Map(project.nodes.map((n) => [n.id, [n.x, n.y, n.z] as Vec3]));
}

/** Node positions moved by `factor` × the nodal translations (nodes without results stay). */
export function displacedPositions(
  project: Project3D,
  result: AnalysisResult3D,
  factor: number,
): Positions {
  const out: Positions = new Map();
  for (const n of project.nodes) {
    const d = result.displacements[n.id];
    out.set(
      n.id,
      d ? [n.x + factor * d.ux, n.y + factor * d.uy, n.z + factor * d.uz] : [n.x, n.y, n.z],
    );
  }
  return out;
}

/**
 * Typical element size: the median length of member and element edges, used to size node
 * spheres, member tubes and glyphs so they suit both coarse frames and fine meshes.
 */
export function typicalLength(project: Project3D, size: number): number {
  const pos = nodePositions(project);
  const lengths: number[] = [];
  const edge = (a: string, b: string) => {
    const p = pos.get(a);
    const q = pos.get(b);
    if (p && q) lengths.push(length(sub(p, q)));
  };
  for (const m of project.members) edge(m.i, m.j);
  for (const p of project.plates) edge(p.nodes[0], p.nodes[1]);
  for (const s of project.solids) edge(s.nodes[0], s.nodes[1]);
  const valid = lengths.filter((l) => l > 0).sort((a, b) => a - b);
  if (valid.length === 0) return size / 4;
  return valid[Math.floor(valid.length / 2)];
}

/** Display sizes of the model's symbols, in world units. */
export interface Sizes {
  /** Largest model extent. */
  model: number;
  node: number;
  beam: number;
  truss: number;
  glyph: number;
  arrow: number;
}

export function symbolSizes(project: Project3D, size: number): Sizes {
  const typical = typicalLength(project, size);
  const node = Math.max(Math.min(0.009 * size, 0.09 * typical), 0.0025 * size);
  return {
    model: size,
    node,
    beam: node * 0.55,
    truss: node * 0.32,
    glyph: Math.max(Math.min(0.035 * size, 0.4 * typical), 3 * node),
    arrow: 0.08 * size,
  };
}

// ---- Line members -----------------------------------------------------------------------

/** Global position of a point along a member, displaced by its station deflections × factor. */
function stationPoint(
  start: Vec3,
  axes: MemberResult3D['axes'],
  s: MemberResult3D['stations'][number],
  factor: number,
): Vec3 {
  const along = s.x + factor * s.u;
  const v = factor * s.v;
  const w = factor * s.w;
  return [
    start[0] + axes.x[0] * along + axes.y[0] * v + axes.z[0] * w,
    start[1] + axes.x[1] * along + axes.y[1] * v + axes.z[1] * w,
    start[2] + axes.x[2] * along + axes.y[2] * v + axes.z[2] * w,
  ];
}

/**
 * Deflected shape of every member as line segments (pairs of points): each member follows
 * its station displacements u, v, w in local axes, so curvature between nodes is shown.
 */
export function deformedMemberSegments(
  project: Project3D,
  result: AnalysisResult3D,
  factor: number,
): Float32Array {
  const pos = nodePositions(project);
  const out: number[] = [];
  for (const m of project.members) {
    const r = result.members[m.id];
    const start = pos.get(m.i);
    if (!r || !start) continue;
    let previous: Vec3 | null = null;
    for (const s of r.stations) {
      const p = stationPoint(start, r.axes, s, factor);
      if (previous) out.push(...previous, ...p);
      previous = p;
    }
  }
  return new Float32Array(out);
}

/**
 * Direction (in local axes) in which each diagram is drawn. Bending moments are drawn on the
 * tension side, like the 2D app: positive Mz curves the member towards +y, so the tension
 * fibres are on −y; likewise positive My puts −z in tension.
 */
export function diagramAxis(kind: DiagramKind3D): { axis: 'y' | 'z'; sign: 1 | -1 } {
  switch (kind) {
    case 'Vz':
      return { axis: 'z', sign: 1 };
    case 'My':
      return { axis: 'z', sign: -1 };
    case 'Mz':
      return { axis: 'y', sign: -1 };
    default:
      return { axis: 'y', sign: 1 };
  }
}

export interface DiagramGeometry {
  /** Filled triangles where the value is positive / negative. */
  positive: Float32Array;
  negative: Float32Array;
  /** The diagram outline and the closing ordinates, as segments. */
  outline: Float32Array;
  labels: Label[];
  /** Largest absolute value drawn. */
  peak: number;
}

/**
 * Member force diagram drawn in the member's local plane. `factor` is world metres per unit
 * of force. Peak values are labelled on every member of small models and on the members
 * with the largest values (and the `emphasise`d ones) of bigger models.
 */
export function memberDiagram(
  project: Project3D,
  result: AnalysisResult3D,
  kind: DiagramKind3D,
  factor: number,
  emphasise: ReadonlySet<string> = new Set(),
  maxLabels = 16,
): DiagramGeometry {
  const pos = nodePositions(project);
  const positive: number[] = [];
  const negative: number[] = [];
  const outline: number[] = [];
  const { axis, sign } = diagramAxis(kind);
  const peaks: Array<{ id: string; value: number; position: Vec3 }> = [];
  let peak = 0;

  for (const m of project.members) {
    const r = result.members[m.id];
    const start = pos.get(m.i);
    if (!r || !start || r.stations.length === 0) continue;
    const dir = scale(r.axes[axis], sign * factor);
    const base = (x: number) => add(start, scale(r.axes.x, x));
    const top = (x: number, value: number) => add(base(x), scale(dir, value));
    const value = (k: number) => r.stations[k][kind];

    // Largest value; among (near-)equal values the one nearest mid-span, so a constant
    // diagram (axial force, torsion) is labelled in the middle rather than at a joint.
    let best = 0;
    let bestK = 0;
    const mid = r.length / 2;
    for (let k = 0; k < r.stations.length; k++) {
      const a = Math.abs(value(k));
      const b = Math.abs(best);
      const tie = Math.abs(a - b) <= 1e-6 * Math.max(a, b);
      if (
        (!tie && a > b) ||
        (tie && Math.abs(r.stations[k].x - mid) < Math.abs(r.stations[bestK].x - mid))
      ) {
        best = value(k);
        bestK = k;
      }
    }
    peak = Math.max(peak, Math.abs(best));
    if (Math.abs(best) < 1e-9) continue;

    const quad = (x0: number, v0: number, x1: number, v1: number) => {
      const target = v0 + v1 >= 0 ? positive : negative;
      const b0 = base(x0);
      const b1 = base(x1);
      const t0 = top(x0, v0);
      const t1 = top(x1, v1);
      target.push(...b0, ...b1, ...t1, ...b0, ...t1, ...t0);
    };
    for (let k = 0; k + 1 < r.stations.length; k++) {
      const s0 = r.stations[k];
      const s1 = r.stations[k + 1];
      const v0 = value(k);
      const v1 = value(k + 1);
      if (v0 * v1 < 0) {
        // Split at the zero crossing so each part gets the right colour.
        const xz = s0.x + ((s1.x - s0.x) * v0) / (v0 - v1);
        quad(s0.x, v0, xz, 0);
        quad(xz, 0, s1.x, v1);
      } else if (s1.x > s0.x) {
        quad(s0.x, v0, s1.x, v1);
      }
      outline.push(...top(s0.x, v0), ...top(s1.x, v1));
    }
    const first = r.stations[0];
    const last = r.stations[r.stations.length - 1];
    outline.push(...base(first.x), ...top(first.x, value(0)));
    outline.push(...base(last.x), ...top(last.x, value(r.stations.length - 1)));
    peaks.push({ id: m.id, value: best, position: top(r.stations[bestK].x, best) });
  }

  const labelAll = peaks.length <= 20;
  const ranked = [...peaks].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const chosen = labelAll ? peaks : ranked.filter((p, k) => k < maxLabels || emphasise.has(p.id));
  const labels: Label[] = chosen
    .filter((p) => Math.abs(p.value) >= 1e-3 * peak)
    .map((p) => ({ position: p.position, text: fmt(p.value), kind: 'diagram' }));

  return {
    positive: new Float32Array(positive),
    negative: new Float32Array(negative),
    outline: new Float32Array(outline),
    labels,
    peak,
  };
}

// ---- Surfaces (plates and solids) -------------------------------------------------------

export interface Surface {
  /** Non-indexed triangle vertices. */
  positions: Float32Array;
  /** One flat normal per vertex. */
  normals: Float32Array;
  /** Contour colours (0–1) per vertex when a field was given. */
  colors: Float32Array | null;
  /** Owning element id of each triangle. */
  owners: string[];
  /** Element outline edges as segments, each edge once. */
  edges: Float32Array;
}

/** RGB in 0–1 for a node's field value (grey when the node has none). */
function fieldColor(field: NodalField, node: string): [number, number, number] {
  const value = field.values[node];
  const [r, g, b] = colorMap(value === undefined ? Number.NaN : fieldFraction(field, value));
  return [r / 255, g / 255, b / 255];
}

function surfaceFromQuads(
  quads: Array<{ owner: string; nodes: readonly string[] }>,
  pos: Positions,
  field: NodalField | null,
  edgeFilter?: (a: string, b: string) => boolean,
): Surface {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const owners: string[] = [];
  const edges: number[] = [];
  const seen = new Set<string>();
  for (const quad of quads) {
    const p = quad.nodes.map((id) => pos.get(id));
    if (p.some((v) => !v)) continue;
    const q = p as Vec3[];
    const normal = unit(cross(sub(q[2], q[0]), sub(q[3], q[1])));
    for (const k of [0, 1, 2, 0, 2, 3]) {
      positions.push(...q[k]);
      normals.push(...normal);
      if (field) colors.push(...fieldColor(field, quad.nodes[k]));
    }
    owners.push(quad.owner, quad.owner);
    for (let k = 0; k < 4; k++) {
      const a = quad.nodes[k];
      const b = quad.nodes[(k + 1) % 4];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key) || (edgeFilter && !edgeFilter(a, b))) continue;
      seen.add(key);
      edges.push(...q[k], ...q[(k + 1) % 4]);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: field ? new Float32Array(colors) : null,
    owners,
    edges: new Float32Array(edges),
  };
}

export function plateSurface(
  project: Project3D,
  pos: Positions,
  field: NodalField | null = null,
): Surface {
  return surfaceFromQuads(
    project.plates.map((p) => ({ owner: p.id, nodes: p.nodes })),
    pos,
    field,
  );
}

/** The faces of solids not shared with another solid, outward-facing, with their owners. */
export function exteriorFaces(
  project: Project3D,
): Array<{ owner: string; nodes: string[]; face: number }> {
  const count = new Map<string, number>();
  const faces: Array<{ owner: string; nodes: string[]; face: number; key: string }> = [];
  for (const s of project.solids) {
    SOLID_FACES.forEach((f, k) => {
      const nodes = f.map((i) => s.nodes[i]);
      const key = [...nodes].sort().join('|');
      count.set(key, (count.get(key) ?? 0) + 1);
      faces.push({ owner: s.id, nodes, face: k + 1, key });
    });
  }
  return faces
    .filter((f) => count.get(f.key) === 1)
    .map(({ owner, nodes, face }) => ({ owner, nodes, face }));
}

export function solidSurface(
  project: Project3D,
  pos: Positions,
  field: NodalField | null = null,
): Surface {
  return surfaceFromQuads(exteriorFaces(project), pos, field);
}

// ---- Supports ---------------------------------------------------------------------------

export type GlyphShape = 'base' | 'pyramid' | 'cone' | 'roller' | 'cube';

export interface Glyph {
  shape: GlyphShape;
  node: string;
  position: Vec3;
  /** Unit vector from the glyph towards the node it holds. */
  direction: Vec3;
}

/**
 * Support symbols that show which degrees of freedom are held:
 *  - all six held: a fixed base block;
 *  - all three translations: a pyramid under the node (a pin);
 *  - vertical only: a pyramid on rollers;
 *  - other translations: a cone along each held axis, pointing at the node;
 *  - any rotation held (without full fixity): a small cube on the node.
 */
export function supportGlyphs(project: Project3D): Glyph[] {
  const pos = nodePositions(project);
  const glyphs: Glyph[] = [];
  const plane = isPlane(project);
  for (const s of project.supports) {
    const p = pos.get(s.node);
    if (!p) continue;
    const [ux, uy, uz, rx, ry, rz] = s.restraints;
    const g = (shape: GlyphShape, direction: Vec3) =>
      glyphs.push({ shape, node: s.node, position: p, direction });
    if (plane) {
      // The 2D symbols: fixed base, pin, or a pin on a roller pointing at the held direction.
      if (ux && uy && rz) g('base', [0, 1, 0]);
      else if (ux && uy) g('pyramid', [0, 1, 0]);
      else if (uy || ux) {
        const d: Vec3 = uy ? [0, 1, 0] : [1, 0, 0];
        g('pyramid', d);
        g('roller', d);
        if (rz) g('cube', [0, 1, 0]);
      } else if (rz) g('cube', [0, 1, 0]);
      continue;
    }
    if (s.restraints.every(Boolean)) {
      g('base', [0, 1, 0]);
      continue;
    }
    if (uy) g('pyramid', [0, 1, 0]);
    if (uy && !ux && !uz) g('roller', [0, 1, 0]);
    if (!(ux && uy && uz)) {
      if (ux) g('cone', [1, 0, 0]);
      if (uz) g('cone', [0, 0, 1]);
    }
    if (rx || ry || rz) g('cube', [0, 1, 0]);
  }
  return glyphs;
}

// ---- Arrows (loads and reactions) -------------------------------------------------------

export interface Arrow {
  /** Point the arrow head touches. */
  tip: Vec3;
  /** Unit direction the arrow points in. */
  direction: Vec3;
  length: number;
  /** Double head: a moment about `direction` (right-hand rule). */
  moment: boolean;
  /** Load id (loads) or node id (reactions), for picking. */
  owner: string;
}

export interface ArrowSet {
  arrows: Arrow[];
  /** Extra line work (the line joining the tails of a distributed load), as segments. */
  lines: Float32Array;
  labels: Label[];
}

const GLOBAL_AXIS: Record<string, Vec3> = {
  globalX: [1, 0, 0],
  globalY: [0, 1, 0],
  globalZ: [0, 0, 1],
};

/** The largest magnitude of each load, for scaling arrows within one kind. */
function loadMagnitude(load: ProjectLoad3D): number {
  switch (load.kind) {
    case 'nodal':
      return Math.max(Math.hypot(load.fx, load.fy, load.fz), Math.hypot(load.mx, load.my, load.mz));
    case 'distributed':
      return Math.max(Math.abs(load.w1), Math.abs(load.w2 ?? load.w1));
    case 'point':
    case 'platePoint':
      return Math.abs(load.P);
    case 'moment':
      return Math.abs(load.M);
    case 'pressure':
    case 'face':
      return Math.abs(load.p);
  }
}

type LoadFamily = 'force' | 'line' | 'area' | 'moment';
const family = (load: ProjectLoad3D): LoadFamily =>
  load.kind === 'distributed'
    ? 'line'
    : load.kind === 'pressure' || load.kind === 'face'
      ? 'area'
      : load.kind === 'moment'
        ? 'moment'
        : 'force';

/**
 * Arrows for every applied load. Arrow lengths are `arrow` (world units) for the largest load
 * of each family (forces, line loads, area loads, moments) and shorter for smaller ones. One
 * value label per load, at its first target.
 */
export function loadArrows(project: Project3D, arrow: number, maxPerLoad = 150): ArrowSet {
  const pos = nodePositions(project);
  const members = new Map(project.members.map((m) => [m.id, m]));
  const plates = new Map(project.plates.map((p) => [p.id, p]));
  const solids = new Map(project.solids.map((s) => [s.id, s]));
  const largest: Record<LoadFamily, number> = { force: 0, line: 0, area: 0, moment: 0 };
  for (const load of project.loads) {
    const f = family(load);
    largest[f] = Math.max(largest[f], loadMagnitude(load));
  }
  const len = (f: LoadFamily, value: number) =>
    largest[f] > 0 ? arrow * (0.4 + (0.6 * Math.abs(value)) / largest[f]) : arrow;

  const arrows: Arrow[] = [];
  const lines: number[] = [];
  const labels: Label[] = [];

  const memberFrame = (id: string) => {
    const m = members.get(id);
    const a = m && pos.get(m.i);
    const b = m && pos.get(m.j);
    if (!m || !a || !b) return null;
    try {
      return { start: a, ...memberAxes(a, b, ((m.beta ?? 0) * Math.PI) / 180) };
    } catch {
      return null;
    }
  };
  const memberDirection = (
    frame: NonNullable<ReturnType<typeof memberFrame>>,
    direction: string,
  ): Vec3 =>
    direction === 'localX'
      ? frame.x
      : direction === 'localY'
        ? frame.y
        : direction === 'localZ'
          ? frame.z
          : GLOBAL_AXIS[direction];
  /** An arrow of signed value `value` along `axis`, touching `point`. */
  const force = (
    point: Vec3,
    axis: Vec3,
    value: number,
    l: number,
    owner: string,
    moment = false,
  ) => {
    if (value === 0) return;
    const direction = value > 0 ? axis : scale(axis, -1);
    if (moment) {
      arrows.push({ tip: add(point, scale(direction, l)), direction, length: l, moment, owner });
    } else {
      arrows.push({ tip: point, direction, length: l, moment, owner });
    }
  };

  /** At most `maxPerLoad` targets of a load get arrows (evenly spread), so meshes stay legible. */
  const thin = (ids: string[]) => {
    if (ids.length <= maxPerLoad) return ids;
    const step = ids.length / maxPerLoad;
    return Array.from({ length: maxPerLoad }, (_, k) => ids[Math.floor(k * step)]);
  };

  for (const original of project.loads) {
    const load = withLoadTargets(original, thin(loadTargets(original).ids));
    let labelAt: Vec3 | null = null;
    switch (load.kind) {
      case 'nodal':
        for (const node of load.nodes) {
          const p = pos.get(node);
          if (!p) continue;
          const vector: Vec3 = [load.fx, load.fy, load.fz];
          const moment: Vec3 = [load.mx, load.my, load.mz];
          const f = length(vector);
          const m = length(moment);
          if (f > 0) {
            const l = len('force', f);
            force(p, unit(vector), 1, l, load.id);
            labelAt ??= sub(p, scale(unit(vector), l));
          }
          if (m > 0) {
            const l = len('force', m) * 0.8;
            force(p, unit(moment), 1, l, load.id, true);
            labelAt ??= add(p, scale(unit(moment), l));
          }
        }
        break;
      case 'distributed':
        for (const id of load.members) {
          const frame = memberFrame(id);
          if (!frame) continue;
          const axis = memberDirection(frame, load.direction);
          const a = Math.min(Math.max(load.a ?? 0, 0), frame.L);
          const b = Math.min(Math.max(load.b ?? frame.L, a), frame.L);
          const w2 = load.w2 ?? load.w1;
          const count = Math.max(2, Math.min(12, Math.round(((b - a) / frame.L) * 10) + 1));
          let previousTail: Vec3 | null = null;
          for (let k = 0; k < count; k++) {
            const t = count === 1 ? 0.5 : k / (count - 1);
            const x = a + (b - a) * t;
            const w = load.w1 + (w2 - load.w1) * t;
            const point = add(frame.start, scale(frame.x, x));
            const l = Math.abs(w) > 0 ? len('line', w) : 0;
            const direction = w >= 0 ? axis : scale(axis, -1);
            const tail = sub(point, scale(direction, l));
            if (l > 0)
              arrows.push({ tip: point, direction, length: l, moment: false, owner: load.id });
            if (previousTail) lines.push(...previousTail, ...tail);
            previousTail = tail;
            if (k === Math.floor(count / 2)) labelAt ??= tail;
          }
        }
        break;
      case 'point':
      case 'moment': {
        const value = load.kind === 'point' ? load.P : load.M;
        for (const id of load.members) {
          const frame = memberFrame(id);
          if (!frame) continue;
          const axis = memberDirection(frame, load.direction);
          const point = add(frame.start, scale(frame.x, Math.min(Math.max(load.a, 0), frame.L)));
          const l = len(load.kind === 'point' ? 'force' : 'moment', value);
          force(point, axis, value, l, load.id, load.kind === 'moment');
          labelAt ??=
            load.kind === 'point'
              ? sub(point, scale(axis, Math.sign(value) * l))
              : add(point, scale(axis, Math.sign(value) * l));
        }
        break;
      }
      case 'pressure':
      case 'platePoint': {
        const value = load.kind === 'pressure' ? load.p : load.P;
        for (const id of load.plates) {
          const plate = plates.get(id);
          const q = plate?.nodes.map((n) => pos.get(n));
          if (!plate || !q || q.some((v) => !v)) continue;
          const corners = q as Vec3[];
          let axis: Vec3;
          try {
            axis = load.direction === 'localZ' ? plateAxes(corners).z : GLOBAL_AXIS[load.direction];
          } catch {
            continue;
          }
          let point = mean(corners);
          if (load.kind === 'platePoint') {
            const n = [
              (1 - load.xi) * (1 - load.eta),
              (1 + load.xi) * (1 - load.eta),
              (1 + load.xi) * (1 + load.eta),
              (1 - load.xi) * (1 + load.eta),
            ].map((v) => v / 4);
            point = [0, 1, 2].map((k) => corners.reduce((s, c, i) => s + n[i] * c[k], 0)) as Vec3;
          }
          const l = len(load.kind === 'pressure' ? 'area' : 'force', value);
          force(point, axis, value, l, load.id);
          labelAt ??= sub(point, scale(axis, Math.sign(value) * l));
        }
        break;
      }
      case 'face':
        for (const id of load.solids) {
          const solid = solids.get(id);
          if (!solid) continue;
          const face = SOLID_FACES[load.face - 1];
          const q = face.map((k) => pos.get(solid.nodes[k]));
          if (q.some((v) => !v)) continue;
          const corners = q as Vec3[];
          const outward = unit(cross(sub(corners[2], corners[0]), sub(corners[3], corners[1])));
          // A positive normal pressure pushes into the solid, against the outward normal.
          const axis =
            load.direction === 'normal' ? scale(outward, -1) : GLOBAL_AXIS[load.direction];
          const point = mean(corners);
          const l = len('area', load.p);
          force(point, axis, load.p, l, load.id);
          labelAt ??= sub(point, scale(axis, Math.sign(load.p) * l));
        }
        break;
    }
    if (labelAt) labels.push({ position: labelAt, text: loadValueText(load), kind: 'load' });
  }
  return { arrows, lines: new Float32Array(lines), labels };
}

const COMPONENTS = [
  { key: 'fx', axis: [1, 0, 0], moment: false, name: 'Fx', unit: 'kN' },
  { key: 'fy', axis: [0, 1, 0], moment: false, name: 'Fy', unit: 'kN' },
  { key: 'fz', axis: [0, 0, 1], moment: false, name: 'Fz', unit: 'kN' },
  { key: 'mx', axis: [1, 0, 0], moment: true, name: 'Mx', unit: 'kN·m' },
  { key: 'my', axis: [0, 1, 0], moment: true, name: 'My', unit: 'kN·m' },
  { key: 'mz', axis: [0, 0, 1], moment: true, name: 'Mz', unit: 'kN·m' },
] as const;

/**
 * Reaction arrows at the supports: one per non-negligible force / moment component, acting on
 * the structure. Forces end just short of the node (clear of the support symbol); moments are
 * double-headed arrows starting at the node. Values are labelled on small models and for the
 * largest reactions of big ones.
 */
export function reactionArrows(
  project: Project3D,
  result: AnalysisResult3D,
  arrow: number,
  gap: number,
  maxLabels = 10,
): ArrowSet {
  const pos = nodePositions(project);
  let maxForce = 0;
  let maxMoment = 0;
  for (const r of Object.values(result.reactions)) {
    maxForce = Math.max(maxForce, Math.abs(r.fx), Math.abs(r.fy), Math.abs(r.fz));
    maxMoment = Math.max(maxMoment, Math.abs(r.mx), Math.abs(r.my), Math.abs(r.mz));
  }
  const arrows: Arrow[] = [];
  const candidates: Array<{ label: Label; value: number }> = [];
  // Plane frame mode: in-plane components only; a moment about Z would point at the viewer,
  // so it is shown as a label beside the node instead of an arrow.
  const plane = isPlane(project);
  const components = plane
    ? COMPONENTS.filter((c) => c.key === 'fx' || c.key === 'fy' || c.key === 'mz')
    : COMPONENTS;
  for (const [node, r] of Object.entries(result.reactions)) {
    const p = pos.get(node);
    if (!p) continue;
    for (const c of components) {
      const value = r[c.key];
      const largest = c.moment ? maxMoment : maxForce;
      if (!(Math.abs(value) > 1e-6 * Math.max(largest, 1e-9)) || Math.abs(value) < 1e-9) continue;
      if (plane && c.key === 'mz') {
        candidates.push({
          label: {
            position: add(p, [arrow * 0.45, arrow * 0.3, 0]),
            text: `Mz ${fmt(value)}`,
            kind: 'reaction',
          },
          value: Math.abs(value) / largest,
        });
        continue;
      }
      const direction = scale(c.axis as unknown as Vec3, Math.sign(value));
      const l = arrow * (0.45 + (0.55 * Math.abs(value)) / largest) * (c.moment ? 0.8 : 1);
      const tip = c.moment ? add(p, scale(direction, l)) : sub(p, scale(direction, gap));
      const tail = c.moment ? tip : sub(tip, scale(direction, l));
      arrows.push({ tip, direction, length: l, moment: c.moment, owner: node });
      candidates.push({
        label: { position: tail, text: `${c.name} ${fmt(value)}`, kind: 'reaction' },
        // Forces rank above moments when only some values can be labelled.
        value: Math.abs(value) / largest + (c.moment ? 0 : 1),
      });
    }
  }
  const labels =
    candidates.length <= maxLabels
      ? candidates.map((c) => c.label)
      : [...candidates]
          .sort((a, b) => b.value - a.value)
          .slice(0, maxLabels)
          .map((c) => c.label);
  return { arrows, lines: new Float32Array(0), labels };
}

// ---- Labels -----------------------------------------------------------------------------

/**
 * Id labels for nodes and elements. A model with more than `limit` of them gets none: that
 * many labels are unreadable and slow down every frame.
 */
export function idLabels(project: Project3D, limit = 400): Label[] {
  const total =
    project.nodes.length + project.members.length + project.plates.length + project.solids.length;
  if (total > limit) return [];
  const pos = nodePositions(project);
  const labels: Label[] = [];
  const centre = (ids: readonly string[]) => {
    const p = ids.map((id) => pos.get(id)).filter((v): v is Vec3 => !!v);
    return p.length === ids.length ? mean(p) : null;
  };
  for (const m of project.members) {
    const c = centre([m.i, m.j]);
    if (c) labels.push({ position: c, text: m.id, kind: 'member' });
  }
  for (const p of project.plates) {
    const c = centre(p.nodes);
    if (c) labels.push({ position: c, text: p.id, kind: 'plate' });
  }
  for (const s of project.solids) {
    const c = centre(s.nodes);
    if (c) labels.push({ position: c, text: s.id, kind: 'solid' });
  }
  for (const n of project.nodes) {
    labels.push({ position: [n.x, n.y, n.z], text: n.id, kind: 'node' });
  }
  return labels;
}

// ---- Selection subsets ------------------------------------------------------------------

/** A copy of the project restricted to the given items, for drawing highlights. */
export function subsetProject(
  project: Project3D,
  kind: SelectionKind,
  ids: readonly string[],
): Project3D {
  const keep = new Set(ids);
  return {
    ...project,
    nodes: kind === 'node' ? project.nodes.filter((n) => keep.has(n.id)) : project.nodes,
    members: kind === 'member' ? project.members.filter((m) => keep.has(m.id)) : [],
    plates: kind === 'plate' ? project.plates.filter((p) => keep.has(p.id)) : [],
    solids: kind === 'solid' ? project.solids.filter((s) => keep.has(s.id)) : [],
    loads: kind === 'load' ? project.loads.filter((l) => keep.has(l.id)) : [],
    supports: [],
  };
}

// ---- Working grid -----------------------------------------------------------------------

/** A "nice" grid spacing (1, 2 or 5 × 10ⁿ) giving roughly `lines` lines over `extent`. */
export function niceSpacing(extent: number, lines = 20): number {
  const raw = Math.max(extent, 1e-6) / lines;
  const power = 10 ** Math.floor(Math.log10(raw));
  const r = raw / power;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * power;
}

/** Snaps a value to the nearest multiple of `step`. */
export function snap(value: number, step: number): number {
  if (!(step > 0)) return value;
  const snapped = Math.round(value / step) * step;
  // Remove floating-point noise such as 0.30000000000000004.
  return Number(snapped.toFixed(9));
}

export interface GridSpec {
  /** Grid centre in X and Z, and half-width. */
  cx: number;
  cz: number;
  half: number;
  y: number;
  spacing: number;
  /** Every n-th line is drawn stronger. */
  majorEvery: number;
  /**
   * `XY`: a vertical grid in the z = 0 plane (plane frame mode), centred on (cx, cz) read as
   * (x, y); `y` is then ignored. Default: a horizontal grid at height `y`.
   */
  plane?: 'XZ' | 'XY';
}

/** Grid lines as segments: [minor, major]. */
export function gridSegments(spec: GridSpec): [Float32Array, Float32Array] {
  const minor: number[] = [];
  const major: number[] = [];
  const n = Math.round(spec.half / spec.spacing);
  const x0 = snap(spec.cx, spec.spacing * spec.majorEvery);
  const z0 = snap(spec.cz, spec.spacing * spec.majorEvery);
  const h = n * spec.spacing;
  for (let k = -n; k <= n; k++) {
    const target = k % spec.majorEvery === 0 ? major : minor;
    const d = k * spec.spacing;
    if (spec.plane === 'XY') {
      target.push(x0 + d, z0 - h, 0, x0 + d, z0 + h, 0);
      target.push(x0 - h, z0 + d, 0, x0 + h, z0 + d, 0);
    } else {
      target.push(x0 + d, spec.y, z0 - h, x0 + d, spec.y, z0 + h);
      target.push(x0 - h, spec.y, z0 + d, x0 + h, spec.y, z0 + d);
    }
  }
  return [new Float32Array(minor), new Float32Array(major)];
}
