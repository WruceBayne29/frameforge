/**
 * PDF calculation report of a 3D project: inputs, results, design checks and modal results.
 * Figures are vector orthographic projections drawn with jsPDF primitives (front, top and
 * isometric wireframes with member diagrams), so the report builds — and is unit tested — in
 * Node. In the browser the caller may add raster captures of the live viewer (contour plots).
 * A plane-frame project gets the figures of the 2D app: one front view per figure, with the
 * 2D support symbols and in-plane loads, reactions and N / V / M diagrams.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { RowInput } from 'jspdf-autotable';
import { STEEL_GRADES } from '../design-codes';
import {
  isPlane,
  loadTargets,
  memberProps3D,
  modelBounds3D,
  resultPeaks3D,
  resultScales3D,
  utilisationRgb,
} from '../model3d';
import type { DiagramKind3D, MemberDesign3D, Project3D, ProjectLoad3D } from '../model3d';
import type { AnalysisResult3D, ModalResult3D, Station3D, Vec3 } from '../solver3d';

export interface ReportImage {
  title: string;
  /** PNG data URL, e.g. from `window.frameforgeViewer3D.capture()`. */
  dataUrl: string;
  /** Width / height of the image (to keep its proportions). */
  aspect: number;
}

export interface ReportInput3D {
  project: Project3D;
  result: AnalysisResult3D;
  design: Record<string, MemberDesign3D>;
  /** Natural frequencies, when the modal analysis was run. */
  modal?: ModalResult3D | null;
  /** Raster figures of the live viewer (browser only). */
  images?: ReportImage[];
  /** Shown in the header; defaults to today. */
  date?: Date;
  /** Link back to the live model, printed on the first page. */
  shareUrl?: string;
  /** Compress the PDF streams (default true; tests read the text uncompressed). */
  compress?: boolean;
}

type Rgb = [number, number, number];
type Pt = [number, number];

const INK: Rgb = [15, 23, 42];
const MUTED: Rgb = [100, 116, 139];
const FAINT: Rgb = [148, 163, 184];
const ACCENT: Rgb = [3, 105, 161];
const LOAD: Rgb = [220, 38, 38];
const REACTION: Rgb = [21, 128, 61];
const DEFORMED: Rgb = [124, 58, 237];
const COMPRESSION: Rgb = [220, 38, 38];
const DIAGRAM: Record<DiagramKind3D, Rgb> = {
  N: [37, 99, 235],
  Vy: [8, 145, 178],
  Vz: [8, 145, 178],
  T: [147, 51, 234],
  My: [234, 88, 12],
  Mz: [234, 88, 12],
};
const DIAGRAM_TITLE: Record<DiagramKind3D, string> = {
  N: 'Axial force N (kN) - tension blue, compression red',
  Vy: 'Shear force Vy (kN)',
  Vz: 'Shear force Vz (kN)',
  T: 'Torque T (kNm)',
  My: 'Bending moment My (kNm)',
  Mz: 'Bending moment Mz (kNm)',
};
/** Local axis each diagram is drawn along, and its sign (moments on the tension side). */
const DIAGRAM_AXIS: Record<DiagramKind3D, { axis: 'y' | 'z'; sign: 1 | -1 }> = {
  N: { axis: 'y', sign: 1 },
  Vy: { axis: 'y', sign: 1 },
  Vz: { axis: 'z', sign: 1 },
  T: { axis: 'y', sign: 1 },
  My: { axis: 'z', sign: -1 },
  Mz: { axis: 'y', sign: -1 },
};

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 15;
/** Largest number of rows printed in one table; longer lists are cut with a note. */
const MAX_ROWS = 400;

/** The built-in PDF fonts only cover Latin-1, so replace the symbols used elsewhere in the app. */
export function pdfText(text: string): string {
  const map: Record<string, string> = {
    '→': '->',
    '≤': '<=',
    '≥': '>=',
    δ: 'd',
    θ: 'rot',
    Σ: 'Sum',
    λ: 'lambda',
    ε: 'eps',
    φ: 'phi',
    χ: 'chi',
    α: 'alpha',
    β: 'beta',
    γ: 'gamma',
    π: 'pi',
    ω: 'omega',
    σ: 'sigma',
    ξ: 'xi',
    η: 'eta',
    ρ: 'rho',
    '⁴': '4',
    '³': '3',
    '–': '-',
    '—': '-',
    '−': '-',
    '…': '...',
    '’': "'",
    '“': '"',
    '”': '"',
  };
  return text.replace(/[^\x20-\x7e\xa0-\xff]/g, (ch) => map[ch] ?? '?');
}

function num(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs < 1e-9) return '0';
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 100) return value.toFixed(Math.max(0, digits - 3));
  if (abs >= 10) return value.toFixed(Math.max(0, digits - 2));
  if (abs >= 1) return value.toFixed(Math.max(0, digits - 1));
  return value.toFixed(digits);
}

// ---- Projections ---------------------------------------------------------------------------

export interface View {
  name: string;
  /** Unit vectors of the drawing's horizontal (right) and vertical (up) directions. */
  right: Vec3;
  up: Vec3;
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Isometric view from the same direction as the app's "Iso" camera. */
const ISO_DIRECTION = unit([1, 0.75, 1.25]);
const ISO_RIGHT = unit(cross([0, 1, 0], ISO_DIRECTION));

export const VIEWS: Record<'front' | 'top' | 'iso', View> = {
  front: { name: 'Front (X right, Y up)', right: [1, 0, 0], up: [0, 1, 0] },
  top: { name: 'Top (X right, Z down)', right: [1, 0, 0], up: [0, 0, -1] },
  iso: { name: 'Isometric', right: ISO_RIGHT, up: cross(ISO_DIRECTION, ISO_RIGHT) },
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Maps world points into a box on the page for one view, fitted to the model. */
export function projector(project: Project3D, view: View, box: Box, pad = 14) {
  const points: Vec3[] = project.nodes.map((n) => [n.x, n.y, n.z]);
  if (points.length === 0) points.push([0, 0, 0]);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of points) {
    const u = dot(p, view.right);
    const v = dot(p, view.up);
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const w = Math.max(maxU - minU, 1e-6);
  const h = Math.max(maxV - minV, 1e-6);
  const scale = Math.min((box.w - 2 * pad) / w, (box.h - 2 * pad) / h);
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  const at = (p: Vec3): Pt => [
    box.x + box.w / 2 + (dot(p, view.right) - cu) * scale,
    box.y + box.h / 2 - (dot(p, view.up) - cv) * scale,
  ];
  /** Page direction (unit) of a world direction, or null when it points at the viewer. */
  const direction = (d: Vec3): Pt | null => {
    const u = dot(d, view.right);
    const v = -dot(d, view.up);
    const l = Math.hypot(u, v);
    return l > 0.15 ? [u / l, v / l] : null;
  };
  return { at, direction, scale };
}

// ---- Drawing primitives --------------------------------------------------------------------

function polygon(doc: jsPDF, points: Pt[], style: 'S' | 'F' | 'FD', closed = true): void {
  if (points.length < 2) return;
  const segments = points.slice(1).map((p, k) => [p[0] - points[k][0], p[1] - points[k][1]]);
  doc.lines(segments, points[0][0], points[0][1], [1, 1], style, closed);
}

function arrow(doc: jsPDF, from: Pt, to: Pt, head = 1.8): void {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uy = dy / len;
  const h = Math.min(head, len * 0.6);
  const bx = to[0] - ux * h;
  const by = to[1] - uy * h;
  doc.line(from[0], from[1], bx, by);
  doc.triangle(
    to[0],
    to[1],
    bx - uy * h * 0.4,
    by + ux * h * 0.4,
    bx + uy * h * 0.4,
    by - ux * h * 0.4,
    'F',
  );
}

const SOLID_EDGES: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

export interface FigureOptions {
  view: View;
  diagram?: DiagramKind3D;
  deformed?: boolean;
  /** Draw a mode shape instead of the static deflected shape. */
  mode?: number;
  loads?: boolean;
  reactions?: boolean;
  utilisation?: boolean;
  labels?: boolean;
}

/** Draws the structure (and optionally results) inside `box`. */
export function drawFigure(
  doc: jsPDF,
  input: ReportInput3D,
  box: Box,
  options: FigureOptions,
): void {
  const { project, result, design } = input;
  const plane = isPlane(project);
  const { at, direction, scale } = projector(project, options.view, box);
  const nodes = new Map(project.nodes.map((n) => [n.id, [n.x, n.y, n.z] as Vec3]));
  const scales = resultScales3D(project, result);
  const peaks = resultPeaks3D(result);
  const dense = project.members.length + project.plates.length + project.solids.length > 30;
  const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [
    a[0] + s * b[0],
    a[1] + s * b[1],
    a[2] + s * b[2],
  ];

  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.2);
  doc.rect(box.x, box.y, box.w, box.h);
  if (!plane) {
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text(pdfText(options.view.name), box.x + 1.5, box.y + 3.5);
  }

  // Plates and solids: wireframe.
  doc.setDrawColor(...FAINT);
  doc.setLineWidth(0.15);
  for (const p of project.plates) {
    const pts = p.nodes.map((id) => nodes.get(id)).filter((x): x is Vec3 => !!x);
    if (pts.length === 4) polygon(doc, pts.map(at), 'S');
  }
  for (const s of project.solids) {
    const pts = s.nodes.map((id) => nodes.get(id));
    for (const [a, b] of SOLID_EDGES) {
      const pa = pts[a];
      const pb = pts[b];
      if (!pa || !pb) continue;
      const p1 = at(pa);
      const p2 = at(pb);
      doc.line(p1[0], p1[1], p2[0], p2[1]);
    }
  }

  // Member force diagram, in the member's local plane.
  if (options.diagram) {
    const kind = options.diagram;
    const unitScale = scales.diagram[kind];
    const { axis, sign } = DIAGRAM_AXIS[kind];
    doc.setFontSize(6.5);
    for (const member of project.members) {
      const r = result.members[member.id];
      const start = nodes.get(member.i);
      if (!r || !start) continue;
      if (!r.stations.some((s) => Math.abs(s[kind]) > 1e-6 * Math.max(peaks[kind], 1e-9))) continue;
      const off = r.axes[axis];
      const point = (s: Station3D, value: number): Pt =>
        at(add(add(start, r.axes.x, s.x), off, sign * value * unitScale));
      const outline = r.stations.map((s) => point(s, s[kind]));
      const mean = r.stations.reduce((sum, s) => sum + s[kind], 0) / r.stations.length;
      const colour = kind === 'N' && mean < 0 ? COMPRESSION : DIAGRAM[kind];
      doc.setFillColor(...colour);
      doc.setDrawColor(...colour);
      const s0 = r.stations[0];
      const last = r.stations[r.stations.length - 1];
      if (
        kind === 'N' &&
        r.stations.every((s) => Math.abs(s.N - s0.N) < 1e-6 * Math.max(peaks.N, 1e-9))
      ) {
        // Constant axial force: the member itself, weighted by the force.
        const p1 = at(start);
        const p2 = at(add(start, r.axes.x, r.length));
        doc.setGState(doc.GState({ opacity: 0.45 }));
        doc.setLineWidth(0.8 + 2 * (Math.abs(s0.N) / peaks.N));
        doc.line(p1[0], p1[1], p2[0], p2[1]);
        doc.setGState(doc.GState({ opacity: 1 }));
        if (Math.abs(s0.N) >= (dense ? 0.3 : 0.03) * peaks.N) {
          const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1;
          const side = (p2[0] - p1[0]) / len > 0 ? -1 : 1;
          doc.setTextColor(...colour);
          doc.text(
            num(s0.N),
            (p1[0] + p2[0]) / 2 - ((p2[1] - p1[1]) / len) * side * 2.6,
            (p1[1] + p2[1]) / 2 + ((p2[0] - p1[0]) / len) * side * 2.6 + 0.8,
            { align: 'center' },
          );
        }
        continue;
      }
      doc.setGState(doc.GState({ opacity: 0.18 }));
      polygon(doc, [point(s0, 0), ...outline, point(last, 0)], 'F');
      doc.setGState(doc.GState({ opacity: 1 }));
      doc.setLineWidth(0.25);
      polygon(doc, outline, 'S', false);
      const extremes: Station3D[] =
        kind === 'Mz' || kind === 'My'
          ? [
              s0,
              last,
              r.stations.reduce((p, q) => (q[kind] > p[kind] ? q : p)),
              r.stations.reduce((p, q) => (q[kind] < p[kind] ? q : p)),
            ]
          : [s0, last];
      const shown: Station3D[] = [];
      doc.setTextColor(...colour);
      for (const s of extremes) {
        if (Math.abs(s[kind]) < (dense ? 0.3 : 0.03) * peaks[kind]) continue;
        if (
          shown.some(
            (q) =>
              Math.abs(q.x - s.x) < 0.08 * r.length &&
              Math.abs(q[kind] - s[kind]) < 0.02 * peaks[kind],
          )
        ) {
          continue;
        }
        shown.push(s);
        const p = point(s, s[kind]);
        const base = point(s, 0);
        const d = Math.hypot(p[0] - base[0], p[1] - base[1]) || 1;
        doc.text(
          num(s[kind]),
          p[0] + ((p[0] - base[0]) / d) * 2.5,
          p[1] + ((p[1] - base[1]) / d) * 2.5 + 0.8,
          { align: 'center' },
        );
      }
    }
  }

  // Members.
  for (const member of project.members) {
    const a = nodes.get(member.i);
    const b = nodes.get(member.j);
    if (!a || !b) continue;
    const p1 = at(a);
    const p2 = at(b);
    const d = design[member.id];
    const colour: Rgb = options.utilisation && d ? utilisationRgb(d.result.utilisation) : INK;
    doc.setDrawColor(...colour);
    doc.setLineWidth(member.type === 'truss' ? 0.45 : 0.7);
    doc.line(p1[0], p1[1], p2[0], p2[1]);
    const mx = (p1[0] + p2[0]) / 2;
    const my = (p1[1] + p2[1]) / 2;
    if (options.utilisation && d && (!dense || d.result.utilisation >= 0.6)) {
      doc.setFontSize(6);
      doc.setTextColor(...colour);
      doc.text(d.result.utilisation.toFixed(2), mx + 1.2, my - 1);
    } else if (options.labels && !dense) {
      doc.setFontSize(6);
      doc.setTextColor(...MUTED);
      const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1;
      doc.text(
        pdfText(member.id),
        mx - ((p2[1] - p1[1]) / len) * 2.2,
        my + ((p2[0] - p1[0]) / len) * 2.2 + 0.8,
        { align: 'center' },
      );
    }
  }

  // Deformed shape (static or modal).
  const mode = options.mode !== undefined ? input.modal?.modes[options.mode] : undefined;
  if (options.deformed || mode) {
    doc.setDrawColor(...DEFORMED);
    doc.setLineWidth(0.35);
    doc.setLineDashPattern([1.2, 0.8], 0);
    let factor = scales.deform;
    if (mode) {
      let peak = 0;
      for (const d of Object.values(mode.displacements)) {
        peak = Math.max(peak, Math.hypot(d.ux, d.uy, d.uz));
      }
      const size = Math.max(
        ...[0, 1, 2].map((k) => {
          const bounds = modelBounds3D(project);
          return bounds.max[k] - bounds.min[k];
        }),
        1,
      );
      factor = peak > 0 ? (0.08 * size) / peak : 0;
    }
    for (const member of project.members) {
      const start = nodes.get(member.i);
      const end = nodes.get(member.j);
      if (!start || !end) continue;
      if (mode) {
        const list = mode.members[member.id];
        if (!list) continue;
        const axisX = unit([end[0] - start[0], end[1] - start[1], end[2] - start[2]]);
        const r = result.members[member.id];
        const axes = r?.axes ?? { x: axisX, y: [0, 1, 0] as Vec3, z: [0, 0, 1] as Vec3 };
        polygon(
          doc,
          list.map((s) =>
            at(
              add(
                add(add(add(start, axes.x, s.x), axes.x, factor * s.u), axes.y, factor * s.v),
                axes.z,
                factor * s.w,
              ),
            ),
          ),
          'S',
          false,
        );
        continue;
      }
      const r = result.members[member.id];
      if (!r) continue;
      polygon(
        doc,
        r.stations.map((s) =>
          at(
            add(
              add(add(add(start, r.axes.x, s.x), r.axes.x, factor * s.u), r.axes.y, factor * s.v),
              r.axes.z,
              factor * s.w,
            ),
          ),
        ),
        'S',
        false,
      );
    }
    // Plate and solid edges at their displaced positions.
    const disp = (id: string): Vec3 | undefined => {
      const p = nodes.get(id);
      const d = mode ? mode.displacements[id] : result.displacements[id];
      return p && d ? [p[0] + factor * d.ux, p[1] + factor * d.uy, p[2] + factor * d.uz] : p;
    };
    doc.setLineWidth(0.2);
    for (const p of project.plates) {
      const pts = p.nodes.map(disp).filter((x): x is Vec3 => !!x);
      if (pts.length === 4) polygon(doc, pts.map(at), 'S');
    }
    for (const s of project.solids) {
      const pts = s.nodes.map(disp);
      for (const [a, b] of SOLID_EDGES) {
        const pa = pts[a];
        const pb = pts[b];
        if (!pa || !pb) continue;
        const p1 = at(pa);
        const p2 = at(pb);
        doc.line(p1[0], p1[1], p2[0], p2[1]);
      }
    }
    doc.setLineDashPattern([], 0);
  }

  // Supports.
  doc.setDrawColor(71, 85, 105);
  doc.setFillColor(255, 255, 255);
  doc.setLineWidth(0.3);
  for (const s of project.supports) {
    const n = nodes.get(s.node);
    if (!n || !s.restraints.some(Boolean)) continue;
    const [x, y] = at(n);
    const t = dense ? 1.8 : 2.6;
    const [ux, uy, uz, rx, ry, rz] = s.restraints;
    const fixed = plane ? ux && uy && rz : s.restraints.every(Boolean);
    if (fixed) {
      doc.line(x - t * 1.3, y, x + t * 1.3, y);
      for (let k = 0; k < 5; k++) {
        const hx = x - t * 1.3 + (k + 0.5) * ((2.6 * t) / 5);
        doc.line(hx + 0.6, y, hx - 0.6, y + 1.3);
      }
    } else if (plane && ux && !uy) {
      // Roller rolling along Y: the pin points sideways.
      doc.triangle(x, y, x - t * 1.2, y - t * 0.8, x - t * 1.2, y + t * 0.8, 'FD');
      doc.line(x - t * 1.2 - 1.2, y - t * 1.1, x - t * 1.2 - 1.2, y + t * 1.1);
    } else {
      doc.triangle(x, y, x - t * 0.8, y + t * 1.2, x + t * 0.8, y + t * 1.2, 'FD');
      const roller = plane ? !ux : !(ux && uz);
      const ground = roller ? y + t * 1.2 + 1.2 : y + t * 1.2;
      if (roller) {
        doc.circle(x - 1, y + t * 1.2 + 0.6, 0.55, 'S');
        doc.circle(x + 1, y + t * 1.2 + 0.6, 0.55, 'S');
      }
      doc.line(x - t * 1.3, ground, x + t * 1.3, ground);
      if (!plane && (rx || ry || rz)) doc.rect(x - 0.8, y - 0.8, 1.6, 1.6, 'S');
    }
  }

  // Loads (forces as arrows, moments as circles with their value).
  if (options.loads) drawLoads(doc, project, nodes, at, direction, scale, dense);

  // Reactions.
  if (options.reactions) {
    doc.setDrawColor(...REACTION);
    doc.setFillColor(...REACTION);
    doc.setTextColor(...REACTION);
    doc.setLineWidth(0.3);
    doc.setFontSize(6);
    const reactions = Object.entries(result.reactions);
    const big = reactions.reduce(
      (m, [, r]) => Math.max(m, Math.abs(r.fx), Math.abs(r.fy), Math.abs(r.fz)),
      0,
    );
    const axes: Array<['fx' | 'fy' | 'fz', Vec3]> = [
      ['fx', [1, 0, 0]],
      ['fy', [0, 1, 0]],
      ['fz', [0, 0, 1]],
    ];
    for (const [id, r] of reactions) {
      const n = nodes.get(id);
      if (!n) continue;
      const [x, y] = at(n);
      const tiny = 1e-6 * Math.max(big, 1);
      for (const [key, axis] of axes) {
        if (Math.abs(r[key]) <= tiny || (plane && key === 'fz')) continue;
        const d = direction(axis);
        if (!d) continue;
        const s = Math.sign(r[key]);
        const tip: Pt = [x - s * d[0] * 5.5, y - s * d[1] * 5.5];
        const tail: Pt = [x - s * d[0] * 12, y - s * d[1] * 12];
        arrow(doc, tail, tip);
        if (!dense) {
          doc.text(
            `${num(Math.abs(r[key]))} kN`,
            tail[0] - s * d[0] * 0.6,
            tail[1] - s * d[1] * 0.6 + 2.2,
            {
              align: 'center',
            },
          );
        }
      }
      const tinyM = 1e-6 * Math.max(big, 1);
      if (plane && Math.abs(r.mz) > tinyM) doc.text(`M = ${num(r.mz)} kNm`, x + 4, y - 4);
    }
  }

  // Nodes.
  doc.setFontSize(6);
  for (const n of project.nodes) {
    const [x, y] = at([n.x, n.y, n.z]);
    doc.setFillColor(...INK);
    if (project.plates.length + project.solids.length === 0 || !dense) doc.circle(x, y, 0.45, 'F');
    if (options.labels && !dense) {
      doc.setTextColor(...MUTED);
      doc.text(pdfText(n.id), x + 1, y - 1.2);
    }
  }
  doc.setTextColor(...INK);
}

/** Load arrows projected into the view. */
function drawLoads(
  doc: jsPDF,
  project: Project3D,
  nodes: Map<string, Vec3>,
  at: (p: Vec3) => Pt,
  direction: (d: Vec3) => Pt | null,
  scale: number,
  dense: boolean,
): void {
  doc.setDrawColor(...LOAD);
  doc.setFillColor(...LOAD);
  doc.setTextColor(...LOAD);
  doc.setLineWidth(0.25);
  doc.setFontSize(6);
  const LEN = 8;
  const members = new Map(project.members.map((m) => [m.id, m]));
  const plateById = new Map(project.plates.map((p) => [p.id, p]));
  const solidById = new Map(project.solids.map((s) => [s.id, s]));
  const maxW = project.loads.reduce(
    (m, l) => (l.kind === 'distributed' ? Math.max(m, Math.abs(l.w1), Math.abs(l.w2 ?? l.w1)) : m),
    0,
  );
  const GLOBAL: Record<string, Vec3> = {
    globalX: [1, 0, 0],
    globalY: [0, 1, 0],
    globalZ: [0, 0, 1],
  };
  const label = (load: ProjectLoad3D) => !dense || loadTargets(load).ids.length <= 4;

  /** A force arrow ending at `p` (page), pointing along the world direction × sign. */
  const force = (p: Pt, axis: Vec3, value: number, text: string | null) => {
    const d = direction(axis);
    if (!d || value === 0) return;
    const s = Math.sign(value);
    const tip: Pt = [p[0] - s * d[0] * 0.8, p[1] - s * d[1] * 0.8];
    const tail: Pt = [p[0] - s * d[0] * LEN, p[1] - s * d[1] * LEN];
    arrow(doc, tail, tip);
    if (text) doc.text(text, tail[0] + 1, tail[1] + (s * d[1] > 0 ? -0.6 : 2.2));
  };

  for (const load of project.loads) {
    switch (load.kind) {
      case 'nodal': {
        load.nodes.forEach((id, k) => {
          const n = nodes.get(id);
          if (!n) return;
          const p = at(n);
          const text = label(load) && k === 0;
          const parts: Array<[Vec3, number, string]> = [
            [[1, 0, 0], load.fx, 'kN'],
            [[0, 1, 0], load.fy, 'kN'],
            [[0, 0, 1], load.fz, 'kN'],
          ];
          for (const [axis, value] of parts) {
            force(p, axis, value, text ? `${num(Math.abs(value))} kN` : null);
          }
          const moments = [load.mx, load.my, load.mz].filter((v) => v !== 0);
          if (moments.length > 0) {
            doc.circle(p[0], p[1], 2.6, 'S');
            if (text) {
              const names = ['Mx', 'My', 'Mz'];
              const parts2 = [load.mx, load.my, load.mz]
                .map((v, d) => (v !== 0 ? `${names[d]} ${num(v)}` : ''))
                .filter(Boolean)
                .join(', ');
              doc.text(pdfText(`${parts2} kNm`), p[0] + 3.2, p[1] - 2.6);
            }
          }
        });
        break;
      }
      case 'distributed':
      case 'point':
      case 'moment': {
        load.members.forEach((id, k) => {
          const m = members.get(id);
          const a = m && nodes.get(m.i);
          const b = m && nodes.get(m.j);
          if (!m || !a || !b) return;
          const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
          const ax: Vec3 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L, (b[2] - a[2]) / L];
          const pointAt = (x: number): Vec3 => [
            a[0] + ax[0] * x,
            a[1] + ax[1] * x,
            a[2] + ax[2] * x,
          ];
          const text = label(load) && k === 0;
          // Local directions: local y = (z × x) with z = x × Y ("web up"), vertical members y = −X·sign.
          let localY: Vec3;
          const z0 = cross(ax, [0, 1, 0]);
          if (Math.hypot(...z0) < 1e-9) localY = cross([0, 0, 1], ax);
          else localY = unit(cross(unit(z0), ax));
          const localZ = cross(ax, localY);
          const axisOf = (dir: string): Vec3 =>
            dir === 'localX'
              ? ax
              : dir === 'localY'
                ? localY
                : dir === 'localZ'
                  ? localZ
                  : GLOBAL[dir];
          if (load.kind === 'moment') {
            const p = at(pointAt(load.a));
            doc.circle(p[0], p[1], 2.2, 'S');
            if (text) doc.text(`${num(load.M)} kNm`, p[0] + 2.8, p[1] - 2.4);
            return;
          }
          const axis = axisOf(load.direction);
          if (load.kind === 'point') {
            force(at(pointAt(load.a)), axis, load.P, text ? `${num(Math.abs(load.P))} kN` : null);
            return;
          }
          const d = direction(axis);
          if (!d) return;
          const la = load.a ?? 0;
          const lb = load.b ?? L;
          const w2 = load.w2 ?? load.w1;
          const sign = Math.sign(Math.abs(load.w1) >= Math.abs(w2) ? load.w1 : w2) || 1;
          const dir: Pt = [d[0] * sign, d[1] * sign];
          const count = Math.max(2, Math.min(24, Math.round(((lb - la) * scale) / 5) + 1));
          const tails: Pt[] = [];
          for (let q = 0; q < count; q++) {
            const t = q / (count - 1);
            const wv = load.w1 + (w2 - load.w1) * t;
            const len = maxW > 0 ? (Math.abs(wv) / maxW) * 5.5 : 0;
            const [x, y] = at(pointAt(la + (lb - la) * t));
            const tip: Pt = [x - dir[0] * 0.7, y - dir[1] * 0.7];
            const tail: Pt = [tip[0] - dir[0] * (len + 0.8), tip[1] - dir[1] * (len + 0.8)];
            tails.push(tail);
            if (len > 0.8) arrow(doc, tail, tip, 1.2);
          }
          polygon(doc, tails, 'S', false);
          if (text) {
            const mid = tails[Math.floor(tails.length / 2)];
            const value =
              Math.abs(load.w1 - w2) < 1e-9
                ? `${num(Math.abs(load.w1))} kN/m`
                : `${num(Math.abs(load.w1))} to ${num(Math.abs(w2))} kN/m`;
            doc.text(value, mid[0] - dir[0] * 1.5, mid[1] - dir[1] * 1.5 + 0.6, {
              align: 'center',
            });
          }
        });
        break;
      }
      case 'pressure':
      case 'platePoint':
      case 'face': {
        // One arrow at the centre of each loaded element (at most 60 per load).
        const ids = loadTargets(load).ids.slice(0, 60);
        ids.forEach((id, k) => {
          const element = load.kind === 'face' ? solidById.get(id) : plateById.get(id);
          if (!element) return;
          const pts = element.nodes.map((n) => nodes.get(n)).filter((x): x is Vec3 => !!x);
          if (pts.length === 0) return;
          const c: Vec3 = [0, 1, 2].map(
            (d) => pts.reduce((s, p) => s + p[d], 0) / pts.length,
          ) as Vec3;
          const value = load.kind === 'platePoint' ? load.P : load.p;
          let axis: Vec3 = [0, 1, 0];
          if (load.direction in GLOBAL) axis = GLOBAL[load.direction];
          else if (load.kind !== 'face' && pts.length === 4) {
            axis = unit(
              cross(
                [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]],
                [pts[3][0] - pts[1][0], pts[3][1] - pts[1][1], pts[3][2] - pts[1][2]],
              ),
            );
          }
          const unitText = load.kind === 'platePoint' ? 'kN' : 'kN/m²';
          force(
            at(c),
            axis,
            value,
            label(load) && k === 0 ? `${num(Math.abs(value))} ${unitText}` : null,
          );
        });
        break;
      }
    }
  }
}

// ---- Report --------------------------------------------------------------------------------

const RESTRAINT_NAMES = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];

function supportName(restraints: boolean[], plane: boolean): string {
  if (!restraints.some(Boolean)) return '-';
  if (plane) {
    const [ux, uy, , , , rz] = restraints;
    if (ux && uy) return rz ? 'Fixed' : 'Pinned';
    if (uy && !rz) return 'Roller (free in X)';
    if (ux && !rz) return 'Roller (free in Y)';
  }
  if (restraints.every(Boolean)) return 'Fixed';
  return restraints
    .map((r, k) => (r ? RESTRAINT_NAMES[k] : ''))
    .filter(Boolean)
    .join(' ');
}

function loadRow(load: ProjectLoad3D): string[] {
  const targets = loadTargets(load).ids;
  const on =
    targets.length > 6
      ? `${targets.slice(0, 6).join(', ')} … (${targets.length})`
      : targets.join(', ');
  switch (load.kind) {
    case 'nodal': {
      const parts = (['fx', 'fy', 'fz', 'mx', 'my', 'mz'] as const)
        .filter((k) => load[k] !== 0)
        .map((k) => `${k.toUpperCase()} = ${num(load[k])}`)
        .join(', ');
      return [load.id, 'Nodal (kN, kNm)', `Nodes ${on}`, parts || '0', 'global axes'];
    }
    case 'distributed': {
      const trapezoid = load.w2 !== undefined && load.w2 !== load.w1;
      return [
        load.id,
        trapezoid ? 'Trapezoidal' : 'Uniform',
        `Members ${on}`,
        trapezoid ? `${num(load.w1)} to ${num(load.w2 ?? load.w1)} kN/m` : `${num(load.w1)} kN/m`,
        `${load.direction}, from ${num(load.a ?? 0)} m to ${load.b === undefined ? 'end' : `${num(load.b)} m`}`,
      ];
    }
    case 'point':
      return [
        load.id,
        'Point',
        `Members ${on}`,
        `${num(load.P)} kN`,
        `${load.direction}, at ${num(load.a)} m`,
      ];
    case 'moment':
      return [
        load.id,
        'Moment',
        `Members ${on}`,
        `${num(load.M)} kNm`,
        `about ${load.direction}, at ${num(load.a)} m`,
      ];
    case 'pressure':
      return [load.id, 'Plate pressure', `Plates ${on}`, `${num(load.p)} kN/m²`, load.direction];
    case 'platePoint':
      return [
        load.id,
        'Plate point load',
        `Plates ${on}`,
        `${num(load.P)} kN`,
        `${load.direction}, at xi = ${num(load.xi)}, eta = ${num(load.eta)}`,
      ];
    case 'face':
      return [
        load.id,
        'Solid face load',
        `Solids ${on}`,
        `${num(load.p)} kN/m²`,
        `face ${load.face}, ${load.direction}`,
      ];
  }
}

/** Builds the report and returns the jsPDF document (call `.save()` or `.output()`). */
export function buildReport3D(input: ReportInput3D): jsPDF {
  const { project, result, design } = input;
  const plane = isPlane(project);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: input.compress ?? true });
  const date = input.date ?? new Date();
  let y = MARGIN;

  const lastTableY = () =>
    (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
  const ensure = (height: number) => {
    if (y + height > PAGE_H - MARGIN - 8) {
      doc.addPage();
      y = MARGIN;
    }
  };
  const heading = (text: string) => {
    ensure(18);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...ACCENT);
    doc.text(pdfText(text), MARGIN, y + 4);
    doc.setDrawColor(...ACCENT);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, y + 6, PAGE_W - MARGIN, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK);
    y += 10;
  };
  const subheading = (text: string) => {
    ensure(14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(pdfText(text), MARGIN, y + 3);
    doc.setFont('helvetica', 'normal');
    y += 5;
  };
  const paragraph = (text: string, size = 8.5, colour: Rgb = MUTED) => {
    doc.setFontSize(size);
    doc.setTextColor(...colour);
    const lines = doc.splitTextToSize(pdfText(text), PAGE_W - 2 * MARGIN) as string[];
    ensure(lines.length * size * 0.42 + 2);
    doc.text(lines, MARGIN, y + 3);
    y += lines.length * size * 0.42 + 3;
    doc.setTextColor(...INK);
  };
  const table = (
    head: string[],
    body: RowInput[],
    options: { fail?: (row: number) => boolean; what?: string } = {},
  ) => {
    const cut = body.length > MAX_ROWS;
    autoTable(doc, {
      head: [head.map(pdfText)],
      body: cut ? body.slice(0, MAX_ROWS) : body,
      startY: y,
      margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + 6 },
      theme: 'grid',
      styles: {
        fontSize: head.length > 8 ? 6.5 : 7.5,
        cellPadding: 1.1,
        textColor: INK,
        lineColor: [226, 232, 240],
        lineWidth: 0.15,
      },
      headStyles: { fillColor: [241, 245, 249], textColor: INK, fontStyle: 'bold' },
      didParseCell: (data) => {
        if (typeof data.cell.raw === 'string') data.cell.text = [pdfText(data.cell.raw)];
        if (data.section === 'body' && options.fail?.(data.row.index)) {
          data.cell.styles.textColor = [185, 28, 28];
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });
    y = lastTableY() + 6;
    if (cut) {
      paragraph(
        `Only the first ${MAX_ROWS} of ${body.length} ${options.what ?? 'rows'} are listed; ` +
          'the full tables are in the app.',
        7.5,
      );
    }
  };
  /** A figure: one front view in plane mode, otherwise the given views side by side. */
  const figure = (
    title: string,
    height: number,
    options: Omit<FigureOptions, 'view'>,
    views: View[] = [VIEWS.iso],
  ) => {
    const shown = plane ? [VIEWS.front] : views;
    ensure(height + 8);
    subheading(title);
    const gap = 3;
    const w = (PAGE_W - 2 * MARGIN - gap * (shown.length - 1)) / shown.length;
    shown.forEach((view, k) => {
      drawFigure(doc, input, { x: MARGIN + k * (w + gap), y, w, h: height }, { ...options, view });
    });
    y += height + 6;
  };

  // ---- Title block ----
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 26, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('FrameForge', MARGIN, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(
    plane ? 'Structural calculation report - plane frame' : 'Structural calculation report',
    MARGIN,
    19,
  );
  doc.text(date.toISOString().slice(0, 10), PAGE_W - MARGIN, 19, { align: 'right' });
  y = 34;
  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(pdfText(project.name), MARGIN, y);
  doc.setFont('helvetica', 'normal');
  y += 3;
  if (project.description) paragraph(project.description, 9);

  const peaks = resultPeaks3D(result);
  const ratios = Object.values(design).map((d) => d.result.utilisation);
  const worst = ratios.length ? Math.max(...ratios) : null;
  const grade = STEEL_GRADES.find((g) => g.name === project.design.grade) ?? STEEL_GRADES[0];
  y += 2;
  const summaryHead = ['Nodes', 'Members'];
  const summaryRow = [String(project.nodes.length), String(project.members.length)];
  if (project.plates.length > 0) {
    summaryHead.push('Plates');
    summaryRow.push(String(project.plates.length));
  }
  if (project.solids.length > 0) {
    summaryHead.push('Solids');
    summaryRow.push(String(project.solids.length));
  }
  summaryHead.push('Equations', 'Max deflection', 'Max |M|', 'Max |N|', 'Max utilisation');
  summaryRow.push(
    String(result.dofCount),
    `${num(result.maxDisplacement * 1000)} mm`,
    `${num(Math.max(peaks.Mz, peaks.My))} kNm`,
    `${num(peaks.N)} kN`,
    worst === null ? '-' : `${worst.toFixed(2)} ${worst <= 1 ? '(OK)' : '(FAIL)'}`,
  );
  if (input.modal && input.modal.modes.length > 0) {
    summaryHead.push('f1');
    summaryRow.push(`${num(input.modal.modes[0].frequency)} Hz`);
  }
  table(summaryHead, [summaryRow]);

  figure('Model, loads and support reactions', plane ? 92 : 110, {
    loads: true,
    reactions: true,
    labels: true,
  });
  if (input.shareUrl && input.shareUrl.length < 1900) {
    doc.setFontSize(8);
    doc.setTextColor(...ACCENT);
    ensure(6);
    doc.textWithLink('Open this model in FrameForge', MARGIN, y + 2, { url: input.shareUrl });
    doc.setTextColor(...INK);
    y += 6;
  }
  if (!plane) figure('Front and top views', 70, { labels: true }, [VIEWS.front, VIEWS.top]);

  // ---- Inputs ----
  heading('1. Input data');
  paragraph(
    'Units: kN, m, kNm; E in GPa, A in cm², I and J in cm4, plate thickness in mm. Global axes are ' +
      'right-handed with Y up. Linear elastic, small-displacement analysis by the direct stiffness / ' +
      'finite element method (Euler-Bernoulli beams, pin-ended trusses, MITC4 flat shells, ' +
      'incompatible-mode hexahedra).' +
      (plane
        ? ' Plane frame: the structure lies in the XY plane and every node is held out of plane ' +
          '(uz, rx, ry), so it behaves as a 2D frame or truss.'
        : '') +
      (project.selfWeight ? ' Self-weight of every element is included (gravity along -Y).' : ''),
  );
  const supportOf = new Map(project.supports.map((s) => [s.node, s.restraints]));
  table(
    plane ? ['Node', 'X (m)', 'Y (m)', 'Support'] : ['Node', 'X (m)', 'Y (m)', 'Z (m)', 'Support'],
    project.nodes.map((n) => {
      const support = supportName(supportOf.get(n.id) ?? [], plane);
      return plane
        ? [n.id, num(n.x), num(n.y), support]
        : [n.id, num(n.x), num(n.y), num(n.z), support];
    }),
    { what: 'nodes' },
  );
  table(
    ['Material', 'E (GPa)', 'nu', 'Weight (kN/m³)'],
    project.materials.map((m) => [m.name, num(m.E), num(m.nu), num(m.density)]),
  );
  if (project.members.length > 0) {
    table(
      plane
        ? ['Member', 'Start', 'End', 'Type', 'Section', 'L (m)', 'A (cm²)', 'I (cm4)', 'Hinges']
        : [
            'Member',
            'Start',
            'End',
            'Type',
            'Section',
            'Material',
            'L (m)',
            'A',
            'Iz',
            'Iy',
            'J',
            'beta',
            'Releases',
          ],
      project.members.map((m) => {
        const p = memberProps3D(project, m);
        const r = result.members[m.id];
        const releases = (end: 'releaseI' | 'releaseJ', name: string) => {
          const keys = Object.keys(m[end] ?? {});
          return keys.length > 0 ? `${name}: ${keys.join(' ')}` : '';
        };
        if (plane) {
          const hinges = [m.releaseI?.mz ? 'start' : '', m.releaseJ?.mz ? 'end' : '']
            .filter(Boolean)
            .join(' + ');
          return [
            m.id,
            m.i,
            m.j,
            m.type === 'beam' ? 'frame' : 'truss',
            m.section,
            num(r?.length ?? 0),
            num(p.A),
            num(p.Iz),
            hinges || '-',
          ];
        }
        return [
          m.id,
          m.i,
          m.j,
          m.type,
          m.section,
          m.material,
          num(r?.length ?? 0),
          num(p.A),
          num(p.Iz),
          num(p.Iy),
          num(p.J),
          num(m.beta ?? 0),
          [releases('releaseI', 'i'), releases('releaseJ', 'j')].filter(Boolean).join('; ') || '-',
        ];
      }),
      { what: 'members' },
    );
  }
  if (project.plates.length > 0) {
    table(
      ['Plate', 'Nodes', 'Thickness (mm)', 'Material'],
      project.plates.map((p) => [p.id, p.nodes.join(' '), num(p.thickness), p.material]),
      { what: 'plates' },
    );
  }
  if (project.solids.length > 0) {
    table(
      ['Solid', 'Nodes', 'Material'],
      project.solids.map((s) => [s.id, s.nodes.join(' '), s.material]),
      { what: 'solids' },
    );
  }
  if (project.customSections.length > 0) {
    table(
      ['Custom section', 'A (cm²)', 'Iz (cm4)', 'Iy (cm4)', 'J (cm4)'],
      project.customSections.map((s) => [s.name, num(s.A), num(s.Iz), num(s.Iy), num(s.J)]),
    );
  }
  if (project.loads.length > 0) {
    table(
      ['Load', 'Type', 'Applied to', 'Magnitude', 'Position / direction'],
      project.loads.map(loadRow),
      {
        what: 'loads',
      },
    );
  }
  if (project.masses && project.masses.length > 0) {
    table(
      ['Node', 'Lumped mass (t)'],
      project.masses.map((m) => [m.node, num(m.mass)]),
    );
  }

  // ---- Results ----
  heading('2. Analysis results');
  paragraph(
    'Sign conventions: reactions act on the structure in global axes; member forces are in the ' +
      "member's local axes (x along the member, y 'web up'); axial force N is positive in tension; " +
      'bending moments are drawn on the tension side of the member.',
  );
  const [ex, ey, ez] = result.appliedLoad;
  const sums = Object.values(result.reactions).reduce(
    (s, r) => [s[0] + r.fx, s[1] + r.fy, s[2] + r.fz],
    [0, 0, 0],
  );
  table(
    plane
      ? ['Equilibrium', 'Sum Fx (kN)', 'Sum Fy (kN)']
      : ['Equilibrium', 'Sum Fx (kN)', 'Sum Fy (kN)', 'Sum Fz (kN)'],
    [
      plane ? ['Applied loads', num(ex), num(ey)] : ['Applied loads', num(ex), num(ey), num(ez)],
      plane
        ? ['Reactions', num(sums[0]), num(sums[1])]
        : ['Reactions', num(sums[0]), num(sums[1]), num(sums[2])],
      plane
        ? ['Residual', num(result.equilibrium[0]), num(result.equilibrium[1])]
        : [
            'Residual',
            num(result.equilibrium[0]),
            num(result.equilibrium[1]),
            num(result.equilibrium[2]),
          ],
    ],
  );
  const reactions = Object.entries(result.reactions);
  table(
    plane
      ? ['Support node', 'Rx (kN)', 'Ry (kN)', 'Mz (kNm)']
      : ['Support node', 'Rx (kN)', 'Ry (kN)', 'Rz (kN)', 'Mx (kNm)', 'My (kNm)', 'Mz (kNm)'],
    reactions.map(([id, r]) =>
      plane
        ? [id, num(r.fx), num(r.fy), num(r.mz)]
        : [id, num(r.fx), num(r.fy), num(r.fz), num(r.mx), num(r.my), num(r.mz)],
    ),
    { what: 'reactions' },
  );
  if (project.members.length > 0) {
    table(
      plane
        ? [
            'Member',
            'N min (kN)',
            'N max (kN)',
            'V max (kN)',
            'M min (kNm)',
            'M max (kNm)',
            'Deflection (mm)',
          ]
        : ['Member', 'N min', 'N max', '|Vy|', '|Vz|', '|T|', '|My|', '|Mz|', 'd (mm)'],
      project.members.map((m) => {
        const r = result.members[m.id];
        if (!r) return [m.id, '-', '-', '-', '-', '-', '-'];
        if (plane) {
          const mz = r.stations.map((s) => s.Mz);
          return [
            m.id,
            num(r.minAxial.value),
            num(r.maxAxial.value),
            num(Math.abs(r.maxAbsVy.value)),
            num(Math.min(...mz)),
            num(Math.max(...mz)),
            num(Math.abs(r.maxAbsDeflection.value) * 1000),
          ];
        }
        return [
          m.id,
          num(r.minAxial.value),
          num(r.maxAxial.value),
          num(Math.abs(r.maxAbsVy.value)),
          num(Math.abs(r.maxAbsVz.value)),
          num(Math.abs(r.maxAbsTorsion.value)),
          num(Math.abs(r.maxAbsMy.value)),
          num(Math.abs(r.maxAbsMz.value)),
          num(Math.abs(r.maxAbsDeflection.value) * 1000),
        ];
      }),
      { what: 'members' },
    );
    if (!plane) {
      subheading('Member end forces (local axes, forces of the joints on the member)');
      table(
        ['Member', 'End', 'Fx', 'Fy', 'Fz', 'Mx', 'My', 'Mz'],
        project.members.flatMap((m) => {
          const f = result.members[m.id]?.endForces;
          if (!f) return [];
          return [
            [m.id, m.i, ...f.slice(0, 6).map((v) => num(v))],
            ['', m.j, ...f.slice(6, 12).map((v) => num(v))],
          ];
        }),
        { what: 'rows' },
      );
    }
  }
  table(
    plane
      ? ['Node', 'dx (mm)', 'dy (mm)', 'Rotation (mrad)']
      : ['Node', 'ux (mm)', 'uy (mm)', 'uz (mm)', 'rx (mrad)', 'ry (mrad)', 'rz (mrad)'],
    project.nodes.map((n) => {
      const d = result.displacements[n.id] ?? { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 };
      return plane
        ? [n.id, num(d.ux * 1000), num(d.uy * 1000), num(d.rz * 1000)]
        : [
            n.id,
            num(d.ux * 1000),
            num(d.uy * 1000),
            num(d.uz * 1000),
            num(d.rx * 1000),
            num(d.ry * 1000),
            num(d.rz * 1000),
          ];
    }),
    { what: 'nodes' },
  );
  if (project.plates.length > 0) {
    subheading('Plate stresses (element centre; von Mises maximum over both surfaces and corners)');
    table(
      ['Plate', 'Nx', 'Ny', 'Nxy (kN/m)', 'Mx', 'My', 'Mxy (kNm/m)', 'sigma vm max (MPa)'],
      project.plates.map((p) => {
        const r = result.plates[p.id];
        if (!r) return [p.id, '-', '-', '-', '-', '-', '-', '-'];
        const c = r.center;
        return [
          p.id,
          num(c.Nx),
          num(c.Ny),
          num(c.Nxy),
          num(c.Mx),
          num(c.My),
          num(c.Mxy),
          num(r.maxVonMises / 1000),
        ];
      }),
      { what: 'plates' },
    );
  }
  if (project.solids.length > 0) {
    subheading('Solid stresses at the element centre (MPa)');
    table(
      ['Solid', 'sigma 1', 'sigma 3', 'sigma vm (centre)', 'sigma vm max (corners)'],
      project.solids.map((s) => {
        const r = result.solids[s.id];
        if (!r) return [s.id, '-', '-', '-', '-'];
        return [
          s.id,
          num(r.center.s1 / 1000),
          num(r.center.s3 / 1000),
          num(r.center.vonMises / 1000),
          num(r.maxVonMises / 1000),
        ];
      }),
      { what: 'solids' },
    );
  }
  if (result.warnings.length > 0) {
    subheading('Warnings');
    for (const w of result.warnings.slice(0, 20)) paragraph(w, 7.5, [185, 28, 28]);
  }

  // ---- Diagrams ----
  heading('3. Diagrams');
  const scales = resultScales3D(project, result);
  if (project.members.length > 0) {
    const kinds: DiagramKind3D[] = plane ? ['Mz', 'Vy', 'N'] : ['Mz', 'My', 'Vy', 'Vz', 'T', 'N'];
    const titles: Record<DiagramKind3D, string> = plane
      ? {
          ...DIAGRAM_TITLE,
          Mz: 'Bending moment diagram (kNm)',
          Vy: 'Shear force diagram (kN)',
          N: 'Axial force diagram (kN) - tension blue, compression red',
        }
      : DIAGRAM_TITLE;
    for (const kind of kinds) {
      if (peaks[kind] > 1e-9) figure(titles[kind], plane ? 84 : 96, { diagram: kind });
    }
  }
  figure(`Deflected shape (magnified x${num(scales.deform, 2)})`, plane ? 84 : 96, {
    deformed: true,
  });
  for (const image of input.images ?? []) {
    const w = PAGE_W - 2 * MARGIN;
    const h = Math.min(w / Math.max(image.aspect, 0.2), 160);
    ensure(h + 8);
    subheading(image.title);
    doc.addImage(image.dataUrl, 'PNG', MARGIN, y, h * image.aspect > w ? w : h * image.aspect, h);
    y += h + 6;
  }

  // ---- Design ----
  heading('4. Steel design checks - IS 800:2007');
  const checked = project.members.filter((m) => design[m.id]);
  if (checked.length === 0) {
    paragraph('No members use a rolled ISMB / ISMC section, so no design checks were run.');
  } else {
    const k =
      project.design.kz === project.design.ky
        ? `Effective length factor K = ${num(project.design.kz)} on both axes`
        : `Effective length factors Kz = ${num(project.design.kz)} (major axis) and Ky = ${num(project.design.ky)} (minor axis)`;
    paragraph(
      `Limit state design to IS 800:2007 with partial safety factor 1.10 on yielding and buckling. Steel grade ` +
        `${grade.name} (fy = ${grade.fy} MPa, fu = ${grade.fu} MPa). ${k}` +
        (checked.some((m) => m.kz !== undefined || m.ky !== undefined)
          ? ', with member overrides where listed. '
          : '. ') +
        (project.design.laterallyRestrained
          ? 'Compression flanges are taken as laterally restrained, so lateral-torsional buckling is not critical.'
          : 'Lateral-torsional buckling is checked over the full member length.') +
        (plane
          ? ''
          : ' Mz is major-axis bending (Iz = Izz of the rolled section) and My minor-axis bending; ' +
            'biaxial interaction to cl. 9.3.1.1 (simplified) and 9.3.2.2. Torsion is not checked.') +
        ' The analysis loads are used directly as design loads: apply load factors to the input if required.',
    );
    figure('Utilisation ratio per member', plane ? 84 : 96, { utilisation: true });
    table(
      ['Member', 'Section', 'Class', 'Governing check', 'Clause', 'Ratio', 'Status'],
      checked.map((m) => {
        const d = design[m.id].result;
        const g = d.checks.find((c) => c.id === d.governing);
        return [
          m.id,
          m.section,
          d.sectionClass,
          g?.name ?? 'no load',
          g?.clause ?? '-',
          d.utilisation.toFixed(2),
          d.ok ? 'OK' : 'FAIL',
        ];
      }),
      { fail: (row) => !design[checked[row].id].result.ok, what: 'members' },
    );
    const detail: RowInput[] = [];
    const failing: boolean[] = [];
    for (const m of checked) {
      for (const c of design[m.id].result.checks) {
        detail.push([
          m.id,
          c.name,
          c.clause,
          `${num(c.demand)} ${c.unit}`,
          `${num(c.capacity)} ${c.unit}`,
          c.ratio.toFixed(2),
        ]);
        failing.push(!c.ok);
      }
    }
    if (detail.length > 0 && detail.length <= MAX_ROWS) {
      subheading('All checks');
      table(['Member', 'Check', 'Clause', 'Demand', 'Capacity', 'Ratio'], detail, {
        fail: (row) => failing[row],
      });
    }
    const warnings = checked.flatMap((m) =>
      design[m.id].result.warnings.map((w) => `${m.id}: ${w}`),
    );
    for (const w of warnings.slice(0, 20)) paragraph(w, 7.5, [185, 28, 28]);
  }

  // ---- Modal ----
  if (input.modal && input.modal.modes.length > 0) {
    heading('5. Natural frequencies');
    const modal = input.modal;
    paragraph(
      `Consistent mass matrices from the material densities` +
        (project.masses && project.masses.length > 0 ? ' plus lumped nodal masses' : '') +
        `; total mass ${num(modal.totalMass)} t, ${modal.dofCount} dynamic degrees of freedom. ` +
        'Effective modal mass is given as a percentage of the total mass.',
    );
    table(
      plane
        ? ['Mode', 'f (Hz)', 'T (s)', 'omega (rad/s)', 'mX %', 'mY %']
        : ['Mode', 'f (Hz)', 'T (s)', 'omega (rad/s)', 'mX %', 'mY %', 'mZ %'],
      modal.modes.map((m, k) => [
        String(k + 1),
        num(m.frequency),
        num(m.period),
        num(m.omega),
        ...m.massFraction.slice(0, plane ? 2 : 3).map((v) => (v * 100).toFixed(1)),
      ]),
    );
    for (const w of modal.warnings.slice(0, 5)) paragraph(w, 7.5, [185, 28, 28]);
    figure(`Mode 1 shape (f = ${num(modal.modes[0].frequency)} Hz)`, plane ? 84 : 96, { mode: 0 });
  }

  paragraph(
    'FrameForge is an educational tool. Results must be independently verified by a qualified engineer before ' +
      'being used for design or construction.',
    7.5,
  );

  // ---- Footers ----
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(pdfText(`${project.name} - generated by FrameForge`), MARGIN, PAGE_H - 8);
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
  }
  return doc;
}

export function reportFileName(project: Pick<Project3D, 'name'>): string {
  const slug = project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'frameforge'}-report.pdf`;
}
