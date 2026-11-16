import { useEffect, useState } from 'react';
import { modelSize } from '../../model';
import type { Project } from '../../model';
import type { InfluenceLine, Mode } from '../../solver';
import { fmt } from '../format';
import type { MemberGeometry } from './ModelLayer';
import type { Point, View } from './view';
import { toScreen } from './view';

/** Animated mode shape: the structure oscillates between ±the normalised shape. */
export function ModeShapeLayer({
  project,
  mode,
  geometries,
  view,
}: {
  project: Project;
  mode: Mode;
  geometries: Map<string, MemberGeometry>;
  view: View;
}) {
  const [phase, setPhase] = useState(1);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setPhase(Math.cos(((now - start) / 1000) * Math.PI * 1.4));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const amplitude = 0.07 * modelSize(project) * phase;
  return (
    <g className="mode-layer">
      {[...geometries.values()].map((g) => {
        const shape = mode.members[g.member.id];
        if (!shape) return null;
        const points = shape.map((s) => {
          const x = g.a.x + g.cos * s.x + amplitude * (g.cos * s.u - g.sin * s.v);
          const y = g.a.y + g.sin * s.x + amplitude * (g.sin * s.u + g.cos * s.v);
          return toScreen(view, x, y).join(',');
        });
        return <polyline key={g.member.id} className="mode-shape" points={points.join(' ')} />;
      })}
      {project.nodes.map((n) => {
        const d = mode.displacements[n.id];
        if (!d) return null;
        const p = toScreen(view, n.x + amplitude * d.ux, n.y + amplitude * d.uy);
        return <circle key={n.id} className="mode-node" cx={p[0]} cy={p[1]} r={3.5} />;
      })}
    </g>
  );
}

/** Influence line: ordinates plotted vertically from each member on the load path. */
export function InfluenceLayer({
  project,
  line,
  geometries,
  view,
}: {
  project: Project;
  line: InfluenceLine;
  geometries: Map<string, MemberGeometry>;
  view: View;
}) {
  const peak = Math.max(Math.abs(line.max.value), Math.abs(line.min.value));
  const scale = peak > 1e-12 ? (0.16 * modelSize(project)) / peak : 0;
  const byMember = new Map<string, typeof line.ordinates>();
  for (const o of line.ordinates) {
    const list = byMember.get(o.member) ?? [];
    list.push(o);
    byMember.set(o.member, list);
  }
  const at = (member: string, x: number, value: number): Point | null => {
    const g = geometries.get(member);
    if (!g) return null;
    return toScreen(view, g.a.x + g.cos * x, g.a.y + g.sin * x + value * scale);
  };

  // Marker at the point the influence line is for.
  const t = line.target;
  let marker: Point | null = null;
  if (t.kind === 'memberForce') marker = at(t.member, t.x, 0);
  else {
    const node = project.nodes.find((n) => n.id === t.node);
    if (node) marker = toScreen(view, node.x, node.y);
  }

  const label = (o: typeof line.max, key: string) => {
    const p = at(o.member, o.x, o.value);
    if (!p || Math.abs(o.value) < 0.01 * peak) return null;
    return (
      <g key={key}>
        <circle className="influence-dot" cx={p[0]} cy={p[1]} r={3.5} />
        <text
          className="influence-label"
          x={p[0]}
          y={p[1] + (o.value > 0 ? -9 : 16)}
          textAnchor="middle"
        >
          {fmt(o.value)}
        </text>
      </g>
    );
  };

  return (
    <g className="influence-layer">
      {[...byMember.entries()].map(([member, ordinates]) => {
        const outline = ordinates
          .map((o) => at(member, o.x, o.value))
          .filter((p): p is Point => !!p);
        const first = at(member, ordinates[0].x, 0);
        const last = at(member, ordinates[ordinates.length - 1].x, 0);
        if (!first || !last || outline.length === 0) return null;
        return (
          <g key={member}>
            <polygon
              className="influence-fill"
              points={[first, ...outline, last].map((p) => p.join(',')).join(' ')}
            />
            <polyline
              className="influence-line"
              points={outline.map((p) => p.join(',')).join(' ')}
            />
          </g>
        );
      })}
      {label(line.max, 'max')}
      {line.min !== line.max && label(line.min, 'min')}
      {marker && (
        <g className="influence-target">
          <circle cx={marker[0]} cy={marker[1]} r={9} />
          <circle cx={marker[0]} cy={marker[1]} r={2.5} className="influence-target-dot" />
        </g>
      )}
    </g>
  );
}
