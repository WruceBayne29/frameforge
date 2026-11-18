import { isPlane } from '../../model3d';
import { fmt } from '../format3d';
import { useStore3D } from '../store';

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
  return (
    <>
      <Modal />
    </>
  );
}
