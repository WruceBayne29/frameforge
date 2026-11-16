import { useStore } from './store';
import type { DiagramKind } from './store';

const DIAGRAMS: Array<{ id: DiagramKind; label: string; title: string }> = [
  { id: 'none', label: 'None', title: 'Hide force diagrams' },
  { id: 'N', label: 'Axial', title: 'Axial force diagram (1)' },
  { id: 'V', label: 'Shear', title: 'Shear force diagram (2)' },
  { id: 'M', label: 'Moment', title: 'Bending moment diagram (3)' },
];

/** Controls for what the canvas shows: diagrams, deformed shape, scales. */
export function ViewBar() {
  const { state, dispatch } = useStore();
  const v = state.view;
  const toggle = (
    key: 'deformed' | 'reactions' | 'loads' | 'labels' | 'utilisation',
    label: string,
    title: string,
  ) => (
    <label className={`chip${v[key] ? ' on' : ''}`} title={title}>
      <input
        type="checkbox"
        checked={v[key]}
        onChange={(e) => dispatch({ type: 'view', view: { [key]: e.target.checked } })}
      />
      {label}
    </label>
  );
  return (
    <div className="viewbar" data-tour="viewbar">
      <div className="segmented" role="group" aria-label="Force diagram">
        {DIAGRAMS.map((d) => (
          <button
            key={d.id}
            type="button"
            title={d.title}
            className={v.diagram === d.id ? 'active' : ''}
            onClick={() => dispatch({ type: 'view', view: { diagram: d.id } })}
          >
            {d.label}
          </button>
        ))}
      </div>
      {toggle('deformed', 'Deformed', 'Show the deflected shape (D)')}
      {toggle('reactions', 'Reactions', 'Show support reactions (R)')}
      {toggle('utilisation', 'Utilisation', 'Colour members by IS 800 utilisation ratio (U)')}
      {toggle('loads', 'Loads', 'Show applied loads')}
      {toggle('labels', 'Labels', 'Show node and member labels')}
    </div>
  );
}

/** Floating scale sliders and the Fit button, shown over the bottom-right of the canvas. */
export function CanvasControls() {
  const { state, dispatch } = useStore();
  const v = state.view;
  return (
    <div className="canvas-controls">
      <label className="slider" title="Deformation scale">
        <span>Deform ×{v.deformScale.toFixed(1)}</span>
        <input
          type="range"
          min={0}
          max={5}
          step={0.1}
          value={v.deformScale}
          aria-label="Deformation scale"
          onChange={(e) =>
            dispatch({ type: 'view', view: { deformScale: Number(e.target.value) } })
          }
        />
      </label>
      <label className="slider" title="Diagram scale">
        <span>Diagram ×{v.diagramScale.toFixed(1)}</span>
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.1}
          value={v.diagramScale}
          aria-label="Diagram scale"
          onChange={(e) =>
            dispatch({ type: 'view', view: { diagramScale: Number(e.target.value) } })
          }
        />
      </label>
      <button
        type="button"
        className="ghost"
        title="Fit the model to the window (F)"
        onClick={() => dispatch({ type: 'fit' })}
      >
        Fit
      </button>
    </div>
  );
}
