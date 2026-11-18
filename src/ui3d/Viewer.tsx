import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { colorMapCss, moveNode, nodalField, resultPeaks3D } from '../model3d';
import type { AnalysisResult3D } from '../solver3d';
import { DIAGRAMS_3D, fieldInfo, fieldTitle, fmt, legendTicks } from './format3d';
import { clickAction, toolHint } from './interaction';
import { useStore3D } from './store';
import type { Pick3D, Solution3D } from './store';
import type { Vec3 } from './viewer/build';
import { readPalette } from './viewer/palette';
import { ViewerEngine } from './viewer/scene';

export interface ViewerHandle {
  /** The current view as a PNG data URL (null when WebGL is unavailable). */
  capture: () => string | null;
  /** Page coordinates of a node, or null when it is not visible. */
  nodeScreenPosition: (id: string) => { x: number; y: number } | null;
}

declare global {
  interface Window {
    /** The mounted 3D viewer, for scripts (reports, end-to-end tests). */
    frameforgeViewer3D?: ViewerHandle;
  }
}

const GRADIENT = `linear-gradient(to top, ${[0, 0.25, 0.5, 0.75, 1].map((t) => colorMapCss(t)).join(', ')})`;

/** Contour colour scale and diagram key, over the top-right of the viewer. */
function Legend({ result }: { result: AnalysisResult3D | null }) {
  const { state } = useStore3D();
  const { project, view } = state;
  const field = useMemo(
    () => (result && view.contour !== 'none' ? nodalField(project, result, view.contour) : null),
    [project, result, view.contour],
  );
  const peaks = useMemo(() => (result ? resultPeaks3D(result) : null), [result]);
  const diagram = DIAGRAMS_3D.find((d) => d.id === view.diagram);
  const showField = field && Object.keys(field.values).length > 0;
  const showDiagram = diagram && peaks && project.members.length > 0;
  if (!showField && !showDiagram) return null;
  const info = field ? fieldInfo(field.kind) : null;
  return (
    <div className="legend3d" aria-label="Legend">
      {showField && info && (
        <>
          <strong>{fieldTitle(field.kind)}</strong>
          <div className="legend3d-body">
            <div className="legend3d-bar" style={{ background: GRADIENT }} />
            <div className="legend3d-ticks">
              {legendTicks(field.min, field.max, info.factor).map((t, k) => (
                <span key={k}>{t}</span>
              ))}
            </div>
          </div>
          <span className="muted">
            min {fmt(field.min * info.factor)} · max {fmt(field.max * info.factor)}
          </span>
        </>
      )}
      {showDiagram && (
        <span className="diagram-key" title={diagram.title}>
          <strong>
            {diagram.label} ({diagram.unit})
          </strong>
          <span className="muted">peak {fmt(peaks[diagram.id])}</span>
        </span>
      )}
    </div>
  );
}

export function Viewer({ ref }: { ref?: Ref<ViewerHandle> }) {
  const { state, dispatch, solution } = useStore3D();
  const container = useRef<HTMLDivElement>(null);
  const engine = useRef<ViewerEngine | null>(null);
  const [failed, setFailed] = useState(false);
  const [palette, setPalette] = useState(readPalette);
  const [cursor, setCursor] = useState<Vec3 | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // While a large model is being re-analysed, keep showing the last results.
  const lastResult = useRef<AnalysisResult3D | null>(null);
  useEffect(() => {
    if (!solution.pending) lastResult.current = solution.result;
  }, [solution]);
  const result = solution.pending ? lastResult.current : solution.result;
  const lastDesign = useRef<Solution3D['design'] | null>(null);
  useEffect(() => {
    if (!solution.pending) lastDesign.current = solution.design;
  }, [solution]);
  const design = solution.pending ? lastDesign.current : solution.design;

  useEffect(() => {
    const observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let created: ViewerEngine;
    try {
      created = new ViewerEngine(element, {
        onClick: (hit, additive) => {
          const action = clickAction(stateRef.current, { ...hit, additive });
          if (action) dispatch(action);
        },
        onHover: (hit) => setCursor(hit.plane),
        onDragStart: (node) => dispatch({ type: 'dragStart', node }),
        onDrag: (node, point) => {
          const project = stateRef.current.project;
          dispatch({ type: 'drag', project: moveNode(project, node, ...point) });
          setCursor(point);
        },
      });
    } catch {
      setFailed(true);
      return;
    }
    engine.current = created;
    return () => {
      created.dispose();
      engine.current = null;
    };
  }, [dispatch]);

  const problem = useMemo<Pick3D | null>(() => {
    const e = solution.error;
    if (!e) return null;
    if (e.nodeId) return { kind: 'node', id: e.nodeId };
    if (e.elementId) {
      const p = state.project;
      if (p.members.some((m) => m.id === e.elementId)) return { kind: 'member', id: e.elementId };
      if (p.plates.some((x) => x.id === e.elementId)) return { kind: 'plate', id: e.elementId };
      if (p.solids.some((x) => x.id === e.elementId)) return { kind: 'solid', id: e.elementId };
    }
    return null;
  }, [solution.error, state.project]);

  useEffect(() => {
    engine.current?.update({
      project: state.project,
      result,
      design,
      view: state.view,
      selection: state.selection,
      pending: state.pending,
      tool: state.tool,
      toolOptions: state.toolOptions,
      palette,
      problem,
    });
  }, [
    state.project,
    result,
    design,
    state.view,
    state.selection,
    state.pending,
    state.tool,
    state.toolOptions,
    palette,
    problem,
  ]);

  const { preset, count } = state.camera;
  useEffect(() => {
    engine.current?.setCamera(preset);
  }, [preset, count]);

  const handle = useMemo<ViewerHandle>(
    () => ({
      capture: () => engine.current?.capture() ?? null,
      nodeScreenPosition: (id) => engine.current?.nodeScreenPosition(id) ?? null,
    }),
    [],
  );
  useImperativeHandle(ref, () => handle, [handle]);
  useEffect(() => {
    window.frameforgeViewer3D = handle;
    return () => {
      if (window.frameforgeViewer3D === handle) delete window.frameforgeViewer3D;
    };
  }, [handle]);

  const hint = toolHint(state);
  return (
    <div className="viewer3d" ref={container} data-testid="viewer3d">
      {failed && (
        <div className="empty-hint">
          <strong>3D view unavailable</strong>
          <span>This browser could not start WebGL. The tables and results still work.</span>
        </div>
      )}
      {hint && <div className="canvas-hint">{hint}</div>}
      <Legend result={result} />
      {cursor && (
        <div className="canvas-readout">
          x {fmt(cursor[0])} · y {fmt(cursor[1])} · z {fmt(cursor[2])} m
        </div>
      )}
    </div>
  );
}
