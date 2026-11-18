import { STEEL_GRADES } from '../../design-codes';
import { checkLabel3D, utilisationColor } from '../../model3d';
import type { MemberDesign3D, Project3D } from '../../model3d';
import { NumberField, Row } from '../fields3d';
import { fmt } from '../format3d';
import { isSelected } from '../state';
import { useStore3D } from '../store';
import { usePage } from './Pager';

/** Project-level design settings: grade, lateral restraint, effective length factors. */
function Settings() {
  const { state, dispatch } = useStore3D();
  const p = state.project;
  const edit = (design: Partial<Project3D['design']>) =>
    dispatch({ type: 'edit', project: { ...p, design: { ...p.design, ...design } } });
  return (
    <>
      <Row label="Steel grade">
        <select
          aria-label="Steel grade"
          value={p.design.grade}
          onChange={(e) => edit({ grade: e.target.value })}
        >
          {STEEL_GRADES.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name} (fy {g.fy} MPa)
            </option>
          ))}
        </select>
      </Row>
      <Row label="K about z-z (major)">
        <NumberField
          value={p.design.kz}
          min={0.01}
          label="Effective length factor about z-z"
          onCommit={(kz) => edit({ kz })}
        />
      </Row>
      <Row label="K about y-y (minor, LTB)">
        <NumberField
          value={p.design.ky}
          min={0.01}
          label="Effective length factor about y-y"
          onCommit={(ky) => edit({ ky })}
        />
      </Row>
      <label className="check">
        <input
          type="checkbox"
          checked={p.design.laterallyRestrained}
          onChange={(e) => edit({ laterallyRestrained: e.target.checked })}
        />
        Compression flanges laterally restrained (no lateral-torsional buckling)
      </label>
      <p className="muted">A member can override K in Properties.</p>
    </>
  );
}

/** Full check breakdown of one member. */
function Breakdown({ id, design }: { id: string; design: MemberDesign3D }) {
  const r = design.result;
  return (
    <div className="design-breakdown" aria-label={`Design check of ${id}`}>
      <h4>
        {id} · {design.section}
      </h4>
      <p className="muted">
        Class {r.sectionClass}, ε = {r.epsilon.toFixed(3)}; KL/r = {r.slendernessZ.toFixed(0)} (z-z,
        K = {design.kz}) and {r.slendernessY.toFixed(0)} (y-y, K = {design.ky}).
      </p>
      {r.checks.length === 0 ? (
        <p className="muted">No load in this member.</p>
      ) : (
        <div className="table-scroll">
          <table className="data compact" aria-label={`Checks of ${id}`}>
            <thead>
              <tr>
                <th>Check</th>
                <th>Demand</th>
                <th>Capacity</th>
                <th>Ratio</th>
              </tr>
            </thead>
            <tbody>
              {r.checks.map((c) => (
                <tr key={c.id} title={`${c.name} — ${c.clause}`}>
                  <td>
                    {checkLabel3D(c.id, c.name)}
                    <span className="muted"> · {c.clause.replace('IS 800 ', '')}</span>
                  </td>
                  <td>{c.unit === '-' ? '' : `${fmt(c.demand)} ${c.unit}`}</td>
                  <td>{c.unit === '-' ? '≤ 1' : `${fmt(c.capacity)} ${c.unit}`}</td>
                  <td>
                    <span className="badge" style={{ background: utilisationColor(c.ratio) }}>
                      {c.ratio.toFixed(2)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r.warnings.map((w) => (
        <p key={w} className="warning">
          {w}
        </p>
      ))}
    </div>
  );
}

export function Design3D() {
  const { state, dispatch, solution } = useStore3D();
  const project = state.project;
  const design = solution.design;
  const rows = project.members
    .map((m) => ({ member: m, design: design[m.id] as MemberDesign3D | undefined }))
    .sort((a, b) => (b.design?.result.utilisation ?? -1) - (a.design?.result.utilisation ?? -1));
  const { rows: page, pager } = usePage(rows);
  const checked = rows.filter((r) => r.design);
  const failing = checked.filter((r) => r.design && !r.design.result.ok).length;
  const worst = checked[0]?.design?.result.utilisation ?? 0;
  const sel = state.selection;
  const focus = sel?.kind === 'member' && sel.ids.length === 1 ? sel.ids[0] : null;

  return (
    <>
      <h3>Steel design — IS 800:2007</h3>
      <Settings />
      {project.members.length === 0 && <p className="muted">The model has no members.</p>}
      {project.members.length > 0 && !solution.result && (
        <p className="muted">Design checks run once the structure can be analysed.</p>
      )}
      {solution.result && project.members.length > 0 && (
        <>
          <div className="stat-grid">
            <div>
              <span>Highest utilisation</span>
              <strong style={{ color: utilisationColor(worst) }}>{worst.toFixed(2)}</strong>
            </div>
            <div>
              <span>Members failing</span>
              <strong>
                {failing} / {checked.length}
              </strong>
            </div>
          </div>
          <label className={`chip${state.view.utilisation ? ' on' : ''}`}>
            <input
              type="checkbox"
              checked={state.view.utilisation}
              onChange={(e) => dispatch({ type: 'view', view: { utilisation: e.target.checked } })}
            />
            Colour members by utilisation (U)
          </label>
          <div className="legend" aria-hidden="true">
            <span>0</span>
            <div className="legend-bar" />
            <span>1.0</span>
            <div className="legend-fail" />
            <span>&gt; 1 fails</span>
          </div>
          {focus && design[focus] && <Breakdown id={focus} design={design[focus]} />}
          <div className="table-scroll">
            <table className="data compact" aria-label="Design summary">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Section</th>
                  <th>Governing check</th>
                  <th>Ratio</th>
                </tr>
              </thead>
              <tbody>
                {page.map(({ member, design: d }) => {
                  const governing = d?.result.checks.find((c) => c.id === d.result.governing);
                  return (
                    <tr
                      key={member.id}
                      className={isSelected(sel, 'member', member.id) ? 'selected' : ''}
                      onClick={() =>
                        dispatch({
                          type: 'select',
                          selection: { kind: 'member', ids: [member.id] },
                        })
                      }
                    >
                      <td>{member.id}</td>
                      <td>{member.section}</td>
                      <td title={governing ? `${governing.name} — ${governing.clause}` : undefined}>
                        {governing
                          ? checkLabel3D(governing.id, governing.name)
                          : d
                            ? 'No load'
                            : 'Custom section (not checked)'}
                      </td>
                      <td>
                        {d ? (
                          <span
                            className="badge"
                            style={{ background: utilisationColor(d.result.utilisation) }}
                          >
                            {d.result.utilisation.toFixed(2)}
                          </span>
                        ) : (
                          '–'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pager}
          <p className="muted">
            Checks: tension (cl. 6.2), compression buckling about both axes (cl. 7.1.2), bending
            about z-z with lateral-torsional buckling and about y-y (cl. 8.2), shear along the web
            and across the flanges (cl. 8.4, with the high-shear reduction of cl. 9.2.2), and
            combined axial force + biaxial bending (cl. 9.3.1.1, 9.3.2). Mz is major-axis bending
            (an upright ISMB / ISMC has Iz = Izz). <strong>Torsion is not checked.</strong> Members
            with custom sections are skipped. Click a member for the full breakdown. This is a
            learning tool, not a substitute for a checked design.
          </p>
        </>
      )}
    </>
  );
}
