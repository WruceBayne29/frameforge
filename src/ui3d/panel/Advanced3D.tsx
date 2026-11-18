import { useState } from 'react';
import { isPlane } from '../../model3d';
import type { Project3D } from '../../model3d';
import type { InfluenceTarget3D } from '../../solver3d';
import { NumberField, Row } from '../fields3d';
import { fmt, idList } from '../format3d';
import { useStore3D } from '../store';
import { usePage } from './Pager';

type TargetKind = InfluenceTarget3D['kind'];

const COMPONENTS: Record<TargetKind, { all: string[]; plane: string[]; label: string }> = {
  reaction: {
    all: ['fx', 'fy', 'fz', 'mx', 'my', 'mz'],
    plane: ['fx', 'fy', 'mz'],
    label: 'Reaction at a support',
  },
  memberForce: {
    all: ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'],
    plane: ['N', 'Vy', 'Mz'],
    label: 'Internal force at a section',
  },
  displacement: {
    all: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
    plane: ['ux', 'uy', 'rz'],
    label: 'Displacement of a node',
  },
};

const UNIT: Record<string, string> = {
  fx: 'kN/kN',
  fy: 'kN/kN',
  fz: 'kN/kN',
  mx: 'kN·m/kN',
  my: 'kN·m/kN',
  mz: 'kN·m/kN',
  N: 'kN/kN',
  Vy: 'kN/kN',
  Vz: 'kN/kN',
  T: 'kN·m/kN',
  My: 'kN·m/kN',
  Mz: 'kN·m/kN',
  ux: 'mm/kN',
  uy: 'mm/kN',
  uz: 'mm/kN',
  rx: 'mrad/kN',
  ry: 'mrad/kN',
  rz: 'mrad/kN',
};

/** Ordinates shown in the table: displacements in mm or mrad per kN. */
const shown = (component: string, value: number) =>
  component.startsWith('u') || component.startsWith('r') ? value * 1000 : value;

function memberLength(project: Project3D, id: string): number {
  const m = project.members.find((x) => x.id === id);
  const a = project.nodes.find((n) => n.id === m?.i);
  const b = project.nodes.find((n) => n.id === m?.j);
  return a && b ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : 0;
}

/** A sensible first target: the selected member or node, else the first support. */
function initialTarget(project: Project3D, selected: { kind: string; id: string } | null) {
  if (selected?.kind === 'member') {
    return {
      kind: 'memberForce',
      member: selected.id,
      x: memberLength(project, selected.id) / 2,
      component: 'Mz',
    } as const;
  }
  if (selected?.kind === 'node') {
    const supported = project.supports.some((s) => s.node === selected.id);
    return supported
      ? ({ kind: 'reaction', node: selected.id, component: 'fy' } as const)
      : ({ kind: 'displacement', node: selected.id, component: 'uy' } as const);
  }
  const support = project.supports[0]?.node;
  if (support) return { kind: 'reaction', node: support, component: 'fy' } as const;
  const member = project.members[0];
  return {
    kind: 'memberForce',
    member: member?.id ?? '',
    x: member ? memberLength(project, member.id) / 2 : 0,
    component: 'Mz',
  } as const;
}

/** Influence lines for a unit load moving along the near-horizontal members. */
function Influence() {
  const { state, dispatch, extras } = useStore3D();
  const project = state.project;
  const plane = isPlane(project);
  const active = state.advanced.influence;
  const sel =
    state.selection && state.selection.ids.length === 1
      ? { kind: state.selection.kind, id: state.selection.ids[0] }
      : null;
  const [draft, setDraft] = useState<InfluenceTarget3D>(
    () => active ?? initialTarget(project, sel),
  );
  const line = active ? extras.influence : null;
  const { rows, pager } = usePage(line?.ordinates ?? [], 30);
  const components = COMPONENTS[draft.kind][plane ? 'plane' : 'all'];
  const show = (target: InfluenceTarget3D | null) =>
    dispatch({ type: 'advanced', advanced: { influence: target } });
  const update = (next: InfluenceTarget3D) => {
    setDraft(next);
    if (active) show(next);
  };
  const setKind = (kind: TargetKind) => {
    if (kind === 'memberForce') {
      const member = sel?.kind === 'member' ? sel.id : (project.members[0]?.id ?? '');
      update({ kind, member, x: memberLength(project, member) / 2, component: 'Mz' });
      return;
    }
    const node =
      'node' in draft ? draft.node : sel?.kind === 'node' ? sel.id : (project.nodes[0]?.id ?? '');
    if (kind === 'displacement') {
      update({ kind, node, component: 'uy' });
      return;
    }
    const supported = project.supports.some((s) => s.node === node);
    update({ kind, node: supported ? node : (project.supports[0]?.node ?? node), component: 'fy' });
  };
  const unit = UNIT[draft.component];
  return (
    <section aria-label="Influence lines">
      <h3>Influence lines</h3>
      <p className="muted">
        A unit load acting downward (−Y) moves along the{' '}
        {plane ? 'beams (near-horizontal members)' : 'near-horizontal members'}; the line shows the
        chosen response for each load position.
      </p>
      <Row label="Response">
        <select
          aria-label="Influence line response"
          value={draft.kind}
          onChange={(e) => setKind(e.target.value as TargetKind)}
        >
          {(Object.keys(COMPONENTS) as TargetKind[]).map((k) => (
            <option key={k} value={k}>
              {COMPONENTS[k].label}
            </option>
          ))}
        </select>
      </Row>
      {draft.kind === 'memberForce' ? (
        <>
          <Row label="Member">
            <select
              aria-label="Influence line member"
              value={draft.member}
              onChange={(e) =>
                update({
                  ...draft,
                  member: e.target.value,
                  x: memberLength(project, e.target.value) / 2,
                })
              }
            >
              {project.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Section at (m from node i)">
            <NumberField
              value={draft.x}
              min={0}
              label="Section position (m)"
              onCommit={(x) =>
                update({ ...draft, x: Math.min(x, memberLength(project, draft.member)) })
              }
            />
          </Row>
        </>
      ) : (
        <Row label="Node">
          <select
            aria-label="Influence line node"
            value={draft.node}
            onChange={(e) => update({ ...draft, node: e.target.value })}
          >
            {(draft.kind === 'reaction'
              ? project.supports.map((s) => s.node)
              : project.nodes.map((n) => n.id)
            ).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Row>
      )}
      <Row label="Component">
        <select
          aria-label="Influence line component"
          value={draft.component}
          onChange={(e) => update({ ...draft, component: e.target.value } as InfluenceTarget3D)}
        >
          {components.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Row>
      <div className="button-row">
        <button type="button" className={active ? '' : 'primary'} onClick={() => show(draft)}>
          {active ? 'Update' : 'Show influence line'}
        </button>
        {active && (
          <button type="button" onClick={() => show(null)}>
            Hide
          </button>
        )}
      </div>
      {active && extras.influenceError && <p className="warning">{extras.influenceError}</p>}
      {line && (
        <>
          <p className="muted">
            Load path: {idList(extras.influencePath, 8)}. Largest{' '}
            {fmt(shown(draft.component, line.max.value))} {unit} with the load on {line.max.member}{' '}
            at {fmt(line.max.x)} m; smallest {fmt(shown(draft.component, line.min.value))} on{' '}
            {line.min.member} at {fmt(line.min.x)} m.
          </p>
          <div className="table-scroll">
            <table className="data compact" aria-label="Influence line ordinates">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>x (m)</th>
                  <th>Value ({unit})</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o, k) => (
                  <tr key={`${o.member}-${k}`}>
                    <td>{o.member}</td>
                    <td>{fmt(o.x)}</td>
                    <td>{fmt(shown(draft.component, o.value))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pager}
        </>
      )}
    </section>
  );
}

/** Natural frequencies, mode shapes and mass participation. */
function Modal() {
  const { state, dispatch, extras } = useStore3D();
  const { modal, mode } = state.advanced;
  const project = state.project;
  const plane = isPlane(project);
  const r = extras.modal;
  const set = (advanced: Partial<typeof state.advanced>) =>
    dispatch({ type: 'advanced', advanced });
  const masses = project.masses ?? [];
  return (
    <section aria-label="Modal analysis">
      <h3>Modal analysis</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={modal}
          onChange={(e) => set({ modal: e.target.checked, mode: e.target.checked ? 0 : null })}
        />
        Compute natural frequencies and mode shapes
      </label>
      <p className="muted">
        Mass from the material densities (weight density / g) of every member, plate and solid
        {masses.length > 0
          ? `, plus ${masses.length} lumped nodal mass${masses.length === 1 ? '' : 'es'}`
          : ''}
        ; add lumped masses on a node in Properties. Beam members are subdivided so the higher modes
        are accurate.
      </p>
      {modal && extras.modalError && <p className="warning">{extras.modalError}</p>}
      {modal && r && (
        <>
          <p className="muted">
            Total mass {fmt(r.totalMass)} t · {r.dofCount} dynamic degrees of freedom. Click a mode
            to animate it.
          </p>
          {r.warnings.map((w) => (
            <p key={w} className="warning">
              {w}
            </p>
          ))}
          <div className="table-scroll">
            <table className="data compact" aria-label="Natural frequencies">
              <thead>
                <tr>
                  <th>Mode</th>
                  <th>f (Hz)</th>
                  <th>T (s)</th>
                  <th>ω (rad/s)</th>
                  <th title="Effective modal mass along X, % of the total">mX %</th>
                  <th title="Effective modal mass along Y, % of the total">mY %</th>
                  {!plane && <th title="Effective modal mass along Z, % of the total">mZ %</th>}
                </tr>
              </thead>
              <tbody>
                {r.modes.map((m, k) => (
                  <tr
                    key={k}
                    className={mode === k ? 'selected' : ''}
                    onClick={() => set({ mode: mode === k ? null : k })}
                  >
                    <td>{k + 1}</td>
                    <td>{fmt(m.frequency)}</td>
                    <td>{fmt(m.period)}</td>
                    <td>{fmt(m.omega)}</td>
                    {m.massFraction.slice(0, plane ? 2 : 3).map((v, d) => (
                      <td key={d}>{(v * 100).toFixed(1)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mode !== null && (
            <button type="button" onClick={() => set({ mode: null })}>
              Stop the animation
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function Advanced3D() {
  const { state } = useStore3D();
  return (
    <>
      <Modal />
      {state.project.members.length > 0 && <Influence />}
    </>
  );
}
