import { deleteLoad, isPlane, loadTargets, updateLoad, withLoadTargets } from '../../model3d';
import type {
  GlobalDirection,
  MemberLoadDirection,
  NewLoad3D,
  Project3D,
  ProjectLoad3D,
  SolidFace,
} from '../../model3d';
import { NumberField, TextField } from '../fields3d';
import { DIRECTION_LABEL, idList, loadSummary3D, parseIdList } from '../format3d';
import { isSelected } from '../state';
import { useStore3D } from '../store';

const MEMBER_DIRECTIONS: MemberLoadDirection[] = [
  'globalY',
  'globalX',
  'globalZ',
  'localX',
  'localY',
  'localZ',
];
const GLOBAL: GlobalDirection[] = ['globalY', 'globalX', 'globalZ'];

const FACE_NAMES: Record<SolidFace, string> = {
  1: 'Face 1 (nodes 1-2-3-4)',
  2: 'Face 2 (nodes 5-6-7-8)',
  3: 'Face 3 (nodes 1-2-6-5)',
  4: 'Face 4 (nodes 2-3-7-6)',
  5: 'Face 5 (nodes 3-4-8-7)',
  6: 'Face 6 (nodes 4-1-5-8)',
};

function knownIds(project: Project3D, load: ProjectLoad3D): Set<string> {
  const kind = loadTargets(load).kind;
  const list =
    kind === 'nodes'
      ? project.nodes
      : kind === 'members'
        ? project.members
        : kind === 'plates'
          ? project.plates
          : project.solids;
  return new Set(list.map((x) => x.id));
}

/** Editable card for one load of any kind. */
export function LoadEditor3D({ load }: { load: ProjectLoad3D }) {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const selected = isSelected(state.selection, 'load', load.id);
  const patch = (p: Partial<NewLoad3D>) =>
    dispatch({ type: 'edit', project: updateLoad(project, load.id, p) });
  const num = (
    label: string,
    value: number | undefined,
    commit: (v: number) => void,
    extra: { min?: number; placeholder?: string } = {},
  ) => (
    <label>
      {label}
      <NumberField value={value} onCommit={commit} label={label} {...extra} />
    </label>
  );
  const direction = <D extends string>(
    value: D,
    options: readonly D[],
    labels: Record<string, string>,
  ) => (
    <label>
      Direction
      <select
        aria-label="Load direction"
        value={value}
        onChange={(e) => patch({ direction: e.target.value } as Partial<NewLoad3D>)}
      >
        {options.map((d) => (
          <option key={d} value={d}>
            {labels[d] ?? d}
          </option>
        ))}
      </select>
    </label>
  );
  const targets = loadTargets(load);
  const known = knownIds(project, load);
  // Plane frame mode shows only the in-plane components and directions (an existing
  // out-of-plane value stays visible so it can be cleared).
  const plane = isPlane(project);
  const memberDirections = plane
    ? MEMBER_DIRECTIONS.filter(
        (d) => !d.endsWith('Z') || ('direction' in load && load.direction === d),
      )
    : MEMBER_DIRECTIONS;
  const outOfPlane = (value: number) => !plane || value !== 0;

  return (
    <div
      className={`load-card${selected ? ' selected' : ''}`}
      onClick={() => dispatch({ type: 'select', selection: { kind: 'load', ids: [load.id] } })}
    >
      <div className="load-card-head">
        <strong>
          {load.id} · {loadSummary3D(load)}
        </strong>
        <button
          type="button"
          className="ghost danger"
          title="Delete this load"
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: 'edit', project: deleteLoad(project, load.id) });
          }}
        >
          Delete
        </button>
      </div>
      <div className="load-card-grid">
        <label className="span-all" style={{ gridColumn: '1 / -1' }}>
          On {targets.kind} ({targets.ids.length})
          <TextField
            value={targets.ids.join(', ')}
            label={`Load ${load.id} targets`}
            onCommit={(text) => {
              const ids = parseIdList(text, known);
              if (ids.length > 0) {
                dispatch({
                  type: 'edit',
                  project: {
                    ...project,
                    loads: project.loads.map((l) =>
                      l.id === load.id ? withLoadTargets(l, ids) : l,
                    ),
                  },
                });
              }
            }}
          />
        </label>
        {load.kind === 'nodal' && (
          <>
            {num('Fx (kN)', load.fx, (fx) => patch({ fx }))}
            {num('Fy (kN)', load.fy, (fy) => patch({ fy }))}
            {outOfPlane(load.fz) && num('Fz (kN)', load.fz, (fz) => patch({ fz }))}
            {outOfPlane(load.mx) && num('Mx (kN·m)', load.mx, (mx) => patch({ mx }))}
            {outOfPlane(load.my) && num('My (kN·m)', load.my, (my) => patch({ my }))}
            {num('Mz (kN·m)', load.mz, (mz) => patch({ mz }))}
          </>
        )}
        {load.kind === 'distributed' && (
          <>
            {direction(load.direction, memberDirections, DIRECTION_LABEL)}
            {num('w start (kN/m)', load.w1, (w1) => patch({ w1 }))}
            {num('w end (kN/m)', load.w2 ?? load.w1, (w2) => patch({ w2 }))}
            {num('From (m)', load.a ?? 0, (a) => patch({ a }), { min: 0 })}
            {num('To (m)', load.b, (b) => patch({ b }), { min: 0, placeholder: 'end' })}
          </>
        )}
        {load.kind === 'point' && (
          <>
            {direction(load.direction, memberDirections, DIRECTION_LABEL)}
            {num('P (kN)', load.P, (P) => patch({ P }))}
            {num('At (m from node i)', load.a, (a) => patch({ a }), { min: 0 })}
          </>
        )}
        {load.kind === 'moment' && (
          <>
            {direction(load.direction, MEMBER_DIRECTIONS, DIRECTION_LABEL)}
            {num('M (kN·m)', load.M, (M) => patch({ M }))}
            {num('At (m from node i)', load.a, (a) => patch({ a }), { min: 0 })}
          </>
        )}
        {load.kind === 'pressure' && (
          <>
            {direction(load.direction, ['localZ', ...GLOBAL] as const, {
              ...DIRECTION_LABEL,
              localZ: 'Plate normal (local z)',
            })}
            {num('p (kN/m²)', load.p, (p) => patch({ p }))}
          </>
        )}
        {load.kind === 'platePoint' && (
          <>
            {direction(load.direction, ['localZ', ...GLOBAL] as const, {
              ...DIRECTION_LABEL,
              localZ: 'Plate normal (local z)',
            })}
            {num('P (kN)', load.P, (P) => patch({ P }))}
            {num('ξ (−1…1)', load.xi, (xi) => patch({ xi: Math.max(-1, Math.min(1, xi)) }))}
            {num('η (−1…1)', load.eta, (eta) => patch({ eta: Math.max(-1, Math.min(1, eta)) }))}
          </>
        )}
        {load.kind === 'face' && (
          <>
            <label>
              Face
              <select
                aria-label="Solid face"
                value={load.face}
                onChange={(e) => patch({ face: Number(e.target.value) as SolidFace })}
              >
                {([1, 2, 3, 4, 5, 6] as SolidFace[]).map((f) => (
                  <option key={f} value={f}>
                    {FACE_NAMES[f]}
                  </option>
                ))}
              </select>
            </label>
            {direction(load.direction, ['normal', ...GLOBAL] as const, {
              ...DIRECTION_LABEL,
              normal: 'Normal (pushing in)',
            })}
            {num('p (kN/m²)', load.p, (p) => patch({ p }))}
          </>
        )}
      </div>
      {targets.ids.length > 6 && <p className="muted">Acts on {idList(targets.ids)}</p>}
    </div>
  );
}
