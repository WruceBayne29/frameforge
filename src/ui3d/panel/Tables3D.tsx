import { useState } from 'react';
import {
  addLoad,
  addMember,
  addNode,
  isPlane,
  deleteLoad,
  deleteMember,
  deleteNode,
  deletePlate,
  deleteSolid,
  FIXED_SUPPORT,
  loadTargets,
  moveNode,
  setSupport,
  updateMember,
  updatePlate,
  updateSolid,
  withLoadTargets,
} from '../../model3d';
import type {
  Project3D,
  ProjectLoad3D,
  ProjectPlate3D,
  ProjectSolid3D,
  Restraints6,
} from '../../model3d';
import { defaultLoad } from '../edits';
import { MaterialSelect, NumberField, SectionSelect3D, TextField } from '../fields3d';
import { fmt, loadSummary3D, loadValueText, parseIdList } from '../format3d';
import { applySupport, isSelected, presetOf } from '../state';
import type { SelectionKind, SupportPreset } from '../state';
import { useStore3D } from '../store';
import { usePage } from './Pager';

type TableId = 'nodes' | 'members' | 'plates' | 'solids' | 'supports' | 'loads';

const DOFS = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];

function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="ghost danger icon"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      ×
    </button>
  );
}

/** Spreadsheet-style editing of the whole 3D model. */
export function Tables3D() {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const [table, setTable] = useState<TableId>('nodes');
  const edit = (next: Project3D) => dispatch({ type: 'edit', project: next });
  const sel = state.selection;
  const rowProps = (kind: SelectionKind, id: string) => ({
    className: isSelected(sel, kind, id) ? 'selected' : '',
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('input, select, button')) return;
      dispatch({ type: 'pick', pick: { kind, id }, additive: e.shiftKey });
    },
  });
  const counts: Record<TableId, number> = {
    nodes: project.nodes.length,
    members: project.members.length,
    plates: project.plates.length,
    solids: project.solids.length,
    supports: project.supports.length,
    loads: project.loads.length,
  };
  const tables: TableId[] = ['nodes', 'members', 'plates', 'solids', 'supports', 'loads'];

  return (
    <>
      <div className="segmented wide" role="tablist" aria-label="Table">
        {tables.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={table === t}
            className={table === t ? 'active' : ''}
            onClick={() => setTable(t)}
            title={`${t} (${counts[t]})`}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {table === 'nodes' && <NodesTable edit={edit} rowProps={rowProps} />}
      {table === 'members' && <MembersTable edit={edit} rowProps={rowProps} />}
      {table === 'plates' && <PlatesTable edit={edit} rowProps={rowProps} />}
      {table === 'solids' && <SolidsTable edit={edit} rowProps={rowProps} />}
      {table === 'supports' && <SupportsTable edit={edit} />}
      {table === 'loads' && <LoadsTable edit={edit} rowProps={rowProps} />}
    </>
  );
}

interface TableProps {
  edit: (project: Project3D) => void;
  rowProps: (
    kind: SelectionKind,
    id: string,
  ) => {
    className: string;
    onClick: (e: React.MouseEvent) => void;
  };
}

function NodesTable({ edit, rowProps }: TableProps) {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const { rows, pager } = usePage(project.nodes);
  const plane = isPlane(project);
  const axes = plane ? (['x', 'y'] as const) : (['x', 'y', 'z'] as const);
  return (
    <>
      <div className="table-scroll">
        <table className="data editable compact" aria-label="Nodes">
          <thead>
            <tr>
              <th>Node</th>
              {axes.map((a) => (
                <th key={a}>{a.toUpperCase()} (m)</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id} {...rowProps('node', n.id)}>
                <td>{n.id}</td>
                {axes.map((axis) => (
                  <td key={axis}>
                    <NumberField
                      value={n[axis]}
                      width={62}
                      label={axis.toUpperCase()}
                      onCommit={(v) => {
                        const next = { x: n.x, y: n.y, z: n.z, [axis]: v };
                        edit(moveNode(project, n.id, next.x, next.y, next.z));
                      }}
                    />
                  </td>
                ))}
                <td>
                  <DeleteButton
                    label={`Delete node ${n.id}`}
                    onClick={() => edit(deleteNode(project, n.id))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager}
      <button
        type="button"
        onClick={() => {
          const maxX = project.nodes.reduce((m, n) => Math.max(m, n.x), -1);
          const r = addNode(project, maxX + 1, 0, 0);
          dispatch({ type: 'edit', project: r.project, selection: { kind: 'node', ids: [r.id] } });
        }}
      >
        + Add node
      </button>
    </>
  );
}

function MembersTable({ edit, rowProps }: TableProps) {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const { rows, pager } = usePage(project.members);
  const nodeOptions = project.nodes.map((n) => (
    <option key={n.id} value={n.id}>
      {n.id}
    </option>
  ));
  const bigModel = project.nodes.length > 400;
  return (
    <>
      <div className="table-scroll">
        <table className="data editable compact" aria-label="Members">
          <thead>
            <tr>
              <th>Member</th>
              <th>i</th>
              <th>j</th>
              <th>Type</th>
              <th>Section</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} {...rowProps('member', m.id)}>
                <td>{m.id}</td>
                {(['i', 'j'] as const).map((end) => (
                  <td key={end}>
                    {bigModel ? (
                      <TextField
                        value={m[end]}
                        width={56}
                        label={`Node ${end}`}
                        onCommit={(id) =>
                          project.nodes.some((n) => n.id === id) &&
                          edit(updateMember(project, m.id, { [end]: id }))
                        }
                      />
                    ) : (
                      <select
                        aria-label={`Node ${end}`}
                        value={m[end]}
                        onChange={(e) =>
                          edit(updateMember(project, m.id, { [end]: e.target.value }))
                        }
                      >
                        {nodeOptions}
                      </select>
                    )}
                  </td>
                ))}
                <td>
                  <select
                    aria-label="Type"
                    value={m.type}
                    onChange={(e) =>
                      edit(
                        updateMember(project, m.id, { type: e.target.value as 'beam' | 'truss' }),
                      )
                    }
                  >
                    <option value="beam">Beam</option>
                    <option value="truss">Truss</option>
                  </select>
                </td>
                <td>
                  <SectionSelect3D
                    project={project}
                    value={m.section}
                    onChange={(section) => edit(updateMember(project, m.id, { section }))}
                  />
                </td>
                <td>
                  <DeleteButton
                    label={`Delete member ${m.id}`}
                    onClick={() => edit(deleteMember(project, m.id))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager}
      <button
        type="button"
        disabled={project.nodes.length < 2}
        title="Join the first pair of nodes that has no member yet"
        onClick={() => {
          const ids = project.nodes.map((n) => n.id);
          const joined = new Set(project.members.map((m) => [m.i, m.j].sort().join('|')));
          for (let a = 0; a < ids.length; a++) {
            for (let b = a + 1; b < ids.length; b++) {
              if (joined.has([ids[a], ids[b]].sort().join('|'))) continue;
              const r = addMember(project, ids[a], ids[b], {
                type: state.toolOptions.memberType,
                section: state.toolOptions.section,
              });
              dispatch({
                type: 'edit',
                project: r.project,
                selection: r.id ? { kind: 'member', ids: [r.id] } : undefined,
              });
              return;
            }
          }
        }}
      >
        + Add member
      </button>
    </>
  );
}

function NodeListCell({
  value,
  count,
  label,
  onCommit,
}: {
  value: readonly string[];
  count: number;
  label: string;
  onCommit: (ids: string[]) => void;
}) {
  const { state } = useStore3D();
  const known = new Set(state.project.nodes.map((n) => n.id));
  return (
    <TextField
      value={value.join(' ')}
      label={label}
      onCommit={(text) => {
        const ids = parseIdList(text, known);
        if (ids.length === count) onCommit(ids);
      }}
    />
  );
}

function PlatesTable({ edit, rowProps }: TableProps) {
  const { state } = useStore3D();
  const project = state.project;
  const { rows, pager } = usePage(project.plates);
  return (
    <>
      {project.plates.length === 0 && (
        <p className="muted">No plates. Use the Plate tool or Generate → Plate mesh.</p>
      )}
      {project.plates.length > 0 && (
        <div className="table-scroll">
          <table className="data editable compact" aria-label="Plates">
            <thead>
              <tr>
                <th>Plate</th>
                <th>Nodes (4)</th>
                <th>t (mm)</th>
                <th>Material</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} {...rowProps('plate', p.id)}>
                  <td>{p.id}</td>
                  <td>
                    <NodeListCell
                      value={p.nodes}
                      count={4}
                      label="Plate nodes"
                      onCommit={(ids) =>
                        edit(updatePlate(project, p.id, { nodes: ids as ProjectPlate3D['nodes'] }))
                      }
                    />
                  </td>
                  <td>
                    <NumberField
                      value={p.thickness}
                      min={0.1}
                      width={56}
                      label="Thickness (mm)"
                      onCommit={(thickness) => edit(updatePlate(project, p.id, { thickness }))}
                    />
                  </td>
                  <td>
                    <MaterialSelect
                      project={project}
                      value={p.material}
                      onChange={(material) => edit(updatePlate(project, p.id, { material }))}
                    />
                  </td>
                  <td>
                    <DeleteButton
                      label={`Delete plate ${p.id}`}
                      onClick={() => edit(deletePlate(project, p.id))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pager}
    </>
  );
}

function SolidsTable({ edit, rowProps }: TableProps) {
  const { state } = useStore3D();
  const project = state.project;
  const { rows, pager } = usePage(project.solids);
  return (
    <>
      {project.solids.length === 0 && (
        <p className="muted">No solids. Use Generate → Solid block.</p>
      )}
      {project.solids.length > 0 && (
        <div className="table-scroll">
          <table className="data editable compact" aria-label="Solids">
            <thead>
              <tr>
                <th>Solid</th>
                <th>Nodes (8)</th>
                <th>Material</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} {...rowProps('solid', s.id)}>
                  <td>{s.id}</td>
                  <td>
                    <NodeListCell
                      value={s.nodes}
                      count={8}
                      label="Solid nodes"
                      onCommit={(ids) =>
                        edit(updateSolid(project, s.id, { nodes: ids as ProjectSolid3D['nodes'] }))
                      }
                    />
                  </td>
                  <td>
                    <MaterialSelect
                      project={project}
                      value={s.material}
                      onChange={(material) => edit(updateSolid(project, s.id, { material }))}
                    />
                  </td>
                  <td>
                    <DeleteButton
                      label={`Delete solid ${s.id}`}
                      onClick={() => edit(deleteSolid(project, s.id))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pager}
    </>
  );
}

function SupportsTable({ edit }: { edit: (project: Project3D) => void }) {
  const { state } = useStore3D();
  const project = state.project;
  const { rows, pager } = usePage(project.supports);
  const free = project.nodes.find((n) => !project.supports.some((s) => s.node === n.id));
  if (isPlane(project)) return <PlaneSupportsTable edit={edit} />;
  return (
    <>
      <div className="table-scroll">
        <table className="data editable compact" aria-label="Supports">
          <thead>
            <tr>
              <th>Node</th>
              {DOFS.map((d) => (
                <th key={d}>{d}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.node}>
                <td>{s.node}</td>
                {DOFS.map((d, k) => (
                  <td key={d}>
                    <input
                      type="checkbox"
                      aria-label={`${s.node} ${d}`}
                      checked={s.restraints[k]}
                      onChange={(e) => {
                        const next = [...s.restraints] as Restraints6;
                        next[k] = e.target.checked;
                        edit(setSupport(project, s.node, next));
                      }}
                    />
                  </td>
                ))}
                <td>
                  <DeleteButton
                    label={`Remove support at ${s.node}`}
                    onClick={() => edit(setSupport(project, s.node, null))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager}
      <button
        type="button"
        disabled={!free}
        onClick={() => free && edit(setSupport(project, free.id, FIXED_SUPPORT))}
      >
        + Add support{free ? ` at ${free.id}` : ''}
      </button>
    </>
  );
}

/** Plane frame mode: one 2D support kind per node (fixed, pinned, roller X, roller Y). */
function PlaneSupportsTable({ edit }: { edit: (project: Project3D) => void }) {
  const { state } = useStore3D();
  const project = state.project;
  const { rows, pager } = usePage(project.supports);
  const free = project.nodes.find((n) => !project.supports.some((s) => s.node === n.id));
  return (
    <>
      <div className="table-scroll">
        <table className="data editable compact" aria-label="Supports">
          <thead>
            <tr>
              <th>Node</th>
              <th>Type</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const preset = presetOf(s.restraints, true);
              return (
                <tr key={s.node}>
                  <td>{s.node}</td>
                  <td>
                    <select
                      aria-label={`Support type at ${s.node}`}
                      value={preset}
                      onChange={(e) =>
                        edit(
                          applySupport(project, [s.node], {
                            supportPreset: e.target.value as SupportPreset,
                            restraints: s.restraints,
                          }),
                        )
                      }
                    >
                      <option value="fixed">Fixed</option>
                      <option value="pinned">Pinned</option>
                      <option value="rollerX">Roller (rolls along X)</option>
                      <option value="rollerY">Roller (rolls along Y)</option>
                      {preset === 'custom' && <option value="custom">Custom</option>}
                    </select>
                  </td>
                  <td>
                    <DeleteButton
                      label={`Remove support at ${s.node}`}
                      onClick={() => edit(setSupport(project, s.node, null))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pager}
      <button
        type="button"
        disabled={!free}
        onClick={() => free && edit(setSupport(project, free.id, FIXED_SUPPORT))}
      >
        + Add support{free ? ` at ${free.id}` : ''}
      </button>
    </>
  );
}

function LoadsTable({ edit, rowProps }: TableProps) {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const { rows, pager } = usePage(project.loads);
  const known = (load: ProjectLoad3D) => {
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
  };
  return (
    <>
      <div className="table-scroll">
        <table className="data editable compact" aria-label="Loads">
          <thead>
            <tr>
              <th>Load</th>
              <th>Kind</th>
              <th>Targets</th>
              <th>Value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} {...rowProps('load', l.id)}>
                <td>{l.id}</td>
                <td>{loadSummary3D(l)}</td>
                <td>
                  <TextField
                    value={loadTargets(l).ids.join(' ')}
                    label="Targets"
                    onCommit={(text) => {
                      const ids = parseIdList(text, known(l));
                      if (ids.length > 0) {
                        edit({
                          ...project,
                          loads: project.loads.map((x) =>
                            x.id === l.id ? withLoadTargets(x, ids) : x,
                          ),
                        });
                      }
                    }}
                  />
                </td>
                <td className="muted">{loadValueText(l) || fmt(0)}</td>
                <td>
                  <DeleteButton
                    label={`Delete load ${l.id}`}
                    onClick={() => edit(deleteLoad(project, l.id))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager}
      <p className="muted">Select a load to edit all of its values in Properties.</p>
      <button
        type="button"
        disabled={project.nodes.length === 0}
        onClick={() => {
          const r = addLoad(
            project,
            defaultLoad('nodal', [project.nodes[project.nodes.length - 1].id]),
          );
          dispatch({ type: 'edit', project: r.project, selection: { kind: 'load', ids: [r.id] } });
        }}
      >
        + Add nodal load
      </button>
    </>
  );
}
