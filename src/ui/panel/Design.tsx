import { STEEL_GRADES } from '../../design-codes';
import { utilisationColor } from '../canvas/ResultsLayer';
import { useStore } from '../store';

export function Design() {
  const { state, dispatch, solution } = useStore();
  const project = state.project;
  const rows = project.members
    .map((m) => ({ member: m, design: solution.design[m.id] }))
    .sort((a, b) => (b.design?.result.utilisation ?? -1) - (a.design?.result.utilisation ?? -1));
  const checked = rows.filter((r) => r.design);
  const failing = checked.filter((r) => r.design && !r.design.result.ok).length;
  const worst = checked[0]?.design?.result.utilisation ?? 0;
  const sel = state.selection;
  const grade = STEEL_GRADES.find((g) => g.name === project.design.grade) ?? STEEL_GRADES[0];

  return (
    <>
      <h3>Steel design — IS 800:2007</h3>
      {!solution.result && (
        <p className="muted">Design checks run once the structure can be analysed.</p>
      )}
      {solution.result && (
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
            Colour members by utilisation
          </label>
          <div className="legend" aria-hidden="true">
            <span>0</span>
            <div className="legend-bar" />
            <span>1.0</span>
            <div className="legend-fail" />
            <span>&gt; 1 fails</span>
          </div>
          <p className="muted">
            {grade.name} steel (fy = {grade.fy} MPa), K = {project.design.effectiveLengthFactor},{' '}
            {project.design.laterallyRestrained
              ? 'compression flange restrained'
              : 'lateral-torsional buckling checked'}
            . Change these under Properties with nothing selected.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>Member</th>
                <th>Section</th>
                <th>Class</th>
                <th>Governing check</th>
                <th>Ratio</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ member, design }) => {
                const governing = design?.result.checks.find(
                  (c) => c.id === design.result.governing,
                );
                return (
                  <tr
                    key={member.id}
                    className={sel?.kind === 'member' && sel.id === member.id ? 'selected' : ''}
                    onClick={() =>
                      dispatch({ type: 'select', selection: { kind: 'member', id: member.id } })
                    }
                  >
                    <td>{member.id}</td>
                    <td>{member.section}</td>
                    <td>{design?.result.sectionClass ?? '–'}</td>
                    <td title={governing?.clause}>
                      {governing?.name ?? (design ? 'No load' : 'Custom section')}
                    </td>
                    <td>
                      {design ? (
                        <span
                          className="badge"
                          style={{ background: utilisationColor(design.result.utilisation) }}
                        >
                          {design.result.utilisation.toFixed(2)}
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
          <p className="muted">
            Checks: tension (cl. 6.2), compression buckling (cl. 7.1.2), bending incl. LTB (cl.
            8.2), shear (cl. 8.4) and combined axial + bending (cl. 9.3). Click a member for the
            full breakdown. This is a learning tool, not a substitute for a checked design.
          </p>
        </>
      )}
    </>
  );
}
