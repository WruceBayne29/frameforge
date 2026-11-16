import { fmt, mm } from '../format';
import { useStore } from '../store';

export function Results() {
  const { state, dispatch, solution } = useStore();
  const r = solution.result;
  if (solution.error) {
    return (
      <>
        <h3>Results</h3>
        <p className="warning">{solution.error.message}</p>
      </>
    );
  }
  if (!r) {
    return (
      <>
        <h3>Results</h3>
        <p className="muted">Draw a structure with supports and loads to see results here.</p>
      </>
    );
  }
  const project = state.project;
  const reactions = Object.entries(r.reactions);
  const sum = reactions.reduce((s, [, v]) => ({ fx: s.fx + v.fx, fy: s.fy + v.fy }), {
    fx: 0,
    fy: 0,
  });
  const sel = state.selection;
  return (
    <>
      <h3>Results</h3>
      <div className="stat-grid">
        <div>
          <span>Max deflection</span>
          <strong>{mm(r.maxDisplacement)} mm</strong>
        </div>
        <div>
          <span>Degrees of freedom</span>
          <strong>{r.dofCount}</strong>
        </div>
      </div>
      {r.warnings.map((w) => (
        <p key={w} className="warning">
          {w}
        </p>
      ))}

      <h4>Support reactions</h4>
      <table className="data">
        <thead>
          <tr>
            <th>Node</th>
            <th>Rx (kN)</th>
            <th>Ry (kN)</th>
            <th>Mz (kN·m)</th>
          </tr>
        </thead>
        <tbody>
          {reactions.map(([id, v]) => (
            <tr
              key={id}
              className={sel?.kind === 'node' && sel.id === id ? 'selected' : ''}
              onClick={() => dispatch({ type: 'select', selection: { kind: 'node', id } })}
            >
              <td>{id}</td>
              <td>{fmt(v.fx)}</td>
              <td>{fmt(v.fy)}</td>
              <td>{fmt(v.mz)}</td>
            </tr>
          ))}
          <tr className="total">
            <td>Σ</td>
            <td>{fmt(sum.fx)}</td>
            <td>{fmt(sum.fy)}</td>
            <td />
          </tr>
        </tbody>
      </table>

      <h4>Member forces</h4>
      <table className="data">
        <thead>
          <tr>
            <th>Member</th>
            <th title="Axial force, tension positive">N (kN)</th>
            <th title="Largest shear">|V| (kN)</th>
            <th title="Largest bending moment">|M| (kN·m)</th>
            <th title="Largest deflection relative to the member chord">δ (mm)</th>
          </tr>
        </thead>
        <tbody>
          {project.members.map((m) => {
            const v = r.members[m.id];
            if (!v) return null;
            const n =
              Math.abs(v.minAxial.value) > Math.abs(v.maxAxial.value)
                ? v.minAxial.value
                : v.maxAxial.value;
            return (
              <tr
                key={m.id}
                className={sel?.kind === 'member' && sel.id === m.id ? 'selected' : ''}
                onClick={() =>
                  dispatch({ type: 'select', selection: { kind: 'member', id: m.id } })
                }
              >
                <td>{m.id}</td>
                <td className={n < -1e-9 ? 'compression' : n > 1e-9 ? 'tension' : ''}>{fmt(n)}</td>
                <td>{fmt(Math.abs(v.maxAbsShear.value))}</td>
                <td>{fmt(Math.abs(v.maxAbsMoment.value))}</td>
                <td>{mm(Math.abs(v.maxAbsDeflection.value))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h4>Node displacements</h4>
      <table className="data">
        <thead>
          <tr>
            <th>Node</th>
            <th>δx (mm)</th>
            <th>δy (mm)</th>
            <th>θ (mrad)</th>
          </tr>
        </thead>
        <tbody>
          {project.nodes.map((n) => {
            const d = r.displacements[n.id];
            if (!d) return null;
            return (
              <tr
                key={n.id}
                className={sel?.kind === 'node' && sel.id === n.id ? 'selected' : ''}
                onClick={() => dispatch({ type: 'select', selection: { kind: 'node', id: n.id } })}
              >
                <td>{n.id}</td>
                <td>{mm(d.ux)}</td>
                <td>{mm(d.uy)}</td>
                <td>{fmt(d.rz * 1000)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted">
        Sign convention: N tension positive · M sagging positive (drawn on the tension side) ·
        reactions act on the structure.
      </p>
    </>
  );
}
