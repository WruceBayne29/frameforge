import { deleteLoad, updateLoad } from '../../model';
import type { LoadDirection, Project, ProjectLoad } from '../../model';
import { NumberField } from '../fields';
import { useStore } from '../store';

const DIRECTIONS: Array<{ id: LoadDirection; label: string }> = [
  { id: 'globalY', label: 'Global Y (vertical)' },
  { id: 'globalX', label: 'Global X (horizontal)' },
  { id: 'localY', label: 'Local y (normal to member)' },
  { id: 'localX', label: 'Local x (along member)' },
];

export function loadSummary(load: ProjectLoad): string {
  switch (load.kind) {
    case 'nodal':
      return 'Nodal load';
    case 'distributed':
      return load.w2 !== undefined && load.w2 !== load.w1 ? 'Trapezoidal load' : 'Uniform load';
    case 'point':
      return 'Point load';
    case 'moment':
      return 'Moment';
  }
}

/** Editable card for one load. */
export function LoadEditor({ load, project }: { load: ProjectLoad; project: Project }) {
  const { state, dispatch } = useStore();
  const selected = state.selection?.kind === 'load' && state.selection.id === load.id;
  const patch = (p: Partial<ProjectLoad>) =>
    dispatch({ type: 'edit', project: updateLoad(project, load.id, p) });
  const direction = (value: LoadDirection) => (
    <label>
      Direction
      <select value={value} onChange={(e) => patch({ direction: e.target.value as LoadDirection })}>
        {DIRECTIONS.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div
      className={`load-card${selected ? ' selected' : ''}`}
      onClick={() => dispatch({ type: 'select', selection: { kind: 'load', id: load.id } })}
    >
      <div className="load-card-head">
        <strong>
          {load.id} · {loadSummary(load)}
        </strong>
        <button
          type="button"
          className="ghost danger"
          title="Delete this load"
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: 'edit', project: deleteLoad(project, load.id), selection: null });
          }}
        >
          Delete
        </button>
      </div>
      <div className="load-card-grid">
        {load.kind === 'nodal' && (
          <>
            <label>
              Fx (kN)
              <NumberField value={load.fx} onCommit={(fx) => patch({ fx })} label="Fx" />
            </label>
            <label>
              Fy (kN)
              <NumberField value={load.fy} onCommit={(fy) => patch({ fy })} label="Fy" />
            </label>
            <label>
              Mz (kN·m)
              <NumberField value={load.mz} onCommit={(mz) => patch({ mz })} label="Mz" />
            </label>
          </>
        )}
        {load.kind === 'distributed' && (
          <>
            {direction(load.direction)}
            <label>
              w start (kN/m)
              <NumberField value={load.w1} onCommit={(w1) => patch({ w1 })} label="w start" />
            </label>
            <label>
              w end (kN/m)
              <NumberField
                value={load.w2 ?? load.w1}
                onCommit={(w2) => patch({ w2 })}
                label="w end"
              />
            </label>
            <label>
              From (m)
              <NumberField
                value={load.a ?? 0}
                min={0}
                onCommit={(a) => patch({ a })}
                label="Start position"
              />
            </label>
            <label>
              To (m)
              <NumberField
                value={load.b}
                min={0}
                placeholder="end"
                onCommit={(b) => patch({ b })}
                label="End position"
              />
            </label>
          </>
        )}
        {load.kind === 'point' && (
          <>
            {direction(load.direction)}
            <label>
              P (kN)
              <NumberField value={load.P} onCommit={(P) => patch({ P })} label="P" />
            </label>
            <label>
              At (m from start)
              <NumberField value={load.a} min={0} onCommit={(a) => patch({ a })} label="Position" />
            </label>
          </>
        )}
        {load.kind === 'moment' && (
          <>
            <label>
              M (kN·m, +ve anticlockwise)
              <NumberField value={load.M} onCommit={(M) => patch({ M })} label="M" />
            </label>
            <label>
              At (m from start)
              <NumberField value={load.a} min={0} onCommit={(a) => patch({ a })} label="Position" />
            </label>
          </>
        )}
      </div>
    </div>
  );
}
