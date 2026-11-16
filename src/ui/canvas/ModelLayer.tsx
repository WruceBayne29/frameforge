import { memo } from 'react';
import type { LoadDirection, Project, ProjectLoad, ProjectMember, ProjectNode } from '../../model';
import { fmt } from '../format';
import type { Selection } from '../store';
import { Arrow, MomentArc, SupportGlyph } from './glyphs';
import type { Point, View } from './view';
import { toScreen } from './view';

export interface MemberGeometry {
  member: ProjectMember;
  a: ProjectNode;
  b: ProjectNode;
  length: number;
  cos: number;
  sin: number;
}

export function memberGeometries(project: Project): Map<string, MemberGeometry> {
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const out = new Map<string, MemberGeometry>();
  for (const member of project.members) {
    const a = nodes.get(member.i);
    const b = nodes.get(member.j);
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    out.set(member.id, {
      member,
      a,
      b,
      length,
      cos: (b.x - a.x) / length,
      sin: (b.y - a.y) / length,
    });
  }
  return out;
}

/** Unit vector (world axes) along which a positive load of the given direction acts. */
function loadAxis(direction: LoadDirection, g: MemberGeometry): Point {
  switch (direction) {
    case 'localX':
      return [g.cos, g.sin];
    case 'localY':
      return [-g.sin, g.cos];
    case 'globalX':
      return [1, 0];
    case 'globalY':
      return [0, 1];
  }
}

/** Angle (degrees, screen) by which a support glyph is rotated so it sits away from the members. */
function supportAngle(node: ProjectNode, project: Project): number {
  let dx = 0;
  let dy = 0;
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  for (const m of project.members) {
    const other = m.i === node.id ? nodes.get(m.j) : m.j === node.id ? nodes.get(m.i) : undefined;
    if (!other) continue;
    const len = Math.hypot(other.x - node.x, other.y - node.y) || 1;
    dx += (other.x - node.x) / len;
    dy += (other.y - node.y) / len;
  }
  // The glyph points along −(dx, dy); default is "down" on screen. Snap to 90° steps and
  // prefer the upright symbol unless the members clearly leave sideways or downwards.
  if (Math.abs(dx) > Math.abs(dy) * 1.5) return dx > 0 ? 90 : -90;
  if (dy < -Math.abs(dx) * 1.5) return 180;
  return 0;
}

interface Props {
  project: Project;
  view: View;
  selection: Selection;
  hover: Selection;
  showLoads: boolean;
  showLabels: boolean;
  showMemberLabels: boolean;
  /** Stroke colour per member (utilisation view). */
  memberColors?: Record<string, string>;
  dimmed: boolean;
  errorNode?: string;
}

const LOAD_LEN = 42;

function LoadGlyph({
  load,
  project,
  geometries,
  view,
  maxW,
  selected,
}: {
  load: ProjectLoad;
  project: Project;
  geometries: Map<string, MemberGeometry>;
  view: View;
  maxW: number;
  selected: boolean;
}) {
  const cls = `load${selected ? ' selected' : ''}`;
  if (load.kind === 'nodal') {
    const node = project.nodes.find((n) => n.id === load.node);
    if (!node) return null;
    const p = toScreen(view, node.x, node.y);
    const parts = [];
    if (load.fx !== 0) {
      const s = Math.sign(load.fx);
      const tail: Point = [p[0] - s * LOAD_LEN, p[1]];
      parts.push(
        <g key="fx">
          <Arrow from={tail} to={[p[0] - s * 5, p[1]]} />
          <text x={tail[0] - s * 4} y={p[1] - 6} textAnchor={s > 0 ? 'end' : 'start'}>
            {fmt(Math.abs(load.fx))} kN
          </text>
        </g>,
      );
    }
    if (load.fy !== 0) {
      const s = Math.sign(load.fy);
      // Screen y is down: an upward force (fy > 0) has its tail below the node.
      const tail: Point = [p[0], p[1] + s * LOAD_LEN];
      parts.push(
        <g key="fy">
          <Arrow from={tail} to={[p[0], p[1] + s * 5]} />
          <text x={p[0] + 6} y={tail[1] + (s > 0 ? 4 : 2)}>
            {fmt(Math.abs(load.fy))} kN
          </text>
        </g>,
      );
    }
    if (load.mz !== 0) {
      parts.push(
        <g key="mz">
          <MomentArc at={p} ccw={load.mz > 0} radius={17} />
          <text x={p[0] + 20} y={p[1] - 16}>
            {fmt(Math.abs(load.mz))} kN·m
          </text>
        </g>,
      );
    }
    return <g className={cls}>{parts}</g>;
  }

  const g = geometries.get(load.member);
  if (!g) return null;
  const at = (x: number): Point => toScreen(view, g.a.x + g.cos * x, g.a.y + g.sin * x);

  if (load.kind === 'moment') {
    const p = at(load.a);
    return (
      <g className={cls}>
        <MomentArc at={p} ccw={load.M > 0} radius={15} />
        <text x={p[0] + 18} y={p[1] - 14}>
          {fmt(Math.abs(load.M))} kN·m
        </text>
      </g>
    );
  }

  const axis = loadAxis(load.direction, g);
  if (load.kind === 'point') {
    const s = Math.sign(load.P) || 1;
    // Screen direction of the force.
    const dir: Point = [axis[0] * s, -axis[1] * s];
    const p = at(load.a);
    const tail: Point = [p[0] - dir[0] * LOAD_LEN, p[1] - dir[1] * LOAD_LEN];
    return (
      <g className={cls}>
        <Arrow from={tail} to={[p[0] - dir[0] * 3, p[1] - dir[1] * 3]} />
        <text x={tail[0] + 6} y={tail[1] + (dir[1] > 0 ? -2 : 12)}>
          {fmt(Math.abs(load.P))} kN
        </text>
      </g>
    );
  }

  // Distributed load: arrows whose length follows the intensity, joined along their tails.
  const a = load.a ?? 0;
  const b = load.b ?? g.length;
  const w1 = load.w1;
  const w2 = load.w2 ?? load.w1;
  const sign = Math.sign(Math.abs(w1) >= Math.abs(w2) ? w1 : w2) || 1;
  const dir: Point = [axis[0] * sign, -axis[1] * sign];
  // Loads acting along the member are drawn slightly offset so they stay visible.
  const along = Math.abs(dir[0] * g.cos - dir[1] * g.sin) > 0.95;
  const pixels = (b - a) * view.scale;
  const count = Math.max(2, Math.round(pixels / 26) + 1);
  const arrows = [];
  const tails: Point[] = [];
  for (let k = 0; k < count; k++) {
    const t = k / (count - 1);
    const x = a + (b - a) * t;
    const w = w1 + (w2 - w1) * t;
    const len = maxW > 0 ? (Math.abs(w) / maxW) * 30 : 0;
    const p = at(x);
    if (along) {
      const off: Point = [-g.sin * 12, -g.cos * 12];
      const base: Point = [p[0] + off[0], p[1] + off[1]];
      if (len > 2 && k < count - 1) {
        arrows.push(
          <Arrow
            key={k}
            from={base}
            to={[base[0] + dir[0] * 16, base[1] + dir[1] * 16]}
            head={6}
          />,
        );
      }
      tails.push(base);
      continue;
    }
    const tip: Point = [p[0] - dir[0] * 4, p[1] - dir[1] * 4];
    const tail: Point = [tip[0] - dir[0] * (len + 4), tip[1] - dir[1] * (len + 4)];
    tails.push(tail);
    if (len > 3) arrows.push(<Arrow key={k} from={tail} to={tip} head={6} />);
  }
  const mid = tails[Math.floor(tails.length / 2)];
  const label =
    Math.abs(w1 - w2) < 1e-9
      ? `${fmt(Math.abs(w1))} kN/m`
      : `${fmt(Math.abs(w1))} → ${fmt(Math.abs(w2))} kN/m`;
  return (
    <g className={cls}>
      <polyline className="load-line" points={tails.map((p) => p.join(',')).join(' ')} />
      {arrows}
      <text x={mid[0] - dir[0] * 8} y={mid[1] - dir[1] * 8 + 4} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

export const ModelLayer = memo(function ModelLayer({
  project,
  view,
  selection,
  hover,
  showLoads,
  showLabels,
  showMemberLabels,
  memberColors,
  dimmed,
  errorNode,
}: Props) {
  const geometries = memberGeometries(project);
  const maxW = project.loads.reduce(
    (m, l) => (l.kind === 'distributed' ? Math.max(m, Math.abs(l.w1), Math.abs(l.w2 ?? l.w1)) : m),
    0,
  );
  const isSel = (kind: 'node' | 'member' | 'load', id: string) =>
    selection?.kind === kind && selection.id === id;
  const isHover = (kind: 'node' | 'member' | 'load', id: string) =>
    hover?.kind === kind && hover.id === id;
  const framed = new Set<string>();
  for (const m of project.members) {
    if (m.type === 'frame') {
      if (!m.releaseI) framed.add(m.i);
      if (!m.releaseJ) framed.add(m.j);
    }
  }

  return (
    <g className={`model-layer${dimmed ? ' dimmed' : ''}`}>
      {project.supports.map((s) => {
        const node = project.nodes.find((n) => n.id === s.node);
        if (!node) return null;
        return (
          <SupportGlyph
            key={s.node}
            at={toScreen(view, node.x, node.y)}
            kind={s.kind}
            // Only a fixed support turns to face its member; pins and rollers stay upright.
            angle={s.kind === 'fixed' ? supportAngle(node, project) : 0}
          />
        );
      })}

      {[...geometries.values()].map((g) => {
        const p1 = toScreen(view, g.a.x, g.a.y);
        const p2 = toScreen(view, g.b.x, g.b.y);
        const cls = [
          'member',
          g.member.type,
          isSel('member', g.member.id) ? 'selected' : '',
          isHover('member', g.member.id) ? 'hover' : '',
        ].join(' ');
        const color = memberColors?.[g.member.id];
        const release = (end: Point, toward: Point) => {
          const d = Math.hypot(toward[0] - end[0], toward[1] - end[1]) || 1;
          const off = Math.min(13, d * 0.3);
          return (
            <circle
              className="release"
              cx={end[0] + ((toward[0] - end[0]) / d) * off}
              cy={end[1] + ((toward[1] - end[1]) / d) * off}
              r={4}
            />
          );
        };
        return (
          <g key={g.member.id} className={cls}>
            <line
              x1={p1[0]}
              y1={p1[1]}
              x2={p2[0]}
              y2={p2[1]}
              style={color ? { stroke: color } : undefined}
            />
            {g.member.type === 'frame' && g.member.releaseI && release(p1, p2)}
            {g.member.type === 'frame' && g.member.releaseJ && release(p2, p1)}
            {showMemberLabels && (
              <text
                className="member-label"
                x={(p1[0] + p2[0]) / 2 - g.sin * 11}
                y={(p1[1] + p2[1]) / 2 - g.cos * 11 + 3}
                textAnchor="middle"
              >
                {g.member.id}
              </text>
            )}
          </g>
        );
      })}

      {showLoads &&
        project.loads.map((load) => (
          <LoadGlyph
            key={load.id}
            load={load}
            project={project}
            geometries={geometries}
            view={view}
            maxW={maxW}
            selected={isSel('load', load.id)}
          />
        ))}

      {project.nodes.map((n) => {
        const p = toScreen(view, n.x, n.y);
        const cls = [
          'node',
          framed.has(n.id) ? 'rigid' : 'pin',
          isSel('node', n.id) ? 'selected' : '',
          isHover('node', n.id) ? 'hover' : '',
          errorNode === n.id ? 'error' : '',
        ].join(' ');
        return (
          <g key={n.id} className={cls}>
            <circle cx={p[0]} cy={p[1]} r={4.5} />
            {showLabels && (
              <text className="node-label" x={p[0] + 8} y={p[1] - 8}>
                {n.id}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});
