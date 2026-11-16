import { useState } from 'react';
import {
  addLoad,
  addMember,
  addNode,
  deleteLoad,
  deleteMember,
  deleteNode,
  moveNode,
  setSupport,
  updateLoad,
  updateMember,
} from '../../model';
import type { MemberType, Project, ProjectLoad, SupportKind } from '../../model';
import { NumberField, SectionSelect } from '../fields';
import { useStore } from '../store';
import { loadSummary } from './LoadEditor';

type TableId = 'nodes' | 'members' | 'loads';

/** Spreadsheet-style editing of the whole model, as an alternative to drawing. */
export function Tables() {
  const { state, dispatch } = useStore();
  const [table, setTable] = useState<TableId>('nodes');
  const project = state.project;
  const edit = (next: Project) => dispatch({ type: 'edit', project: next });
  const sel = state.selection;
  const rowClass = (kind: 'node' | 'member' | 'load', id: string) =>
    sel?.kind === kind && sel.id === id ? 'selected' : '';
  const select = (kind: 'node' | 'member' | 'load', id: string) =>
    dispatch({ type: 'select', selection: { kind, id } });

  const addNodeRow = () => {
    // Place the new node one grid step to the right of the right-most node.
    const maxX = project.nodes.reduce((m, n) => Math.max(m, n.x), -1);
    const r = addNode(project, maxX + 1, 0);
    dispatch({ type: 'edit', project: r.project, selection: { kind: 'node', id: r.id } });
  };

  const addMemberRow = () => {
    for (const a of project.nodes) {
      for (const b of project.nodes) {
        if (a.id >= b.id) continue;
        const exists = project.members.some(
          (m) => (m.i === a.id && m.j === b.id) || (m.i === b.id && m.j === a.id),
        );
        if (exists) continue;
        const r = addMember(
          project,
          a.id,
          b.id,
          state.toolOptions.memberType,
          state.toolOptions.section,
        );
        dispatch({
          type: 'edit',
          project: r.project,
          selection: r.id ? { kind: 'member', id: r.id } : null,
        });
        return;
      }
    }
  };

  const nodeOptions = project.nodes.map((n) => (
    <option key={n.id} value={n.id}>
      {n.id}
    </option>
  ));
  const memberOptions = project.members.map((m) => (
    <option key={m.id} value={m.id}>
      {m.id}
    </option>
  ));

  const loadCells = (load: ProjectLoad) => {
    const patch = (p: Partial<ProjectLoad>) => edit(updateLoad(project, load.id, p));
    switch (load.kind) {
      case 'nodal':
        return (
          <>
            <td>
              <select
                aria-label="Node"
                value={load.node}
                onChange={(e) => patch({ node: e.target.value })}
              >
                {nodeOptions}
              </select>
            </td>
            <td>
              <NumberField
                value={load.fx}
                onCommit={(fx) => patch({ fx })}
                label="Fx (kN)"
                width={58}
              />
            </td>
            <td>
              <NumberField
                value={load.fy}
                onCommit={(fy) => patch({ fy })}
                label="Fy (kN)"
                width={58}
              />
            </td>
            <td>
              <NumberField
                value={load.mz}
                onCommit={(mz) => patch({ mz })}
                label="Mz (kN·m)"
                width={58}
              />
            </td>
          </>
        );
      case 'distributed':
        return (
          <>
            <td>
              <select
                aria-label="Member"
                value={load.member}
                onChange={(e) => patch({ member: e.target.value })}
              >
                {memberOptions}
              </select>
            </td>
            <td>
              <NumberField
                value={load.w1}
                onCommit={(w1) => patch({ w1 })}
                label="w start (kN/m)"
                width={58}
              />
            </td>
            <td>
              <NumberField
                value={load.w2 ?? load.w1}
                onCommit={(w2) => patch({ w2 })}
                label="w end (kN/m)"
                width={58}
              />
            </td>
            <td className="muted">{load.direction}</td>
          </>
        );
      case 'point':
        return (
          <>
            <td>
              <select
                aria-label="Member"
                value={load.member}
                onChange={(e) => patch({ member: e.target.value })}
              >
                {memberOptions}
              </select>
            </td>
            <td>
              <NumberField
                value={load.P}
                onCommit={(P) => patch({ P })}
                label="P (kN)"
                width={58}
              />
            </td>
            <td>
              <NumberField
                value={load.a}
                min={0}
                onCommit={(a) => patch({ a })}
                label="Position (m)"
                width={58}
              />
            </td>
            <td className="muted">{load.direction}</td>
          </>
        );
      case 'moment':
        return (
          <>
            <td>
              <select
                aria-label="Member"
                value={load.member}
                onChange={(e) => patch({ member: e.target.value })}
              >
                {memberOptions}
              </select>
            </td>
            <td>
              <NumberField
                value={load.M}
                onCommit={(M) => patch({ M })}
                label="M (kN·m)"
                width={58}
              />
            </td>
            <td>
              <NumberField
                value={load.a}
                min={0}
                onCommit={(a) => patch({ a })}
                label="Position (m)"
                width={58}
              />
            </td>
            <td />
          </>
        );
    }
  };

  return (
    <>
      <div className="segmented wide" role="tablist">
        {(['nodes', 'members', 'loads'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={table === t}
            className={table === t ? 'active' : ''}
            onClick={() => setTable(t)}
          >
            {t[0].toUpperCase() + t.slice(1)} (
            {t === 'nodes'
              ? project.nodes.length
              : t === 'members'
                ? project.members.length
                : project.loads.length}
            )
          </button>
        ))}
      </div>

      {table === 'nodes' && (
        <>
          <table className="data editable">
            <thead>
              <tr>
                <th>Node</th>
                <th>X (m)</th>
                <th>Y (m)</th>
                <th>Support</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {project.nodes.map((n) => (
                <tr
                  key={n.id}
                  className={rowClass('node', n.id)}
                  onFocus={() => select('node', n.id)}
                >
                  <td>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => select('node', n.id)}
                    >
                      {n.id}
                    </button>
                  </td>
                  <td>
                    <NumberField
                      value={n.x}
                      onCommit={(x) => edit(moveNode(project, n.id, x, n.y))}
                      label="X"
                      width={62}
                    />
                  </td>
                  <td>
                    <NumberField
                      value={n.y}
                      onCommit={(y) => edit(moveNode(project, n.id, n.x, y))}
                      label="Y"
                      width={62}
                    />
                  </td>
                  <td>
                    <select
                      aria-label="Support"
                      value={project.supports.find((s) => s.node === n.id)?.kind ?? 'none'}
                      onChange={(e) =>
                        edit(
                          setSupport(
                            project,
                            n.id,
                            e.target.value === 'none' ? null : (e.target.value as SupportKind),
                          ),
                        )
                      }
                    >
                      <option value="none">–</option>
                      <option value="fixed">Fixed</option>
                      <option value="pinned">Pinned</option>
                      <option value="rollerX">Roller X</option>
                      <option value="rollerY">Roller Y</option>
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost danger icon"
                      title={`Delete node ${n.id}`}
                      aria-label={`Delete node ${n.id}`}
                      onClick={() =>
                        dispatch({
                          type: 'edit',
                          project: deleteNode(project, n.id),
                          selection: null,
                        })
                      }
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={addNodeRow}>
            + Add node
          </button>
        </>
      )}

      {table === 'members' && (
        <>
          <table className="data editable">
            <thead>
              <tr>
                <th>Member</th>
                <th>Start</th>
                <th>End</th>
                <th>Type</th>
                <th>Section</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {project.members.map((m) => (
                <tr
                  key={m.id}
                  className={rowClass('member', m.id)}
                  onFocus={() => select('member', m.id)}
                >
                  <td>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => select('member', m.id)}
                    >
                      {m.id}
                    </button>
                  </td>
                  <td>
                    <select
                      aria-label="Start node"
                      value={m.i}
                      onChange={(e) =>
                        e.target.value !== m.j &&
                        edit(updateMember(project, m.id, { i: e.target.value }))
                      }
                    >
                      {nodeOptions}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label="End node"
                      value={m.j}
                      onChange={(e) =>
                        e.target.value !== m.i &&
                        edit(updateMember(project, m.id, { j: e.target.value }))
                      }
                    >
                      {nodeOptions}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label="Type"
                      value={m.type}
                      onChange={(e) =>
                        edit(updateMember(project, m.id, { type: e.target.value as MemberType }))
                      }
                    >
                      <option value="frame">Frame</option>
                      <option value="truss">Truss</option>
                    </select>
                  </td>
                  <td>
                    <SectionSelect
                      project={project}
                      value={m.section}
                      onChange={(section) => edit(updateMember(project, m.id, { section }))}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost danger icon"
                      title={`Delete member ${m.id}`}
                      aria-label={`Delete member ${m.id}`}
                      onClick={() =>
                        dispatch({
                          type: 'edit',
                          project: deleteMember(project, m.id),
                          selection: null,
                        })
                      }
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={addMemberRow} disabled={project.nodes.length < 2}>
            + Add member
          </button>
        </>
      )}

      {table === 'loads' && (
        <>
          <table className="data editable">
            <thead>
              <tr>
                <th>Load</th>
                <th>On</th>
                <th title="Fx, w start, P or M">Value 1</th>
                <th title="Fy, w end or position">Value 2</th>
                <th title="Mz or direction">Value 3</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {project.loads.map((l) => (
                <tr
                  key={l.id}
                  className={rowClass('load', l.id)}
                  onFocus={() => select('load', l.id)}
                >
                  <td title={loadSummary(l)}>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => select('load', l.id)}
                    >
                      {l.id}
                    </button>{' '}
                    <span className="muted">{loadSummary(l).split(' ')[0]}</span>
                  </td>
                  {loadCells(l)}
                  <td>
                    <button
                      type="button"
                      className="ghost danger icon"
                      title={`Delete load ${l.id}`}
                      aria-label={`Delete load ${l.id}`}
                      onClick={() =>
                        dispatch({
                          type: 'edit',
                          project: deleteLoad(project, l.id),
                          selection: null,
                        })
                      }
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Nodal: Fx, Fy (kN), Mz (kN·m). Uniform / trapezoidal: w start, w end (kN/m). Point: P
            (kN), position (m). Negative = downward / leftward.
          </p>
          <div className="button-row">
            <button
              type="button"
              disabled={project.nodes.length === 0}
              onClick={() =>
                edit(
                  addLoad(project, {
                    kind: 'nodal',
                    node: project.nodes[0].id,
                    fx: 0,
                    fy: -10,
                    mz: 0,
                  }).project,
                )
              }
            >
              + Nodal
            </button>
            <button
              type="button"
              disabled={project.members.length === 0}
              onClick={() =>
                edit(
                  addLoad(project, {
                    kind: 'distributed',
                    member: project.members[0].id,
                    direction: 'globalY',
                    w1: -10,
                  }).project,
                )
              }
            >
              + UDL
            </button>
            <button
              type="button"
              disabled={project.members.length === 0}
              onClick={() =>
                edit(
                  addLoad(project, {
                    kind: 'point',
                    member: project.members[0].id,
                    direction: 'globalY',
                    P: -10,
                    a: 0,
                  }).project,
                )
              }
            >
              + Point
            </button>
          </div>
        </>
      )}
    </>
  );
}
