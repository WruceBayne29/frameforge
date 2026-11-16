import { STEEL_GRADES } from '../../design-codes';
import {
  addLoad,
  deleteMember,
  deleteNode,
  memberProps,
  moveNode,
  setSupport,
  updateMember,
} from '../../model';
import type { MemberType, Project, SupportKind } from '../../model';
import { NumberField, Row, SectionSelect, TextField } from '../fields';
import { fmt, mm } from '../format';
import { useStore } from '../store';
import { utilisationColor } from '../canvas/ResultsLayer';
import { LoadEditor } from './LoadEditor';

const SUPPORT_OPTIONS: Array<{ id: SupportKind | 'none'; label: string }> = [
  { id: 'none', label: 'None (free)' },
  { id: 'fixed', label: 'Fixed' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'rollerX', label: 'Roller — rolls in X' },
  { id: 'rollerY', label: 'Roller — rolls in Y' },
];

function NodeProperties({ id }: { id: string }) {
  const { state, dispatch, solution } = useStore();
  const project = state.project;
  const node = project.nodes.find((n) => n.id === id);
  if (!node) return null;
  const edit = (next: Project) => dispatch({ type: 'edit', project: next });
  const support = project.supports.find((s) => s.node === id)?.kind ?? 'none';
  const loads = project.loads.filter((l) => l.kind === 'nodal' && l.node === id);
  const d = solution.result?.displacements[id];
  const r = solution.result?.reactions[id];
  return (
    <>
      <h3>Node {id}</h3>
      <Row label="X (m)">
        <NumberField
          value={node.x}
          onCommit={(x) => edit(moveNode(project, id, x, node.y))}
          label="X"
        />
      </Row>
      <Row label="Y (m)">
        <NumberField
          value={node.y}
          onCommit={(y) => edit(moveNode(project, id, node.x, y))}
          label="Y"
        />
      </Row>
      <Row label="Support">
        <select
          aria-label="Support"
          value={support}
          onChange={(e) =>
            edit(
              setSupport(
                project,
                id,
                e.target.value === 'none' ? null : (e.target.value as SupportKind),
              ),
            )
          }
        >
          {SUPPORT_OPTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Row>

      <h4>Loads on this node</h4>
      {loads.length === 0 && <p className="muted">No loads. Negative Fy acts downward.</p>}
      {loads.map((l) => (
        <LoadEditor key={l.id} load={l} project={project} />
      ))}
      <button
        type="button"
        onClick={() =>
          edit(addLoad(project, { kind: 'nodal', node: id, fx: 0, fy: -10, mz: 0 }).project)
        }
      >
        + Add nodal load
      </button>

      {(d || r) && <h4>Results</h4>}
      {d && (
        <>
          <Row label="δx">{mm(d.ux)} mm</Row>
          <Row label="δy">{mm(d.uy)} mm</Row>
          <Row label="Rotation">{fmt(d.rz * 1000)} mrad</Row>
        </>
      )}
      {r && (
        <>
          <Row label="Reaction Rx">{fmt(r.fx)} kN</Row>
          <Row label="Reaction Ry">{fmt(r.fy)} kN</Row>
          <Row label="Reaction Mz">{fmt(r.mz)} kN·m</Row>
        </>
      )}

      <button
        type="button"
        className="danger"
        onClick={() =>
          dispatch({ type: 'edit', project: deleteNode(project, id), selection: null })
        }
      >
        Delete node
      </button>
    </>
  );
}

function MemberProperties({ id }: { id: string }) {
  const { state, dispatch, solution } = useStore();
  const project = state.project;
  const member = project.members.find((m) => m.id === id);
  if (!member) return null;
  const edit = (next: Project) => dispatch({ type: 'edit', project: next });
  const a = project.nodes.find((n) => n.id === member.i);
  const b = project.nodes.find((n) => n.id === member.j);
  const length = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  const props = memberProps(project, member);
  const loads = project.loads.filter((l) => l.kind !== 'nodal' && l.member === id);
  const r = solution.result?.members[id];
  const design = solution.design[id];
  return (
    <>
      <h3>Member {id}</h3>
      <Row label="Nodes">
        {member.i} → {member.j}
      </Row>
      <Row label="Length">{fmt(length)} m</Row>
      <Row
        label="Type"
        hint="Frame members carry bending; truss members are pin-ended and carry axial force only"
      >
        <select
          aria-label="Member type"
          value={member.type}
          onChange={(e) => edit(updateMember(project, id, { type: e.target.value as MemberType }))}
        >
          <option value="frame">Frame (rigid ends)</option>
          <option value="truss">Truss (pin ends)</option>
        </select>
      </Row>
      <Row label="Section">
        <SectionSelect
          project={project}
          value={member.section}
          onChange={(section) => edit(updateMember(project, id, { section }))}
        />
      </Row>
      <Row label="A / I">
        {fmt(props.A)} cm² / {fmt(props.I)} cm⁴
      </Row>
      {member.type === 'frame' && (
        <Row label="Hinges" hint="Moment releases (internal hinges) at the member ends">
          <label className="check">
            <input
              type="checkbox"
              checked={!!member.releaseI}
              onChange={(e) =>
                edit(updateMember(project, id, { releaseI: e.target.checked || undefined }))
              }
            />
            start
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={!!member.releaseJ}
              onChange={(e) =>
                edit(updateMember(project, id, { releaseJ: e.target.checked || undefined }))
              }
            />
            end
          </label>
        </Row>
      )}

      <h4>Loads on this member</h4>
      {loads.length === 0 && <p className="muted">No loads. Negative values act downward.</p>}
      {loads.map((l) => (
        <LoadEditor key={l.id} load={l} project={project} />
      ))}
      <div className="button-row">
        <button
          type="button"
          onClick={() =>
            edit(
              addLoad(project, { kind: 'distributed', member: id, direction: 'globalY', w1: -10 })
                .project,
            )
          }
        >
          + UDL
        </button>
        <button
          type="button"
          onClick={() =>
            edit(
              addLoad(project, {
                kind: 'point',
                member: id,
                direction: 'globalY',
                P: -10,
                a: Number((length / 2).toFixed(3)),
              }).project,
            )
          }
        >
          + Point
        </button>
        <button
          type="button"
          onClick={() =>
            edit(
              addLoad(project, {
                kind: 'moment',
                member: id,
                M: 10,
                a: Number((length / 2).toFixed(3)),
              }).project,
            )
          }
        >
          + Moment
        </button>
      </div>

      {r && (
        <>
          <h4>Results</h4>
          <Row label="Axial N">
            {fmt(r.minAxial.value)} … {fmt(r.maxAxial.value)} kN
          </Row>
          <Row label="Max |V|">{fmt(Math.abs(r.maxAbsShear.value))} kN</Row>
          <Row label="Moment M">
            {fmt(r.minMoment.value)} … {fmt(r.maxMoment.value)} kN·m
          </Row>
          <Row label="Max deflection" hint="Relative to the chord joining the displaced ends">
            {mm(Math.abs(r.maxAbsDeflection.value))} mm
            {Math.abs(r.maxAbsDeflection.value) > 1e-9 &&
              ` (L/${fmt(length / Math.abs(r.maxAbsDeflection.value), 0)})`}
          </Row>
        </>
      )}

      {design && (
        <>
          <h4>
            IS 800:2007 check{' '}
            <span
              className="badge"
              style={{ background: utilisationColor(design.result.utilisation) }}
            >
              {design.result.utilisation.toFixed(2)} {design.result.ok ? 'OK' : 'FAIL'}
            </span>
          </h4>
          <Row label="Section class">{design.result.sectionClass}</Row>
          <table className="data compact">
            <thead>
              <tr>
                <th>Check</th>
                <th>Demand</th>
                <th>Capacity</th>
                <th>Ratio</th>
              </tr>
            </thead>
            <tbody>
              {design.result.checks.map((c) => (
                <tr key={c.id} className={c.ok ? '' : 'fail'} title={c.clause}>
                  <td>{c.name}</td>
                  <td>
                    {fmt(c.demand)} {c.unit}
                  </td>
                  <td>
                    {fmt(c.capacity)} {c.unit}
                  </td>
                  <td>{c.ratio.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {design.result.warnings.map((w) => (
            <p key={w} className="warning">
              {w}
            </p>
          ))}
        </>
      )}
      {!design && r && <p className="muted">Design checks need a rolled ISMB / ISMC section.</p>}

      <button
        type="button"
        className="danger"
        onClick={() =>
          dispatch({ type: 'edit', project: deleteMember(project, id), selection: null })
        }
      >
        Delete member
      </button>
    </>
  );
}

function ProjectProperties() {
  const { state, dispatch } = useStore();
  const project = state.project;
  const edit = (next: Project) => dispatch({ type: 'edit', project: next });
  const design = project.design;
  return (
    <>
      <h3>Project</h3>
      <Row label="Name">
        <TextField
          value={project.name}
          onCommit={(name) => edit({ ...project, name })}
          label="Project name"
        />
      </Row>
      {project.description && <p className="muted">{project.description}</p>}
      <Row label="E (GPa)" hint="Young's modulus used for every member">
        <NumberField
          value={project.E}
          min={0.001}
          onCommit={(E) => edit({ ...project, E })}
          label="E"
        />
      </Row>

      <h4>Steel design — IS 800:2007</h4>
      <Row label="Grade">
        <select
          aria-label="Steel grade"
          value={design.grade}
          onChange={(e) => edit({ ...project, design: { ...design, grade: e.target.value } })}
        >
          {STEEL_GRADES.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name} (fy = {g.fy} MPa)
            </option>
          ))}
        </select>
      </Row>
      <Row
        label="Effective length K"
        hint="Effective length factor applied to buckling about both axes"
      >
        <NumberField
          value={design.effectiveLengthFactor}
          min={0.1}
          step={0.05}
          onCommit={(k) => edit({ ...project, design: { ...design, effectiveLengthFactor: k } })}
          label="Effective length factor"
        />
      </Row>
      <label className="check">
        <input
          type="checkbox"
          checked={design.laterallyRestrained}
          onChange={(e) =>
            edit({ ...project, design: { ...design, laterallyRestrained: e.target.checked } })
          }
        />
        Compression flange laterally restrained (no LTB)
      </label>

      <h4>Custom sections</h4>
      {project.customSections.length === 0 && (
        <p className="muted">Add a section with your own A and I for non-standard members.</p>
      )}
      {project.customSections.map((s, k) => {
        const patch = (p: Partial<typeof s>) =>
          edit({
            ...project,
            customSections: project.customSections.map((c, idx) =>
              idx === k ? { ...c, ...p } : c,
            ),
            members:
              p.name && p.name !== s.name
                ? project.members.map((m) =>
                    m.section === s.name ? { ...m, section: p.name as string } : m,
                  )
                : project.members,
          });
        return (
          <div key={s.name} className="load-card">
            <div className="load-card-grid">
              <label>
                Name
                <TextField
                  value={s.name}
                  onCommit={(name) => patch({ name })}
                  label="Section name"
                />
              </label>
              <label>
                A (cm²)
                <NumberField value={s.A} min={0.0001} onCommit={(A) => patch({ A })} label="Area" />
              </label>
              <label>
                I (cm⁴)
                <NumberField
                  value={s.I}
                  min={0.0001}
                  onCommit={(I) => patch({ I })}
                  label="Second moment of area"
                />
              </label>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => {
          let n = project.customSections.length + 1;
          while (project.customSections.some((s) => s.name === `Custom ${n}`)) n++;
          edit({
            ...project,
            customSections: [...project.customSections, { name: `Custom ${n}`, A: 50, I: 5000 }],
          });
        }}
      >
        + Add custom section
      </button>

      <p className="muted tip">
        Tip: select a node or member on the canvas to edit it here, or use the Tables tab to edit
        everything as a spreadsheet.
      </p>
    </>
  );
}

export function Properties() {
  const { state } = useStore();
  const sel = state.selection;
  if (sel?.kind === 'node') return <NodeProperties id={sel.id} />;
  if (sel?.kind === 'member') return <MemberProperties id={sel.id} />;
  if (sel?.kind === 'load') {
    const load = state.project.loads.find((l) => l.id === sel.id);
    if (load?.kind === 'nodal') return <NodeProperties id={load.node} />;
    if (load) return <MemberProperties id={load.member} />;
  }
  return <ProjectProperties />;
}
