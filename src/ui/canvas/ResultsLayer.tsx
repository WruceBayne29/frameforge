import { memo } from 'react';
import { resultPeaks } from '../../model';
import type { MemberDesign, Project, ResultScales } from '../../model';
import type { AnalysisResult, MemberResult, Station } from '../../solver';
import { fmt } from '../format';
import type { DiagramKind } from '../store';
import { Arrow, MomentArc } from './glyphs';
import type { Point, View } from './view';
import { toScreen } from './view';

interface Props {
  project: Project;
  result: AnalysisResult;
  design: Record<string, MemberDesign>;
  view: View;
  diagram: DiagramKind;
  deformed: boolean;
  reactions: boolean;
  utilisation: boolean;
  /** Show every value label; when false only the significant ones are drawn. */
  labels: boolean;
  scales: ResultScales;
}

/** World position of a point at distance x along a member, offset by `offset` along local y. */
function along(start: Point, m: MemberResult, x: number, offset: number): Point {
  return [start[0] + m.cos * x - m.sin * offset, start[1] + m.sin * x + m.cos * offset];
}

function Diagram({
  kind,
  member,
  start,
  view,
  unit,
  peak,
  labelThreshold,
}: {
  labelThreshold: number;
  kind: 'N' | 'V' | 'M';
  member: MemberResult;
  start: Point;
  view: View;
  unit: number;
  peak: number;
}) {
  // Bending moments are drawn on the tension side (sagging below a horizontal beam).
  const ordinate = (s: Station) => (kind === 'M' ? -s.M : s[kind]) * unit;
  const screen = (x: number, off: number) => {
    const w = along(start, member, x, off);
    return toScreen(view, w[0], w[1]);
  };
  const stations = member.stations;
  const significant = stations.some((s) => Math.abs(s[kind]) > 1e-6 * Math.max(peak, 1e-9));
  if (!significant) return null;

  const outline = stations.map((s) => screen(s.x, ordinate(s)));
  const polygon = [screen(0, 0), ...outline, screen(member.length, 0)];

  const mean = stations.reduce((sum, s) => sum + s[kind], 0) / stations.length;
  const signClass = kind === 'N' ? (mean >= 0 ? 'tension' : 'compression') : '';
  const first = stations[0];
  const last = stations[stations.length - 1];
  const constant = stations.every(
    (s) => Math.abs(s[kind] - first[kind]) < 1e-6 * Math.max(peak, 1e-9),
  );

  // A constant axial force (every truss member) reads best as the member itself, coloured by
  // sign and weighted by magnitude; offset bands would overlap each other in a truss.
  if (kind === 'N' && constant) {
    const a = screen(0, 0);
    const b = screen(member.length, 0);
    const value = first.N;
    const mid = screen(member.length / 2, 0);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    const side = ny > 0 ? -1 : 1;
    return (
      <g className={`diagram diagram-N ${signClass}`}>
        <line
          className="axial-bar"
          x1={a[0]}
          y1={a[1]}
          x2={b[0]}
          y2={b[1]}
          strokeWidth={4 + 10 * (Math.abs(value) / peak)}
        />
        {Math.abs(value) >= labelThreshold * peak && (
          <text
            className="diagram-label"
            x={mid[0] + nx * side * 13}
            y={mid[1] + ny * side * 13 + 4}
            textAnchor="middle"
          >
            {fmt(value)}
          </text>
        )}
      </g>
    );
  }

  // Label the ends and the extremes, skipping negligible values and near-duplicates.
  const candidates: Station[] = [];
  candidates.push(first, last);
  if (kind === 'M') {
    const hi = stations.reduce((a, b) => (b.M > a.M ? b : a));
    const lo = stations.reduce((a, b) => (b.M < a.M ? b : a));
    candidates.push(hi, lo);
  }
  const labels: Station[] = [];
  for (const s of candidates) {
    if (Math.abs(s[kind]) < labelThreshold * peak) continue;
    const duplicate = labels.some(
      (l) =>
        Math.abs(l.x - s.x) < 0.08 * member.length && Math.abs(l[kind] - s[kind]) < 0.02 * peak,
    );
    if (!duplicate) labels.push(s);
  }

  return (
    <g className={`diagram diagram-${kind} ${signClass}`}>
      <polygon className="diagram-fill" points={polygon.map((p) => p.join(',')).join(' ')} />
      <polyline className="diagram-line" points={outline.map((p) => p.join(',')).join(' ')} />
      {labels.map((s, k) => {
        const off = ordinate(s);
        const p = screen(s.x, off);
        const base = screen(s.x, 0);
        const d = Math.hypot(p[0] - base[0], p[1] - base[1]) || 1;
        const ux = (p[0] - base[0]) / d;
        const uy = (p[1] - base[1]) / d;
        return (
          <text
            key={k}
            className="diagram-label"
            x={p[0] + ux * 11}
            y={p[1] + uy * 11 + 4}
            textAnchor="middle"
          >
            {fmt(s[kind])}
          </text>
        );
      })}
    </g>
  );
}

export const ResultsLayer = memo(function ResultsLayer({
  project,
  result,
  design,
  view,
  diagram,
  deformed,
  reactions,
  utilisation,
  labels,
  scales,
}: Props) {
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const starts = new Map<string, Point>();
  for (const m of project.members) {
    const n = nodes.get(m.i);
    if (n) starts.set(m.id, [n.x, n.y]);
  }
  const peak = resultPeaks(result);
  const maxReaction = Object.values(result.reactions).reduce(
    (m, r) => Math.max(m, Math.abs(r.fx), Math.abs(r.fy)),
    0,
  );

  return (
    <g className="results-layer">
      {diagram !== 'none' &&
        project.members.map((m) => {
          const r = result.members[m.id];
          const start = starts.get(m.id);
          if (!r || !start) return null;
          return (
            <Diagram
              key={m.id}
              kind={diagram}
              member={r}
              start={start}
              view={view}
              unit={scales.diagram[diagram]}
              peak={peak[diagram]}
              labelThreshold={labels ? 0.02 : 0.3}
            />
          );
        })}

      {deformed &&
        project.members.map((m) => {
          const r = result.members[m.id];
          const start = starts.get(m.id);
          if (!r || !start) return null;
          const points = r.stations.map((s) => {
            const x = start[0] + r.cos * s.x + scales.deform * (r.cos * s.u - r.sin * s.v);
            const y = start[1] + r.sin * s.x + scales.deform * (r.sin * s.u + r.cos * s.v);
            return toScreen(view, x, y).join(',');
          });
          return <polyline key={m.id} className="deformed" points={points.join(' ')} />;
        })}

      {utilisation &&
        project.members.map((m) => {
          const d = design[m.id];
          const r = result.members[m.id];
          const start = starts.get(m.id);
          if (!d || !r || !start) return null;
          if (!labels && d.result.utilisation < 0.85) return null;
          const mid = along(start, r, r.length / 2, 0);
          const p = toScreen(view, mid[0], mid[1]);
          return (
            <g key={m.id} className="util-label">
              <rect x={p[0] - 17} y={p[1] - 9} width={34} height={17} rx={8} />
              <text x={p[0]} y={p[1] + 4} textAnchor="middle">
                {d.result.utilisation.toFixed(2)}
              </text>
            </g>
          );
        })}

      {reactions &&
        Object.entries(result.reactions).map(([id, r]) => {
          const n = nodes.get(id);
          if (!n) return null;
          const p = toScreen(view, n.x, n.y);
          const tiny = 1e-6 * Math.max(maxReaction, 1);
          const parts = [];
          const gap = 30;
          const len = 34;
          if (Math.abs(r.fx) > tiny) {
            const s = Math.sign(r.fx);
            const tip: Point = [p[0] - s * gap, p[1]];
            const tail: Point = [tip[0] - s * len, p[1]];
            parts.push(
              <g key="fx">
                <Arrow from={tail} to={tip} />
                <text x={tail[0] - s * 4} y={p[1] + 14} textAnchor={s > 0 ? 'end' : 'start'}>
                  {fmt(Math.abs(r.fx))} kN
                </text>
              </g>,
            );
          }
          if (Math.abs(r.fy) > tiny) {
            const s = Math.sign(r.fy);
            // An upward reaction is drawn below the support pointing up at it.
            const tip: Point = [p[0], p[1] + s * gap];
            const tail: Point = [p[0], tip[1] + s * len];
            parts.push(
              <g key="fy">
                <Arrow from={tail} to={tip} />
                <text x={p[0]} y={tail[1] + (s > 0 ? 13 : -5)} textAnchor="middle">
                  {fmt(Math.abs(r.fy))} kN
                </text>
              </g>,
            );
          }
          if (Math.abs(r.mz) > tiny) {
            parts.push(
              <g key="mz">
                <MomentArc at={p} ccw={r.mz > 0} radius={22} />
                <text x={p[0] - 26} y={p[1] - 24} textAnchor="end">
                  {fmt(Math.abs(r.mz))} kN·m
                </text>
              </g>,
            );
          }
          return (
            <g key={id} className="reaction">
              {parts}
            </g>
          );
        })}
    </g>
  );
});
