import { useState } from 'react';
import { memberProps3D } from '../../model3d';
import type { EndRelease, Project3D, Restraints6 } from '../../model3d';
import {
  addDefaultLoad,
  common,
  LOAD_KINDS_FOR,
  loadsOn,
  memberLength,
  setNodeCoordinate,
  updateMembers,
  updatePlates,
  updateSolids,
} from '../edits';
import type { NewLoadKind } from '../edits';
import {
  MaterialSelect,
  NumberField,
  RestraintBoxes,
  Row,
  SectionSelect3D,
  TextField,
} from '../fields3d';
import { countText, fmt, idList, restraintLabel } from '../format3d';
import { applySupport, deleteSelection, presetOf } from '../state';
import type { Selection3D, SelectionKind, SupportPreset } from '../state';
import { useStore3D } from '../store';
import { LoadEditor3D } from './LoadEditor3D';

const NOUN: Record<SelectionKind, string> = {
  node: 'node',
  member: 'member',
  plate: 'plate',
  solid: 'solid',
  load: 'load',
};

const RELEASES: Array<{ key: keyof EndRelease; label: string }> = [
  { key: 'mx', label: 'Mx' },
  { key: 'my', label: 'My' },
  { key: 'mz', label: 'Mz' },
  { key: 'fx', label: 'Fx' },
  { key: 'fy', label: 'Fy' },
  { key: 'fz', label: 'Fz' },
];

/** Loads on the selection, and a button to add one of each suitable kind. */
function SelectionLoads({ selection }: { selection: Selection3D }) {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const kinds = LOAD_KINDS_FOR[selection.kind] ?? [];
  const [kind, setKind] = useState<NewLoadKind | undefined>(kinds[0]?.kind);
  const loads = loadsOn(project, selection.kind, selection.ids);
  const chosen = kinds.some((k) => k.kind === kind) ? kind : kinds[0]?.kind;
  return (
    <>
      <h4>Loads</h4>
      {kinds.length > 0 && chosen && (
        <div className="button-row">
          <select
            aria-label="New load type"
            value={chosen}
            onChange={(e) => setKind(e.target.value as NewLoadKind)}
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              const r = addDefaultLoad(project, chosen, selection.ids);
              dispatch({ type: 'edit', project: r.project });
            }}
          >
            Add load to{' '}
            {selection.ids.length === 1
              ? selection.ids[0]
              : countText(selection.ids.length, NOUN[selection.kind])}
          </button>
        </div>
      )}
      {loads.length === 0 && <p className="muted">No loads on the selection.</p>}
      {loads.slice(0, 30).map((load) => (
        <LoadEditor3D key={load.id} load={load} />
      ))}
      {loads.length > 30 && <p className="muted">…and {loads.length - 30} more (see Tables).</p>}
    </>
  );
}

function NodeProperties({ ids }: { ids: string[] }) {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const nodes = project.nodes.filter((n) => ids.includes(n.id));
  const supports = ids.map((id) => project.supports.find((s) => s.node === id)?.restraints);
  const first: Restraints6 = supports[0] ?? [false, false, false, false, false, false];
  const same = supports.every((r) => (r ?? []).join() === (supports[0] ?? []).join());
  const preset = same ? presetOf(supports[0]) : undefined;
  const edit = (next: Project3D) => dispatch({ type: 'edit', project: next });
  const single = nodes.length === 1;
  return (
    <>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <Row key={axis} label={`${axis.toUpperCase()} (m)`}>
          <NumberField
            value={common(nodes, (n) => n[axis])}
            placeholder="mixed"
            label={axis.toUpperCase()}
            onCommit={(v) => edit(setNodeCoordinate(project, ids, axis, v))}
          />
        </Row>
      ))}
      <h4>Support</h4>
      <Row label="Type">
        <select
          aria-label="Support type"
          value={preset ?? ''}
          onChange={(e) =>
            edit(
              applySupport(project, ids, {
                supportPreset: e.target.value as SupportPreset,
                restraints: first,
              }),
            )
          }
        >
          {preset === undefined && (
            <option value="" disabled>
              (mixed)
            </option>
          )}
          <option value="none">None</option>
          <option value="fixed">Fixed</option>
          <option value="pinned">Pinned</option>
          <option value="roller">Roller (uy)</option>
          <option value="custom">Custom</option>
        </select>
      </Row>
      {same && (
        <RestraintBoxes
          value={first}
          idPrefix="node"
          onChange={(restraints) =>
            edit(applySupport(project, ids, { supportPreset: 'custom', restraints }))
          }
        />
      )}
      {single && supports[0] && <p className="muted">Restrained: {restraintLabel(supports[0])}</p>}
    </>
  );
}

function MemberProperties({ ids }: { ids: string[] }) {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const members = project.members.filter((m) => ids.includes(m.id));
  const edit = (next: Project3D) => dispatch({ type: 'edit', project: next });
  const one = members.length === 1 ? members[0] : null;
  const type = common(members, (m) => m.type);
  const release = (end: 'releaseI' | 'releaseJ', key: keyof EndRelease) =>
    common(members, (m) => !!m[end]?.[key]);
  const setRelease = (end: 'releaseI' | 'releaseJ', key: keyof EndRelease, on: boolean) => {
    let next = project;
    for (const m of members) {
      const r: EndRelease = { ...(m[end] ?? {}) };
      if (on) r[key] = true;
      else delete r[key];
      next = updateMembers(next, [m.id], { [end]: Object.keys(r).length > 0 ? r : undefined });
    }
    edit(next);
  };
  const props = one ? memberProps3D(project, one) : null;
  return (
    <>
      {one && (
        <Row label="Nodes">
          {one.i} → {one.j} · L = {fmt(memberLength(project, one.id))} m
        </Row>
      )}
      <Row label="Type">
        <select
          aria-label="Member type"
          value={type ?? ''}
          onChange={(e) =>
            edit(updateMembers(project, ids, { type: e.target.value as 'beam' | 'truss' }))
          }
        >
          {type === undefined && (
            <option value="" disabled>
              (mixed)
            </option>
          )}
          <option value="beam">Beam</option>
          <option value="truss">Truss</option>
        </select>
      </Row>
      <Row label="Section">
        <SectionSelect3D
          project={project}
          value={common(members, (m) => m.section)}
          onChange={(section) => edit(updateMembers(project, ids, { section }))}
        />
      </Row>
      <Row label="Material">
        <MaterialSelect
          project={project}
          value={common(members, (m) => m.material)}
          onChange={(material) => edit(updateMembers(project, ids, { material }))}
        />
      </Row>
      <Row label="Roll angle β (°)" hint="Rotation of the section about the member axis">
        <NumberField
          value={common(members, (m) => m.beta ?? 0)}
          placeholder="mixed"
          label="Roll angle (degrees)"
          onCommit={(beta) => edit(updateMembers(project, ids, { beta: beta || undefined }))}
        />
      </Row>
      {props && (
        <p className="muted">
          A {fmt(props.A)} cm² · Iz {fmt(props.Iz)} cm⁴ · Iy {fmt(props.Iy)} cm⁴ · J {fmt(props.J)}{' '}
          cm⁴
        </p>
      )}
      {type !== 'truss' && (
        <>
          <h4>End releases</h4>
          {(['releaseI', 'releaseJ'] as const).map((end) => (
            <div key={end} className="field-row">
              <span className="field-label">
                {end === 'releaseI' ? 'Start (node i)' : 'End (node j)'}
              </span>
              <span className="field-control dof-grid">
                {RELEASES.map((r) => (
                  <label
                    key={r.key}
                    title={`Release ${r.label} at the ${end === 'releaseI' ? 'start' : 'end'}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Release ${r.label} at ${end === 'releaseI' ? 'start' : 'end'}`}
                      checked={release(end, r.key) ?? false}
                      onChange={(e) => setRelease(end, r.key, e.target.checked)}
                    />
                    {r.label}
                  </label>
                ))}
              </span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function PlateProperties({ ids }: { ids: string[] }) {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const plates = project.plates.filter((p) => ids.includes(p.id));
  const edit = (next: Project3D) => dispatch({ type: 'edit', project: next });
  return (
    <>
      {plates.length === 1 && <Row label="Nodes">{plates[0].nodes.join(', ')}</Row>}
      <Row label="Thickness (mm)">
        <NumberField
          value={common(plates, (p) => p.thickness)}
          min={0.1}
          placeholder="mixed"
          label="Plate thickness (mm)"
          onCommit={(thickness) => edit(updatePlates(project, ids, { thickness }))}
        />
      </Row>
      <Row label="Material">
        <MaterialSelect
          project={project}
          value={common(plates, (p) => p.material)}
          onChange={(material) => edit(updatePlates(project, ids, { material }))}
        />
      </Row>
    </>
  );
}

function SolidProperties({ ids }: { ids: string[] }) {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const solids = project.solids.filter((s) => ids.includes(s.id));
  return (
    <>
      {solids.length === 1 && <Row label="Nodes">{solids[0].nodes.join(', ')}</Row>}
      <Row label="Material">
        <MaterialSelect
          project={project}
          value={common(solids, (s) => s.material)}
          onChange={(material) =>
            dispatch({ type: 'edit', project: updateSolids(project, ids, { material }) })
          }
        />
      </Row>
    </>
  );
}

/** Project details shown when nothing is selected. */
function ProjectProperties() {
  const { state, dispatch } = useStore3D();
  const p = state.project;
  const edit = (next: Project3D) => dispatch({ type: 'edit', project: next });
  return (
    <>
      <h3>Project</h3>
      <Row label="Name">
        <TextField value={p.name} label="Project name" onCommit={(name) => edit({ ...p, name })} />
      </Row>
      {p.description && <p className="muted">{p.description}</p>}
      <label className="check">
        <input
          type="checkbox"
          checked={p.selfWeight}
          onChange={(e) => edit({ ...p, selfWeight: e.target.checked })}
        />
        Include self-weight (gravity along −Y)
      </label>
      <div className="stat-grid">
        <div>
          <span>Nodes</span>
          <strong>{p.nodes.length}</strong>
        </div>
        <div>
          <span>Members</span>
          <strong>{p.members.length}</strong>
        </div>
        <div>
          <span>Plates</span>
          <strong>{p.plates.length}</strong>
        </div>
        <div>
          <span>Solids</span>
          <strong>{p.solids.length}</strong>
        </div>
      </div>
      <p className="muted tip">
        Click an item in the view to edit it; Shift+click adds to the selection. Loads applied here
        act on every selected item. Use Generate for frames, plate meshes and solid blocks.
      </p>
    </>
  );
}

export function Properties3D() {
  const { state, dispatch } = useStore3D();
  const selection = state.selection;
  if (!selection) return <ProjectProperties />;
  const { kind, ids } = selection;
  const title =
    ids.length === 1
      ? `${NOUN[kind][0].toUpperCase()}${NOUN[kind].slice(1)} ${ids[0]}`
      : `${countText(ids.length, NOUN[kind])}`;
  const loads = kind === 'load' ? state.project.loads.filter((l) => ids.includes(l.id)) : [];
  return (
    <>
      <h3>{title}</h3>
      {ids.length > 1 && (
        <p className="muted">{idList(ids, 8)} · fields show shared values; edits apply to all.</p>
      )}
      {kind === 'node' && <NodeProperties ids={ids} />}
      {kind === 'member' && <MemberProperties ids={ids} />}
      {kind === 'plate' && <PlateProperties ids={ids} />}
      {kind === 'solid' && <SolidProperties ids={ids} />}
      {kind === 'load' && loads.map((load) => <LoadEditor3D key={load.id} load={load} />)}
      {kind !== 'load' && <SelectionLoads key={`${kind}:${ids.join()}`} selection={selection} />}
      <button
        type="button"
        className="danger"
        onClick={() =>
          dispatch({
            type: 'edit',
            project: deleteSelection(state.project, selection),
            selection: null,
          })
        }
      >
        Delete {ids.length === 1 ? ids[0] : countText(ids.length, NOUN[kind])}
      </button>
    </>
  );
}
