import { useState } from 'react';
import { isPlane, resultPeaks3D } from '../../model3d';
import type { AnalysisResult3D } from '../../solver3d';
import { equilibriumError, fmt, mm } from '../format3d';
import { isSelected } from '../state';
import type { SelectionKind } from '../state';
import { useStore3D } from '../store';
import { usePage } from './Pager';

type View =
  'summary' | 'displacements' | 'reactions' | 'endForces' | 'extremes' | 'plates' | 'solids';

function useRowProps() {
  const { state, dispatch } = useStore3D();
  return (kind: SelectionKind, id: string) => ({
    className: isSelected(state.selection, kind, id) ? 'selected' : '',
    onClick: (e: React.MouseEvent) =>
      dispatch({ type: 'pick', pick: { kind, id }, additive: e.shiftKey }),
  });
}

/** Which of the six components [x, y, z, rx, ry, rz] a table shows: in plane mode x, y, rz. */
function usePlaneColumns(): (k: number) => boolean {
  const { state } = useStore3D();
  const plane = isPlane(state.project);
  return (k) => !plane || k === 0 || k === 1 || k === 5;
}

function Summary({ r }: { r: AnalysisResult3D }) {
  const show = usePlaneColumns();
  const peaks = resultPeaks3D(r);
  const error = equilibriumError(r);
  const sum = Object.values(r.reactions).reduce(
    (s, v) => [s[0] + v.fx, s[1] + v.fy, s[2] + v.fz],
    [0, 0, 0],
  );
  return (
    <>
      <div className="stat-grid">
        <div>
          <span>Max displacement</span>
          <strong>{mm(r.maxDisplacement)} mm</strong>
        </div>
        <div>
          <span>Equations</span>
          <strong>{r.dofCount}</strong>
        </div>
        {peaks.Mz + peaks.My > 0 && (
          <div>
            <span>Max |Mz| / |My|</span>
            <strong>
              {fmt(peaks.Mz)} / {fmt(peaks.My)}
            </strong>
          </div>
        )}
        {peaks.N > 0 && (
          <div>
            <span>Max |N| (kN)</span>
            <strong>{fmt(peaks.N)}</strong>
          </div>
        )}
        {peaks.plateVonMises > 0 && (
          <div>
            <span>Plate σvm max</span>
            <strong>{fmt(peaks.plateVonMises / 1000)} MPa</strong>
          </div>
        )}
        {peaks.solidVonMises > 0 && (
          <div>
            <span>Solid σvm max</span>
            <strong>{fmt(peaks.solidVonMises / 1000)} MPa</strong>
          </div>
        )}
      </div>
      <h4>Equilibrium check</h4>
      <table className="data" aria-label="Equilibrium">
        <thead>
          <tr>
            <th />
            <th>ΣFx (kN)</th>
            <th>ΣFy (kN)</th>
            {show(2) && <th>ΣFz (kN)</th>}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Applied</td>
            {r.appliedLoad.map((v, k) => show(k) && <td key={k}>{fmt(v)}</td>)}
          </tr>
          <tr>
            <td>Reactions</td>
            {sum.map((v, k) => show(k) && <td key={k}>{fmt(v)}</td>)}
          </tr>
          <tr className="total">
            <td>Residual</td>
            {r.equilibrium.slice(0, 3).map((v, k) => show(k) && <td key={k}>{fmt(v)}</td>)}
          </tr>
        </tbody>
      </table>
      {error < 1e-6 ? (
        <p className="ok-note">
          Loads and reactions balance (relative error {error.toExponential(1)}).
        </p>
      ) : (
        <p className="warning">
          Out of balance by {(error * 100).toPrecision(2)} % of the applied load.
        </p>
      )}
      <h4>Warnings</h4>
      {r.warnings.length === 0 && <p className="muted">None.</p>}
      {r.warnings.map((w) => (
        <p key={w} className="warning">
          {w}
        </p>
      ))}
    </>
  );
}

const DISPLACEMENT_HEADS = ['ux (mm)', 'uy (mm)', 'uz (mm)', 'rx (mrad)', 'ry (mrad)', 'rz (mrad)'];
const REACTION_HEADS = ['Fx (kN)', 'Fy (kN)', 'Fz (kN)', 'Mx', 'My', 'Mz (kN·m)'];
const END_HEADS = ['Fx', 'Fy', 'Fz', 'Mx', 'My', 'Mz'];

function Displacements({ r }: { r: AnalysisResult3D }) {
  const { state } = useStore3D();
  const show = usePlaneColumns();
  const rowProps = useRowProps();
  const { rows, pager } = usePage(state.project.nodes.filter((n) => r.displacements[n.id]));
  return (
    <>
      <div className="table-scroll">
        <table className="data compact" aria-label="Node displacements">
          <thead>
            <tr>
              <th>Node</th>
              {DISPLACEMENT_HEADS.map((h, k) => show(k) && <th key={h}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => {
              const d = r.displacements[n.id];
              return (
                <tr key={n.id} {...rowProps('node', n.id)}>
                  <td>{n.id}</td>
                  {[
                    mm(d.ux),
                    mm(d.uy),
                    mm(d.uz),
                    fmt(d.rx * 1000),
                    fmt(d.ry * 1000),
                    fmt(d.rz * 1000),
                  ].map((text, k) => show(k) && <td key={k}>{text}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pager}
    </>
  );
}

function Reactions({ r }: { r: AnalysisResult3D }) {
  const rowProps = useRowProps();
  const show = usePlaneColumns();
  const plane = !show(2);
  const entries = Object.entries(r.reactions);
  const { rows, pager } = usePage(entries);
  const sum = entries.reduce(
    (s, [, v]) => [s[0] + v.fx, s[1] + v.fy, s[2] + v.fz, s[3] + v.mx, s[4] + v.my, s[5] + v.mz],
    [0, 0, 0, 0, 0, 0],
  );
  return (
    <>
      <div className="table-scroll">
        <table className="data compact" aria-label="Support reactions">
          <thead>
            <tr>
              <th>Node</th>
              {REACTION_HEADS.map((h, k) => show(k) && <th key={h}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, v]) => (
              <tr key={id} {...rowProps('node', id)}>
                <td>{id}</td>
                {[v.fx, v.fy, v.fz, v.mx, v.my, v.mz].map(
                  (value, k) => show(k) && <td key={k}>{fmt(value)}</td>,
                )}
              </tr>
            ))}
            <tr className="total">
              <td>Σ</td>
              {sum.slice(0, 3).map((v, k) => show(k) && <td key={k}>{fmt(v)}</td>)}
              <td colSpan={plane ? 1 : 3} className="muted">
                moments about each node
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {pager}
    </>
  );
}

function EndForces({ r }: { r: AnalysisResult3D }) {
  const { state } = useStore3D();
  const show = usePlaneColumns();
  const rowProps = useRowProps();
  const { rows, pager } = usePage(
    state.project.members.filter((m) => r.members[m.id]),
    50,
  );
  return (
    <>
      <p className="muted">Forces from the joints on the member ends, local axes (kN, kN·m).</p>
      <div className="table-scroll">
        <table className="data compact" aria-label="Member end forces">
          <thead>
            <tr>
              <th>Member</th>
              <th>End</th>
              {END_HEADS.map((h, k) => show(k) && <th key={h}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((m) => {
              const f = r.members[m.id].endForces;
              return [0, 1].map((end) => (
                <tr key={`${m.id}-${end}`} {...rowProps('member', m.id)}>
                  <td>{end === 0 ? m.id : ''}</td>
                  <td>{end === 0 ? m.i : m.j}</td>
                  {f
                    .slice(end * 6, end * 6 + 6)
                    .map((v, k) => show(k) && <td key={k}>{fmt(v)}</td>)}
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
      {pager}
    </>
  );
}

function Extremes({ r }: { r: AnalysisResult3D }) {
  const { state } = useStore3D();
  const full = !isPlane(state.project);
  const rowProps = useRowProps();
  const { rows, pager } = usePage(state.project.members.filter((m) => r.members[m.id]));
  return (
    <>
      <p className="muted">Largest values along each member. N: tension +, compression −.</p>
      <div className="table-scroll">
        <table className="data compact" aria-label="Member extremes">
          <thead>
            <tr>
              <th>Member</th>
              <th>N max</th>
              <th>N min</th>
              <th>|Vy|</th>
              {full && <th>|Vz|</th>}
              {full && <th>|T|</th>}
              {full && <th>|My|</th>}
              <th>|Mz|</th>
              <th>δ (mm)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const v = r.members[m.id];
              return (
                <tr key={m.id} {...rowProps('member', m.id)}>
                  <td>{m.id}</td>
                  <td className={v.maxAxial.value > 1e-9 ? 'tension' : ''}>
                    {fmt(v.maxAxial.value)}
                  </td>
                  <td className={v.minAxial.value < -1e-9 ? 'compression' : ''}>
                    {fmt(v.minAxial.value)}
                  </td>
                  <td>{fmt(Math.abs(v.maxAbsVy.value))}</td>
                  {full && <td>{fmt(Math.abs(v.maxAbsVz.value))}</td>}
                  {full && <td>{fmt(Math.abs(v.maxAbsTorsion.value))}</td>}
                  {full && <td>{fmt(Math.abs(v.maxAbsMy.value))}</td>}
                  <td>{fmt(Math.abs(v.maxAbsMz.value))}</td>
                  <td>{mm(Math.abs(v.maxAbsDeflection.value))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pager}
    </>
  );
}

function PlateStresses({ r }: { r: AnalysisResult3D }) {
  const { state } = useStore3D();
  const rowProps = useRowProps();
  const { rows, pager } = usePage(state.project.plates.filter((p) => r.plates[p.id]));
  return (
    <>
      <p className="muted">Centre values in plate local axes: moments kN·m/m, stresses MPa.</p>
      <div className="table-scroll">
        <table className="data compact" aria-label="Plate stresses">
          <thead>
            <tr>
              <th>Plate</th>
              <th>Mx</th>
              <th>My</th>
              <th>Mxy</th>
              <th>σvm top</th>
              <th>σvm bot</th>
              <th>σvm max</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const v = r.plates[p.id];
              return (
                <tr key={p.id} {...rowProps('plate', p.id)}>
                  <td>{p.id}</td>
                  <td>{fmt(v.center.Mx)}</td>
                  <td>{fmt(v.center.My)}</td>
                  <td>{fmt(v.center.Mxy)}</td>
                  <td>{fmt(v.center.top.vonMises / 1000)}</td>
                  <td>{fmt(v.center.bottom.vonMises / 1000)}</td>
                  <td>{fmt(v.maxVonMises / 1000)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pager}
    </>
  );
}

function SolidStresses({ r }: { r: AnalysisResult3D }) {
  const { state } = useStore3D();
  const rowProps = useRowProps();
  const { rows, pager } = usePage(state.project.solids.filter((s) => r.solids[s.id]));
  return (
    <>
      <p className="muted">Centre stresses in global axes, MPa (tension +).</p>
      <div className="table-scroll">
        <table className="data compact" aria-label="Solid stresses">
          <thead>
            <tr>
              <th>Solid</th>
              <th>σxx</th>
              <th>σyy</th>
              <th>σzz</th>
              <th>S1</th>
              <th>S3</th>
              <th>σvm</th>
              <th>σvm max</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const v = r.solids[s.id];
              const c = v.center;
              return (
                <tr key={s.id} {...rowProps('solid', s.id)}>
                  <td>{s.id}</td>
                  {[c.sxx, c.syy, c.szz, c.s1, c.s3, c.vonMises, v.maxVonMises].map((x, k) => (
                    <td key={k}>{fmt(x / 1000)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pager}
    </>
  );
}

export function Results3D() {
  const { state, solution } = useStore3D();
  const [view, setView] = useState<View>('summary');
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
        <p className="muted">
          {solution.pending
            ? 'Analysing…'
            : 'Build a structure with supports and loads to see results here.'}
        </p>
      </>
    );
  }
  const p = state.project;
  const views: Array<{ id: View; label: string; show: boolean }> = [
    { id: 'summary', label: 'Summary', show: true },
    { id: 'displacements', label: 'Displ.', show: true },
    { id: 'reactions', label: 'Reactions', show: true },
    { id: 'endForces', label: 'End forces', show: p.members.length > 0 },
    { id: 'extremes', label: 'Extremes', show: p.members.length > 0 },
    { id: 'plates', label: 'Plates', show: p.plates.length > 0 },
    { id: 'solids', label: 'Solids', show: p.solids.length > 0 },
  ];
  const shown = views.filter((v) => v.show);
  const current = shown.some((v) => v.id === view) ? view : 'summary';
  return (
    <>
      <h3>Results</h3>
      <div className="segmented wide" role="tablist" aria-label="Result table">
        {shown.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={current === v.id}
            className={current === v.id ? 'active' : ''}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>
      {current === 'summary' && <Summary r={r} />}
      {current === 'displacements' && <Displacements r={r} />}
      {current === 'reactions' && <Reactions r={r} />}
      {current === 'endForces' && <EndForces r={r} />}
      {current === 'extremes' && <Extremes r={r} />}
      {current === 'plates' && <PlateStresses r={r} />}
      {current === 'solids' && <SolidStresses r={r} />}
    </>
  );
}
