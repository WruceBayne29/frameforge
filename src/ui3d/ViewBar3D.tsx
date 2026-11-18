import { isPlane } from '../model3d';
import { DIAGRAMS_3D, FIELDS_3D } from './format3d';
import { PLANE_DIAGRAMS, useStore3D } from './store';
import type { CameraPreset, ViewOptions3D } from './store';

type Toggle = 'deformed' | 'reactions' | 'loads' | 'supports' | 'labels' | 'grid';

const TOGGLES: Array<{ key: Toggle; label: string; title: string }> = [
  { key: 'deformed', label: 'Deformed', title: 'Show the deflected shape (D)' },
  { key: 'reactions', label: 'Reactions', title: 'Show support reactions (R)' },
  { key: 'loads', label: 'Loads', title: 'Show applied loads' },
  { key: 'supports', label: 'Supports', title: 'Show support symbols' },
  { key: 'labels', label: 'Labels', title: 'Show node and element ids' },
  { key: 'grid', label: 'Grid', title: 'Show the ground grid' },
];

/** What the 3D viewer shows: member diagrams, contours and overlays. */
export function ViewBar3D({ onImage }: { onImage: () => void }) {
  const { state, dispatch } = useStore3D();
  const v = state.view;
  const { members, plates, solids } = state.project;
  const plane = isPlane(state.project);
  const diagrams = plane ? DIAGRAMS_3D.filter((d) => PLANE_DIAGRAMS.includes(d.id)) : DIAGRAMS_3D;
  const set = (view: Partial<ViewOptions3D>) => dispatch({ type: 'view', view });
  const groups = [
    { name: 'All', show: plates.length + solids.length > 0 },
    { name: 'Plates', show: plates.length > 0 },
    { name: 'Solids', show: solids.length > 0 },
  ];
  return (
    <div className="viewbar">
      {members.length > 0 && (
        <div className="segmented" role="group" aria-label="Member force diagram">
          <button
            type="button"
            title="Hide member diagrams (0)"
            className={v.diagram === 'none' ? 'active' : ''}
            aria-pressed={v.diagram === 'none'}
            onClick={() => set({ diagram: 'none' })}
          >
            None
          </button>
          {diagrams.map((d) => (
            <button
              key={d.id}
              type="button"
              title={`${d.title}, ${d.unit} (${DIAGRAMS_3D.indexOf(d) + 1})`}
              className={v.diagram === d.id ? 'active' : ''}
              aria-pressed={v.diagram === d.id}
              onClick={() => set({ diagram: d.id })}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}
      {plates.length + solids.length > 0 && (
        <select
          className="contour-picker"
          aria-label="Contour plot"
          value={v.contour}
          onChange={(e) => set({ contour: e.target.value as ViewOptions3D['contour'] })}
        >
          <option value="none">No contours</option>
          {groups
            .filter((g) => g.show)
            .map((g) => (
              <optgroup key={g.name} label={g.name === 'All' ? 'Contours' : g.name}>
                {FIELDS_3D.filter((f) => f.group === g.name).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label} ({f.unit})
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      )}
      {TOGGLES.map((t) => (
        <label key={t.key} className={`chip${v[t.key] ? ' on' : ''}`} title={t.title}>
          <input
            type="checkbox"
            checked={v[t.key]}
            onChange={(e) => set({ [t.key]: e.target.checked })}
          />
          {t.label}
        </label>
      ))}
      <button
        type="button"
        className="ghost"
        title="Download the view as a PNG image"
        onClick={onImage}
      >
        Image
      </button>
    </div>
  );
}

const PRESETS: Array<{ id: CameraPreset; label: string; title: string }> = [
  { id: 'iso', label: 'Iso', title: 'Isometric view' },
  { id: 'top', label: 'Top', title: 'View from above (plan)' },
  { id: 'front', label: 'Front', title: 'View along −Z (elevation)' },
  { id: 'side', label: 'Side', title: 'View along −X (side elevation)' },
  { id: 'fit', label: 'Fit', title: 'Fit the model to the window (F)' },
];

export function ViewPresets() {
  const { state, dispatch } = useStore3D();
  // Plane frame mode keeps the orthographic front view; only "Fit" applies.
  const presets = isPlane(state.project) ? PRESETS.filter((p) => p.id === 'fit') : PRESETS;
  return (
    <div className="viewer-presets" role="group" aria-label="Camera">
      {isPlane(state.project) && (
        <span className="plane-badge" title="Plane frame mode: XY plane, front view">
          Plane XY
        </span>
      )}
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          className="ghost"
          title={p.title}
          aria-label={p.title}
          onClick={() => dispatch({ type: 'camera', preset: p.id })}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/** Deformation and diagram scale sliders over the bottom-right of the viewer. */
export function ScaleControls() {
  const { state, dispatch } = useStore3D();
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
    </div>
  );
}
