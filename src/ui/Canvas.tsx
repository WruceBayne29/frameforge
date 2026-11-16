import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  addLoad,
  addMember,
  addNode,
  deleteMember,
  deleteNode,
  memberProps,
  moveNode,
  setSupport,
  splitMember,
} from '../model';
import type { Project } from '../model';
import { ModelLayer, memberGeometries } from './canvas/ModelLayer';
import { ResultsLayer, resultScales, utilisationColor } from './canvas/ResultsLayer';
import type { Point, View } from './canvas/view';
import { distanceToSegment, fitView, niceStep, toScreen, toWorld, zoomAt } from './canvas/view';
import { fmt, mm } from './format';
import { solveProject, useStore } from './store';
import type { Selection } from './store';

interface Hit {
  target: Selection;
  /** Distance along the member (m) for member hits. */
  x?: number;
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View; moved: boolean }
  | { kind: 'node'; id: string; moved: boolean };

const NODE_RADIUS = 11;
const MEMBER_RADIUS = 8;

export function Canvas() {
  const { state, dispatch, solution } = useStore();
  const { tool, toolOptions, selection, view: options } = state;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [view, setView] = useState<View>({ scale: 60, ox: 100, oy: 400 });
  const [hover, setHover] = useState<Hit | null>(null);
  const [cursor, setCursor] = useState<{ screen: Point; world: Point } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState<Project | null>(null);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; view: View } | null>(null);
  const spaceDown = useRef(false);

  const project = draft ?? state.project;
  const draftSolution = useMemo(() => (draft ? solveProject(draft) : null), [draft]);
  const shown = draftSolution ?? solution;

  // Track the size of the drawing area.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  // Fit the model when a project is loaded, Fit is requested or the canvas first gets a size.
  const sized = size.width > 0 && size.height > 0;
  const fitKey = `${state.loadCount}:${sized}`;
  const lastFit = useRef('');
  useEffect(() => {
    if (!sized || lastFit.current === fitKey) return;
    lastFit.current = fitKey;
    setView(fitView(state.project, size.width, size.height));
  }, [fitKey, sized, size.width, size.height, state.project]);

  // Leaving the member tool or loading a project cancels a half-drawn member.
  useEffect(() => setPending(null), [tool, state.loadCount]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPending(null);
      if (e.code === 'Space') spaceDown.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const geometries = useMemo(() => memberGeometries(project), [project]);

  const snap = useCallback(
    (world: Point): Point => {
      if (!toolOptions.snap) return [Number(world[0].toFixed(3)), Number(world[1].toFixed(3))];
      const g = toolOptions.grid;
      const r = (v: number) => Number((Math.round(v / g) * g).toFixed(6));
      return [r(world[0]), r(world[1])];
    },
    [toolOptions.snap, toolOptions.grid],
  );

  const hitTest = useCallback(
    (sx: number, sy: number, exclude?: string): Hit | null => {
      let best: Hit | null = null;
      let bestDistance = NODE_RADIUS;
      for (const n of project.nodes) {
        if (n.id === exclude) continue;
        const p = toScreen(view, n.x, n.y);
        const d = Math.hypot(p[0] - sx, p[1] - sy);
        if (d < bestDistance) {
          bestDistance = d;
          best = { target: { kind: 'node', id: n.id } };
        }
      }
      if (best) return best;
      bestDistance = MEMBER_RADIUS;
      for (const g of geometries.values()) {
        const a = toScreen(view, g.a.x, g.a.y);
        const b = toScreen(view, g.b.x, g.b.y);
        const { distance, t } = distanceToSegment([sx, sy], a, b);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { target: { kind: 'member', id: g.member.id }, x: t * g.length };
        }
      }
      return best;
    },
    [project.nodes, geometries, view],
  );

  const localPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = wrapRef.current?.getBoundingClientRect();
    return [e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0)];
  };

  /** Snaps a distance along a member to the grid spacing (so point loads land on round values). */
  const snapAlong = (x: number, length: number): number => {
    if (!toolOptions.snap) return Number(x.toFixed(3));
    const g = toolOptions.grid;
    return Math.min(length, Math.max(0, Number((Math.round(x / g) * g).toFixed(6))));
  };

  /** Returns the node under the pointer, creating one (or splitting a member) if needed. */
  const nodeAt = (p: Project, sx: number, sy: number): { project: Project; id: string | null } => {
    const hit = hitTest(sx, sy);
    if (hit?.target?.kind === 'node') return { project: p, id: hit.target.id };
    if (hit?.target?.kind === 'member' && hit.x !== undefined) {
      const g = geometries.get(hit.target.id);
      if (g) {
        const split = splitMember(p, hit.target.id, snapAlong(hit.x, g.length));
        return { project: split.project, id: split.nodeId };
      }
    }
    const [wx, wy] = snap(toWorld(view, sx, sy));
    return addNode(p, wx, wy);
  };

  const applyTool = (sx: number, sy: number) => {
    const p = state.project;
    const hit = hitTest(sx, sy);
    switch (tool) {
      case 'node': {
        const r = nodeAt(p, sx, sy);
        if (r.id)
          dispatch({ type: 'edit', project: r.project, selection: { kind: 'node', id: r.id } });
        break;
      }
      case 'member': {
        const r = nodeAt(p, sx, sy);
        if (!r.id) break;
        if (!pending || pending === r.id || !r.project.nodes.some((n) => n.id === pending)) {
          dispatch({ type: 'edit', project: r.project, selection: { kind: 'node', id: r.id } });
          setPending(r.id);
          break;
        }
        const m = addMember(r.project, pending, r.id, toolOptions.memberType, toolOptions.section);
        dispatch({
          type: 'edit',
          project: m.project,
          selection: m.id ? { kind: 'member', id: m.id } : null,
        });
        setPending(r.id);
        break;
      }
      case 'support': {
        if (hit?.target?.kind !== 'node') break;
        const id = hit.target.id;
        const current = p.supports.find((s) => s.node === id)?.kind;
        const kind = current === toolOptions.supportKind ? null : toolOptions.supportKind;
        dispatch({ type: 'edit', project: setSupport(p, id, kind), selection: hit.target });
        break;
      }
      case 'load': {
        const value = toolOptions.loadValue;
        if (toolOptions.loadKind === 'nodal' && hit?.target?.kind === 'node') {
          const r = addLoad(p, { kind: 'nodal', node: hit.target.id, fx: 0, fy: -value, mz: 0 });
          dispatch({ type: 'edit', project: r.project, selection: { kind: 'load', id: r.id } });
        } else if (toolOptions.loadKind !== 'nodal' && hit?.target?.kind === 'member') {
          const g = geometries.get(hit.target.id);
          if (!g) break;
          const r =
            toolOptions.loadKind === 'udl'
              ? addLoad(p, {
                  kind: 'distributed',
                  member: hit.target.id,
                  direction: 'globalY',
                  w1: -value,
                })
              : addLoad(p, {
                  kind: 'point',
                  member: hit.target.id,
                  direction: 'globalY',
                  P: -value,
                  a: snapAlong(hit.x ?? g.length / 2, g.length),
                });
          dispatch({ type: 'edit', project: r.project, selection: { kind: 'load', id: r.id } });
        }
        break;
      }
      case 'delete': {
        if (hit?.target?.kind === 'node') {
          dispatch({ type: 'edit', project: deleteNode(p, hit.target.id), selection: null });
        } else if (hit?.target?.kind === 'member') {
          const next = deleteMember(p, hit.target.id);
          dispatch({ type: 'edit', project: next, selection: null });
        }
        break;
      }
      case 'select':
        break;
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const [sx, sy] = localPoint(e);
    pointers.current.set(e.pointerId, [sx, sy]);
    e.currentTarget.setPointerCapture(e.pointerId);

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]), view };
      drag.current = null;
      setDraft(null);
      return;
    }

    const panning = e.button === 1 || e.button === 2 || spaceDown.current;
    if (panning) {
      drag.current = { kind: 'pan', startX: sx, startY: sy, view, moved: false };
      return;
    }
    if (e.button !== 0) return;

    if (tool === 'select') {
      const hit = hitTest(sx, sy);
      if (hit?.target?.kind === 'node') {
        dispatch({ type: 'select', selection: hit.target });
        drag.current = { kind: 'node', id: hit.target.id, moved: false };
      } else if (hit?.target) {
        dispatch({ type: 'select', selection: hit.target });
      } else {
        drag.current = { kind: 'pan', startX: sx, startY: sy, view, moved: false };
      }
      return;
    }
    applyTool(sx, sy);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const [sx, sy] = localPoint(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, [sx, sy]);

    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const centre: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      setView(zoomAt(pinch.current.view, centre[0], centre[1], distance / pinch.current.distance));
      return;
    }

    const d = drag.current;
    if (d?.kind === 'pan') {
      const dx = sx - d.startX;
      const dy = sy - d.startY;
      if (Math.hypot(dx, dy) > 3) d.moved = true;
      setView({ ...d.view, ox: d.view.ox + dx, oy: d.view.oy + dy });
      return;
    }
    const world = snap(toWorld(view, sx, sy));
    setCursor({ screen: [sx, sy], world });
    if (d?.kind === 'node') {
      const moved = moveNode(state.project, d.id, world[0], world[1]);
      if (moved !== state.project) d.moved = true;
      setDraft(moved === state.project ? null : moved);
      return;
    }
    setHover(hitTest(sx, sy));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'node') {
      if (draft) dispatch({ type: 'edit', project: draft });
      setDraft(null);
    } else if (d?.kind === 'pan' && !d.moved && tool === 'select' && e.button === 0) {
      dispatch({ type: 'select', selection: null });
    }
  };

  // Wheel zoom must be registered as non-passive to prevent the page from scrolling.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setView((v) => zoomAt(v, e.clientX - rect.left, e.clientY - rect.top, factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Grid lines.
  const grid = useMemo(() => {
    const step = niceStep(view.scale, 26);
    const [x0, y1] = toWorld(view, 0, 0);
    const [x1, y0] = toWorld(view, size.width, size.height);
    const lines: Array<{
      key: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      major: boolean;
    }> = [];
    const isMajor = (v: number) => Math.abs(v / (step * 5) - Math.round(v / (step * 5))) < 1e-6;
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      const sx = view.ox + x * view.scale;
      lines.push({
        key: `x${x.toFixed(4)}`,
        x1: sx,
        y1: 0,
        x2: sx,
        y2: size.height,
        major: isMajor(x),
      });
    }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      const sy = view.oy - y * view.scale;
      lines.push({
        key: `y${y.toFixed(4)}`,
        x1: 0,
        y1: sy,
        x2: size.width,
        y2: sy,
        major: isMajor(y),
      });
    }
    return lines;
  }, [view, size]);

  const scales = useMemo(
    () =>
      shown.result
        ? resultScales(project, shown.result, options.deformScale, options.diagramScale)
        : null,
    [project, shown.result, options.deformScale, options.diagramScale],
  );

  const memberColors = useMemo(() => {
    if (!options.utilisation || !shown.result) return undefined;
    const colors: Record<string, string> = {};
    for (const [id, d] of Object.entries(shown.design)) {
      colors[id] = utilisationColor(d.result.utilisation);
    }
    return colors;
  }, [options.utilisation, shown.design, shown.result]);

  // Tooltip for whatever is under the pointer.
  const tooltip = useMemo(() => {
    if (!hover?.target || !cursor || drag.current) return null;
    const lines: string[] = [];
    let title: string;
    if (hover.target.kind === 'node') {
      const id = hover.target.id;
      const n = project.nodes.find((node) => node.id === id);
      if (!n) return null;
      title = `Node ${n.id}`;
      lines.push(`x = ${fmt(n.x)} m, y = ${fmt(n.y)} m`);
      const d = shown.result?.displacements[n.id];
      if (d) {
        lines.push(`δx = ${mm(d.ux)} mm, δy = ${mm(d.uy)} mm`);
        lines.push(`θ = ${fmt(d.rz * 1000)} mrad`);
      }
      const r = shown.result?.reactions[n.id];
      if (r) {
        lines.push(`Rx = ${fmt(r.fx)} kN, Ry = ${fmt(r.fy)} kN`);
        if (Math.abs(r.mz) > 1e-9) lines.push(`Mz = ${fmt(r.mz)} kN·m`);
      }
    } else if (hover.target.kind === 'member') {
      const id = hover.target.id;
      const g = geometries.get(id);
      if (!g) return null;
      const props = memberProps(project, g.member);
      title = `Member ${id} · ${g.member.section}`;
      lines.push(
        `${g.member.type === 'truss' ? 'Truss' : 'Frame'} · L = ${fmt(g.length)} m · A = ${fmt(props.A)} cm²`,
      );
      const r = shown.result?.members[id];
      if (r && hover.x !== undefined) {
        const x = hover.x;
        const st = r.stations;
        let k = 0;
        while (k < st.length - 2 && st[k + 1].x < x) k++;
        const a = st[k];
        const b = st[k + 1];
        const t = b.x - a.x > 1e-12 ? (x - a.x) / (b.x - a.x) : 0;
        const lerp = (p: number, q: number) => p + (q - p) * t;
        lines.push(`at x = ${fmt(x)} m`);
        lines.push(`N = ${fmt(lerp(a.N, b.N))} kN ${lerp(a.N, b.N) >= 0 ? '(T)' : '(C)'}`);
        if (g.member.type === 'frame' || Math.abs(r.maxAbsMoment.value) > 1e-9) {
          lines.push(`V = ${fmt(lerp(a.V, b.V))} kN`);
          lines.push(`M = ${fmt(lerp(a.M, b.M))} kN·m`);
        }
        lines.push(`δ = ${mm(Math.hypot(lerp(a.u, b.u), lerp(a.v, b.v)))} mm`);
        const design = shown.design[id];
        if (design) lines.push(`Utilisation = ${design.result.utilisation.toFixed(2)}`);
      }
    } else {
      return null;
    }
    return { title, lines };
  }, [hover, cursor, project, geometries, shown]);

  // Rubber-band preview for the member tool.
  const pendingNode = pending ? project.nodes.find((n) => n.id === pending) : undefined;
  const ghost =
    tool !== 'select' && tool !== 'delete' && cursor && !hover?.target
      ? toScreen(view, cursor.world[0], cursor.world[1])
      : null;

  const cursorClass =
    drag.current?.kind === 'pan'
      ? 'panning'
      : tool === 'select'
        ? hover?.target
          ? 'pointer'
          : 'grab'
        : 'crosshair';

  return (
    <div
      ref={wrapRef}
      className={`canvas cursor-${cursorClass}`}
      data-tour="canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        setHover(null);
        setCursor(null);
      }}
      onDoubleClick={() => setPending(null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg width={size.width} height={size.height} role="img" aria-label="Structural model">
        <g className="grid">
          {grid.map((l) => (
            <line
              key={l.key}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              className={l.major ? 'major' : ''}
            />
          ))}
        </g>
        {shown.result && scales && (
          <ResultsLayer
            project={project}
            result={shown.result}
            design={shown.design}
            view={view}
            diagram={options.diagram}
            deformed={options.deformed}
            reactions={options.reactions}
            utilisation={options.utilisation}
            scales={scales}
          />
        )}
        <ModelLayer
          project={project}
          view={view}
          selection={selection}
          hover={hover?.target ?? null}
          showLoads={options.loads}
          showLabels={options.labels}
          memberColors={memberColors}
          dimmed={false}
          errorNode={shown.error?.nodeId}
        />
        {pendingNode && cursor && (
          <line
            className="rubber-band"
            x1={toScreen(view, pendingNode.x, pendingNode.y)[0]}
            y1={toScreen(view, pendingNode.x, pendingNode.y)[1]}
            x2={toScreen(view, cursor.world[0], cursor.world[1])[0]}
            y2={toScreen(view, cursor.world[0], cursor.world[1])[1]}
          />
        )}
        {ghost && (tool === 'node' || tool === 'member') && (
          <circle className="ghost-node" cx={ghost[0]} cy={ghost[1]} r={5} />
        )}
      </svg>

      {tooltip && cursor && (
        <div
          className="tooltip"
          style={{
            left: Math.min(cursor.screen[0] + 16, size.width - 230),
            top: Math.min(cursor.screen[1] + 16, size.height - 30 - tooltip.lines.length * 18),
          }}
        >
          <strong>{tooltip.title}</strong>
          {tooltip.lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      )}

      <div className="canvas-readout">
        {cursor ? `x ${cursor.world[0].toFixed(2)} m · y ${cursor.world[1].toFixed(2)} m` : ' '}
        {scales && options.deformed && shown.result && shown.result.maxDisplacement > 0 && (
          <span> · deformation ×{fmt(scales.deform, 2)}</span>
        )}
      </div>
      {pending && (
        <div className="canvas-hint">Click the next node · Esc or double-click to finish</div>
      )}
    </div>
  );
}
