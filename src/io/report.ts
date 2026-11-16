/**
 * PDF calculation report: inputs, results, force diagrams and design checks. Figures are
 * drawn as vectors with jsPDF primitives, so they stay sharp at any zoom.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { RowInput } from 'jspdf-autotable';
import { STEEL_GRADES } from '../design-codes';
import { memberProps, modelBounds, resultPeaks, resultScales, utilisationRgb } from '../model';
import type { MemberDesign, Project } from '../model';
import type { AnalysisResult, MemberResult, Station } from '../solver';

export interface ReportInput {
  project: Project;
  result: AnalysisResult;
  design: Record<string, MemberDesign>;
  /** Shown in the header; defaults to today. */
  date?: Date;
  /** Link back to the live model, printed on the first page. */
  shareUrl?: string;
}

type Rgb = [number, number, number];
type Pt = [number, number];

const INK: Rgb = [15, 23, 42];
const MUTED: Rgb = [100, 116, 139];
const ACCENT: Rgb = [3, 105, 161];
const LOAD: Rgb = [220, 38, 38];
const REACTION: Rgb = [21, 128, 61];
const DEFORMED: Rgb = [124, 58, 237];
const DIAGRAM: Record<'N' | 'V' | 'M', Rgb> = {
  N: [37, 99, 235],
  V: [8, 145, 178],
  M: [234, 88, 12],
};
const COMPRESSION: Rgb = [220, 38, 38];

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 15;

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

interface FigureOptions {
  diagram?: 'N' | 'V' | 'M';
  deformed?: boolean;
  loads?: boolean;
  reactions?: boolean;
  utilisation?: boolean;
  labels?: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

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

/** Draws the structure (and optionally results) inside `box`. */
function drawFigure(
  doc: jsPDF,
  { project, result, design }: ReportInput,
  box: Box,
  options: FigureOptions,
): void {
  const bounds = modelBounds(project);
  const pad = 16;
  const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const scale = Math.min((box.w - 2 * pad) / w, (box.h - 2 * pad) / h);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const at = (x: number, y: number): Pt => [
    box.x + box.w / 2 + (x - cx) * scale,
    box.y + box.h / 2 - (y - cy) * scale,
  ];
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const scales = resultScales(project, result);
  const peaks = resultPeaks(result);
  const dense = project.members.length > 24;

  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.2);
  doc.rect(box.x, box.y, box.w, box.h);

  const along = (m: MemberResult, start: Pt, x: number, off: number): Pt =>
    at(start[0] + m.cos * x - m.sin * off, start[1] + m.sin * x + m.cos * off);

  // Force diagram.
  if (options.diagram) {
    const kind = options.diagram;
    const unit = scales.diagram[kind];
    doc.setFontSize(6.5);
    for (const member of project.members) {
      const r = result.members[member.id];
      const a = nodes.get(member.i);
      if (!r || !a) continue;
      const start: Pt = [a.x, a.y];
      const ordinate = (s: Station) => (kind === 'M' ? -s.M : s[kind]) * unit;
      if (!r.stations.some((s) => Math.abs(s[kind]) > 1e-6 * Math.max(peaks[kind], 1e-9))) continue;
      const outline = r.stations.map((s) => along(r, start, s.x, ordinate(s)));
      const mean = r.stations.reduce((sum, s) => sum + s[kind], 0) / r.stations.length;
      const colour = kind === 'N' && mean < 0 ? COMPRESSION : DIAGRAM[kind];
      doc.setFillColor(...colour);
      doc.setDrawColor(...colour);
      const s0 = r.stations[0];
      if (
        kind === 'N' &&
        r.stations.every((s) => Math.abs(s.N - s0.N) < 1e-6 * Math.max(peaks.N, 1e-9))
      ) {
        // Constant axial force: draw the member itself, weighted by the force.
        const p1 = along(r, start, 0, 0);
        const p2 = along(r, start, r.length, 0);
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
      polygon(doc, [along(r, start, 0, 0), ...outline, along(r, start, r.length, 0)], 'F');
      doc.setGState(doc.GState({ opacity: 1 }));
      doc.setLineWidth(0.25);
      polygon(doc, outline, 'S', false);

      const first = r.stations[0];
      const last = r.stations[r.stations.length - 1];
      const candidates: Station[] =
        kind === 'M'
          ? [
              first,
              last,
              r.stations.reduce((p, q) => (q.M > p.M ? q : p)),
              r.stations.reduce((p, q) => (q.M < p.M ? q : p)),
            ]
          : [first, last];
      const shown: Station[] = [];
      doc.setTextColor(...colour);
      for (const s of candidates) {
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
        const p = along(r, start, s.x, ordinate(s));
        const base = along(r, start, s.x, 0);
        const d = Math.hypot(p[0] - base[0], p[1] - base[1]) || 1;
        doc.text(
          num(s[kind]),
          p[0] + ((p[0] - base[0]) / d) * 2.5,
          p[1] + ((p[1] - base[1]) / d) * 2.5 + 0.8,
          {
            align: 'center',
          },
        );
      }
    }
  }

  // Members.
  for (const member of project.members) {
    const a = nodes.get(member.i);
    const b = nodes.get(member.j);
    if (!a || !b) continue;
    const p1 = at(a.x, a.y);
    const p2 = at(b.x, b.y);
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
        {
          align: 'center',
        },
      );
    }
  }

  // Deformed shape.
  if (options.deformed) {
    doc.setDrawColor(...DEFORMED);
    doc.setLineWidth(0.35);
    doc.setLineDashPattern([1.2, 0.8], 0);
    for (const member of project.members) {
      const r = result.members[member.id];
      const a = nodes.get(member.i);
      if (!r || !a) continue;
      const points = r.stations.map((s): Pt =>
        at(
          a.x + r.cos * s.x + scales.deform * (r.cos * s.u - r.sin * s.v),
          a.y + r.sin * s.x + scales.deform * (r.sin * s.u + r.cos * s.v),
        ),
      );
      polygon(doc, points, 'S', false);
    }
    doc.setLineDashPattern([], 0);
  }

  // Supports.
  doc.setDrawColor(71, 85, 105);
  doc.setFillColor(255, 255, 255);
  doc.setLineWidth(0.3);
  for (const s of project.supports) {
    const n = nodes.get(s.node);
    if (!n) continue;
    const [x, y] = at(n.x, n.y);
    const t = 2.6;
    if (s.kind === 'fixed') {
      doc.line(x - t * 1.3, y, x + t * 1.3, y);
      for (let k = 0; k < 5; k++) {
        const hx = x - t * 1.3 + (k + 0.5) * ((2.6 * t) / 5);
        doc.line(hx + 0.6, y, hx - 0.6, y + 1.3);
      }
    } else if (s.kind === 'rollerY') {
      doc.triangle(x, y, x - t * 1.2, y - t * 0.8, x - t * 1.2, y + t * 0.8, 'FD');
      doc.line(x - t * 1.2 - 1.2, y - t * 1.1, x - t * 1.2 - 1.2, y + t * 1.1);
    } else {
      doc.triangle(x, y, x - t * 0.8, y + t * 1.2, x + t * 0.8, y + t * 1.2, 'FD');
      const ground = s.kind === 'rollerX' ? y + t * 1.2 + 1.2 : y + t * 1.2;
      if (s.kind === 'rollerX') {
        doc.circle(x - 1, y + t * 1.2 + 0.6, 0.55, 'S');
        doc.circle(x + 1, y + t * 1.2 + 0.6, 0.55, 'S');
      }
      doc.line(x - t * 1.3, ground, x + t * 1.3, ground);
    }
  }

  // Loads.
  if (options.loads) {
    doc.setDrawColor(...LOAD);
    doc.setFillColor(...LOAD);
    doc.setTextColor(...LOAD);
    doc.setLineWidth(0.25);
    doc.setFontSize(6);
    const maxW = project.loads.reduce(
      (m, l) =>
        l.kind === 'distributed' ? Math.max(m, Math.abs(l.w1), Math.abs(l.w2 ?? l.w1)) : m,
      0,
    );
    const LEN = 8;
    for (const load of project.loads) {
      if (load.kind === 'nodal') {
        const n = nodes.get(load.node);
        if (!n) continue;
        const [x, y] = at(n.x, n.y);
        if (load.fx !== 0) {
          const s = Math.sign(load.fx);
          arrow(doc, [x - s * LEN, y], [x - s * 0.8, y]);
          doc.text(`${num(Math.abs(load.fx))} kN`, x - s * (LEN + 0.8), y - 0.9, {
            align: s > 0 ? 'right' : 'left',
          });
        }
        if (load.fy !== 0) {
          const s = Math.sign(load.fy);
          arrow(doc, [x, y + s * LEN], [x, y + s * 0.8]);
          if (!dense || Math.abs(load.fy) > 0)
            doc.text(`${num(Math.abs(load.fy))} kN`, x + 1, y + s * LEN + (s > 0 ? 1.5 : 0));
        }
        if (load.mz !== 0) {
          doc.circle(x, y, 2.6, 'S');
          doc.text(
            `${num(Math.abs(load.mz))} kNm ${load.mz > 0 ? '(acw)' : '(cw)'}`,
            x + 3.2,
            y - 2.6,
          );
        }
        continue;
      }
      const member = project.members.find((m) => m.id === load.member);
      const a = member && nodes.get(member.i);
      const b = member && nodes.get(member.j);
      if (!member || !a || !b) continue;
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const cos = (b.x - a.x) / length;
      const sin = (b.y - a.y) / length;
      const pointAt = (x: number): Pt => at(a.x + cos * x, a.y + sin * x);
      if (load.kind === 'moment') {
        const [x, y] = pointAt(load.a);
        doc.circle(x, y, 2.2, 'S');
        doc.text(`${num(Math.abs(load.M))} kNm ${load.M > 0 ? '(acw)' : '(cw)'}`, x + 2.8, y - 2.4);
        continue;
      }
      const axis: Pt =
        load.direction === 'localX'
          ? [cos, sin]
          : load.direction === 'localY'
            ? [-sin, cos]
            : load.direction === 'globalX'
              ? [1, 0]
              : [0, 1];
      if (load.kind === 'point') {
        const s = Math.sign(load.P) || 1;
        const dir: Pt = [axis[0] * s, -axis[1] * s];
        const [x, y] = pointAt(load.a);
        arrow(doc, [x - dir[0] * LEN, y - dir[1] * LEN], [x - dir[0] * 0.6, y - dir[1] * 0.6]);
        doc.text(
          `${num(Math.abs(load.P))} kN`,
          x - dir[0] * LEN + 1,
          y - dir[1] * LEN + (dir[1] > 0 ? -0.6 : 2.2),
        );
        continue;
      }
      const la = load.a ?? 0;
      const lb = load.b ?? length;
      const w2 = load.w2 ?? load.w1;
      const sign = Math.sign(Math.abs(load.w1) >= Math.abs(w2) ? load.w1 : w2) || 1;
      const dir: Pt = [axis[0] * sign, -axis[1] * sign];
      const count = Math.max(2, Math.round(((lb - la) * scale) / 5) + 1);
      const tails: Pt[] = [];
      for (let k = 0; k < count; k++) {
        const t = k / (count - 1);
        const wv = load.w1 + (w2 - load.w1) * t;
        const len = maxW > 0 ? (Math.abs(wv) / maxW) * 5.5 : 0;
        const [x, y] = pointAt(la + (lb - la) * t);
        const tip: Pt = [x - dir[0] * 0.7, y - dir[1] * 0.7];
        const tail: Pt = [tip[0] - dir[0] * (len + 0.8), tip[1] - dir[1] * (len + 0.8)];
        tails.push(tail);
        if (len > 0.8) arrow(doc, tail, tip, 1.2);
      }
      polygon(doc, tails, 'S', false);
      const mid = tails[Math.floor(tails.length / 2)];
      const label =
        Math.abs(load.w1 - w2) < 1e-9
          ? `${num(Math.abs(load.w1))} kN/m`
          : `${num(Math.abs(load.w1))} to ${num(Math.abs(w2))} kN/m`;
      doc.text(label, mid[0] - dir[0] * 1.5, mid[1] - dir[1] * 1.5 + 0.6, { align: 'center' });
    }
  }

  // Reactions.
  if (options.reactions) {
    doc.setDrawColor(...REACTION);
    doc.setFillColor(...REACTION);
    doc.setTextColor(...REACTION);
    doc.setLineWidth(0.3);
    doc.setFontSize(6);
    const big = Object.values(result.reactions).reduce(
      (m, r) => Math.max(m, Math.abs(r.fx), Math.abs(r.fy)),
      0,
    );
    for (const [id, r] of Object.entries(result.reactions)) {
      const n = nodes.get(id);
      if (!n) continue;
      const [x, y] = at(n.x, n.y);
      const tiny = 1e-6 * Math.max(big, 1);
      if (Math.abs(r.fx) > tiny) {
        const s = Math.sign(r.fx);
        arrow(doc, [x - s * 12, y], [x - s * 5.5, y]);
        doc.text(`${num(Math.abs(r.fx))} kN`, x - s * 12.6, y + 2.6, {
          align: s > 0 ? 'right' : 'left',
        });
      }
      if (Math.abs(r.fy) > tiny) {
        const s = Math.sign(r.fy);
        arrow(doc, [x, y + s * 12.5], [x, y + s * 6]);
        doc.text(`${num(Math.abs(r.fy))} kN`, x, y + s * 12.5 + (s > 0 ? 2.6 : -0.8), {
          align: 'center',
        });
      }
      if (Math.abs(r.mz) > tiny) {
        doc.text(`M = ${num(r.mz)} kNm`, x + 4, y - 4);
      }
    }
  }

  // Nodes.
  doc.setFontSize(6);
  for (const n of project.nodes) {
    const [x, y] = at(n.x, n.y);
    doc.setFillColor(...INK);
    doc.circle(x, y, 0.55, 'F');
    if (options.labels && !dense) {
      doc.setTextColor(...MUTED);
      doc.text(pdfText(n.id), x + 1, y - 1.2);
    }
  }
  doc.setTextColor(...INK);
}

/** Builds the report and returns the jsPDF document (call `.save()` or `.output()`). */
export function buildReport(input: ReportInput): jsPDF {
  const { project, result, design } = input;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
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
    options: { fail?: (row: number) => boolean } = {},
  ) => {
    autoTable(doc, {
      head: [head.map(pdfText)],
      body,
      startY: y,
      margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + 6 },
      theme: 'grid',
      styles: {
        fontSize: 7.5,
        cellPadding: 1.3,
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
  };
  const figure = (title: string, height: number, options: FigureOptions) => {
    ensure(height + 8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(pdfText(title), MARGIN, y + 3);
    doc.setFont('helvetica', 'normal');
    y += 5;
    drawFigure(doc, input, { x: MARGIN, y, w: PAGE_W - 2 * MARGIN, h: height }, options);
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
  doc.text('Structural calculation report', MARGIN, 19);
  doc.text(date.toISOString().slice(0, 10), PAGE_W - MARGIN, 19, { align: 'right' });
  y = 34;
  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(pdfText(project.name), MARGIN, y);
  doc.setFont('helvetica', 'normal');
  y += 3;
  if (project.description) paragraph(project.description, 9);

  const peaks = resultPeaks(result);
  const ratios = Object.values(design).map((d) => d.result.utilisation);
  const worst = ratios.length ? Math.max(...ratios) : null;
  const grade = STEEL_GRADES.find((g) => g.name === project.design.grade) ?? STEEL_GRADES[0];
  y += 2;
  table(
    [
      'Nodes',
      'Members',
      'Degrees of freedom',
      'Max deflection',
      'Max |M|',
      'Max |N|',
      'Max utilisation',
    ],
    [
      [
        String(project.nodes.length),
        String(project.members.length),
        String(result.dofCount),
        `${num(result.maxDisplacement * 1000)} mm`,
        `${num(peaks.M)} kNm`,
        `${num(peaks.N)} kN`,
        worst === null ? '-' : `${worst.toFixed(2)} ${worst <= 1 ? '(OK)' : '(FAIL)'}`,
      ],
    ],
  );

  figure('Model, loads and support reactions', 92, { loads: true, reactions: true, labels: true });
  if (input.shareUrl && input.shareUrl.length < 1900) {
    doc.setFontSize(8);
    doc.setTextColor(...ACCENT);
    ensure(6);
    doc.textWithLink('Open this model in FrameForge', MARGIN, y + 2, { url: input.shareUrl });
    doc.setTextColor(...INK);
    y += 6;
  }

  // ---- Inputs ----
  heading('1. Input data');
  paragraph(
    `Units: kN, m, kNm. Young's modulus E = ${num(project.E)} GPa. Linear elastic analysis by the direct ` +
      'stiffness method (Euler-Bernoulli frame and pin-ended truss elements, small displacements).',
  );
  const supportName: Record<string, string> = {
    fixed: 'Fixed',
    pinned: 'Pinned',
    rollerX: 'Roller (free in X)',
    rollerY: 'Roller (free in Y)',
  };
  table(
    ['Node', 'X (m)', 'Y (m)', 'Support'],
    project.nodes.map((n) => [
      n.id,
      num(n.x),
      num(n.y),
      supportName[project.supports.find((s) => s.node === n.id)?.kind ?? ''] ?? '-',
    ]),
  );
  table(
    ['Member', 'Start', 'End', 'Type', 'Section', 'L (m)', 'A (cm²)', 'I (cm4)', 'Hinges'],
    project.members.map((m) => {
      const p = memberProps(project, m);
      const r = result.members[m.id];
      const hinges = [m.releaseI ? 'start' : '', m.releaseJ ? 'end' : '']
        .filter(Boolean)
        .join(' + ');
      return [
        m.id,
        m.i,
        m.j,
        m.type,
        m.section,
        num(r?.length ?? 0),
        num(p.A),
        num(p.I),
        hinges || '-',
      ];
    }),
  );
  if (project.loads.length > 0) {
    table(
      ['Load', 'Type', 'Applied to', 'Magnitude', 'Position / direction'],
      project.loads.map((l) => {
        switch (l.kind) {
          case 'nodal':
            return [
              l.id,
              'Nodal',
              `Node ${l.node}`,
              `Fx = ${num(l.fx)} kN, Fy = ${num(l.fy)} kN, Mz = ${num(l.mz)} kNm`,
              'global axes',
            ];
          case 'distributed':
            return [
              l.id,
              l.w2 !== undefined && l.w2 !== l.w1 ? 'Trapezoidal' : 'Uniform',
              `Member ${l.member}`,
              l.w2 !== undefined && l.w2 !== l.w1
                ? `${num(l.w1)} to ${num(l.w2)} kN/m`
                : `${num(l.w1)} kN/m`,
              `${l.direction}, from ${num(l.a ?? 0)} m to ${l.b === undefined ? 'end' : `${num(l.b)} m`}`,
            ];
          case 'point':
            return [
              l.id,
              'Point',
              `Member ${l.member}`,
              `${num(l.P)} kN`,
              `${l.direction}, at ${num(l.a)} m`,
            ];
          case 'moment':
            return [l.id, 'Moment', `Member ${l.member}`, `${num(l.M)} kNm`, `at ${num(l.a)} m`];
        }
      }),
    );
  }

  // ---- Results ----
  heading('2. Analysis results');
  paragraph(
    'Sign conventions: reactions act on the structure in global axes; axial force N is positive in tension; ' +
      'bending moment M is positive when sagging and is drawn on the tension side of the member.',
  );
  const reactions = Object.entries(result.reactions);
  const sum = reactions.reduce((s, [, r]) => ({ fx: s.fx + r.fx, fy: s.fy + r.fy }), {
    fx: 0,
    fy: 0,
  });
  table(
    ['Support node', 'Rx (kN)', 'Ry (kN)', 'Mz (kNm)'],
    [
      ...reactions.map(([id, r]) => [id, num(r.fx), num(r.fy), num(r.mz)]),
      ['Sum', num(sum.fx), num(sum.fy), ''],
    ],
  );
  table(
    [
      'Member',
      'N min (kN)',
      'N max (kN)',
      'V max (kN)',
      'M min (kNm)',
      'M max (kNm)',
      'Deflection (mm)',
    ],
    project.members.map((m) => {
      const r = result.members[m.id];
      if (!r) return [m.id, '-', '-', '-', '-', '-', '-'];
      return [
        m.id,
        num(r.minAxial.value),
        num(r.maxAxial.value),
        num(Math.abs(r.maxAbsShear.value)),
        num(r.minMoment.value),
        num(r.maxMoment.value),
        num(Math.abs(r.maxAbsDeflection.value) * 1000),
      ];
    }),
  );
  table(
    ['Node', 'dx (mm)', 'dy (mm)', 'Rotation (mrad)'],
    project.nodes.map((n) => {
      const d = result.displacements[n.id];
      return [n.id, num((d?.ux ?? 0) * 1000), num((d?.uy ?? 0) * 1000), num((d?.rz ?? 0) * 1000)];
    }),
  );

  // ---- Diagrams ----
  heading('3. Diagrams');
  const scales = resultScales(project, result);
  if (peaks.M > 1e-9) figure('Bending moment diagram (kNm)', 84, { diagram: 'M' });
  if (peaks.V > 1e-9) figure('Shear force diagram (kN)', 84, { diagram: 'V' });
  if (peaks.N > 1e-9)
    figure('Axial force diagram (kN) - tension blue, compression red', 84, { diagram: 'N' });
  figure(`Deflected shape (magnified x${num(scales.deform, 2)})`, 84, { deformed: true });

  // ---- Design ----
  heading('4. Steel design checks - IS 800:2007');
  const checked = project.members.filter((m) => design[m.id]);
  if (checked.length === 0) {
    paragraph('No members use a rolled ISMB / ISMC section, so no design checks were run.');
  } else {
    paragraph(
      `Limit state design to IS 800:2007 with partial safety factor 1.10 on yielding and buckling. Steel grade ` +
        `${grade.name} (fy = ${grade.fy} MPa, fu = ${grade.fu} MPa). Effective length factor K = ` +
        `${num(project.design.effectiveLengthFactor)} on both axes. ` +
        (project.design.laterallyRestrained
          ? 'Compression flanges are taken as laterally restrained, so lateral-torsional buckling is not critical.'
          : 'Lateral-torsional buckling is checked over the full member length.') +
        ' The analysis loads are used directly as design loads: apply load factors to the input if required.',
    );
    figure('Utilisation ratio per member', 84, { utilisation: true });
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
      { fail: (row) => !design[checked[row].id].result.ok },
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
    if (detail.length > 0 && detail.length <= 400) {
      ensure(20);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text('All checks', MARGIN, y + 3);
      doc.setFont('helvetica', 'normal');
      y += 5;
      table(['Member', 'Check', 'Clause', 'Demand', 'Capacity', 'Ratio'], detail, {
        fail: (row) => failing[row],
      });
    }
    const warnings = checked.flatMap((m) =>
      design[m.id].result.warnings.map((w) => `${m.id}: ${w}`),
    );
    for (const w of warnings.slice(0, 20)) paragraph(w, 7.5, [185, 28, 28]);
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

export function reportFileName(project: Project): string {
  const slug = project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'frameforge'}-report.pdf`;
}
