import { useState } from 'react';
import type { InfluenceTarget } from '../../solver';
import { NumberField, Row } from '../fields';
import { fmt } from '../format';
import { useStore } from '../store';

type ResponseKind = 'reaction' | 'moment' | 'shear' | 'deflection';

const RESPONSES: Array<{ id: ResponseKind; label: string; unit: string }> = [
  { id: 'reaction', label: 'Vertical reaction at a support', unit: 'kN per kN' },
  { id: 'moment', label: 'Bending moment at a section', unit: 'kN·m per kN' },
  { id: 'shear', label: 'Shear force at a section', unit: 'kN per kN' },
  { id: 'deflection', label: 'Vertical deflection of a node', unit: 'mm per kN' },
];

/** Stretch analyses: natural frequencies with animated mode shapes, and influence lines. */
export function Advanced() {
  const { state, dispatch, solution, extras } = useStore();
  const project = state.project;
  const { advanced } = state;
  const [kind, setKind] = useState<ResponseKind>('moment');
  const [node, setNode] = useState('');
  const [member, setMember] = useState('');
  const [fraction, setFraction] = useState(0.5);

  if (!solution.result) {
    return (
      <>
        <h3>Advanced analysis</h3>
        <p className="muted">These tools need a structure that can be analysed.</p>
      </>
    );
  }

  const supports = project.supports.map((s) => s.node);
  const nodeId =
    kind === 'reaction'
      ? supports.includes(node)
        ? node
        : (supports[0] ?? '')
      : project.nodes.some((n) => n.id === node)
        ? node
        : (project.nodes[0]?.id ?? '');
  const path = extras.influencePath;
  const memberId = project.members.some((m) => m.id === member)
    ? member
    : (project.members.find((m) => m.type === 'frame')?.id ?? project.members[0]?.id ?? '');
  const length = solution.result.members[memberId]?.length ?? 0;

  const show = () => {
    let target: InfluenceTarget;
    if (kind === 'reaction') target = { kind: 'reaction', node: nodeId, component: 'fy' };
    else if (kind === 'deflection')
      target = { kind: 'displacement', node: nodeId, component: 'uy' };
    else {
      target = {
        kind: 'memberForce',
        member: memberId,
        x: Number((length * fraction).toFixed(6)),
        component: kind === 'moment' ? 'M' : 'V',
      };
    }
    dispatch({ type: 'advanced', advanced: { influence: target, mode: null } });
  };

  const line = advanced.influence ? extras.influence : null;
  const shownKind: ResponseKind | null = !advanced.influence
    ? null
    : advanced.influence.kind === 'reaction'
      ? 'reaction'
      : advanced.influence.kind === 'displacement'
        ? 'deflection'
        : advanced.influence.component === 'M'
          ? 'moment'
          : 'shear';
  const factor = shownKind === 'deflection' ? 1000 : 1;
  const unit = RESPONSES.find((r) => r.id === shownKind)?.unit ?? '';

  return (
    <>
      <h3>Advanced analysis</h3>

      <h4>Natural frequencies</h4>
      <p className="muted">
        Modal analysis with consistent mass matrices. The mass is the self-weight of the members
        (steel, 7850 kg/m³ × section area).
      </p>
      {!advanced.modal && (
        <button
          type="button"
          className="primary"
          onClick={() =>
            dispatch({ type: 'advanced', advanced: { modal: true, mode: 0, influence: null } })
          }
        >
          Compute natural frequencies
        </button>
      )}
      {advanced.modal && extras.modalError && <p className="warning">{extras.modalError}</p>}
      {advanced.modal && extras.modal && (
        <>
          <table className="data">
            <thead>
              <tr>
                <th>Mode</th>
                <th>Frequency (Hz)</th>
                <th>Period (s)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {extras.modal.modes.map((m, k) => (
                <tr
                  key={k}
                  className={advanced.mode === k ? 'selected' : ''}
                  onClick={() =>
                    dispatch({
                      type: 'advanced',
                      advanced: { mode: advanced.mode === k ? null : k, influence: null },
                    })
                  }
                >
                  <td>{k + 1}</td>
                  <td>{fmt(m.frequency)}</td>
                  <td>{fmt(m.period, 4)}</td>
                  <td className="muted">{advanced.mode === k ? 'animating' : 'show'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Total mass {fmt(extras.modal.totalMass * 1000, 4)} kg over {extras.modal.dofCount}{' '}
            dynamic degrees of freedom. Click a mode to animate its shape.
          </p>
          <div className="button-row">
            {advanced.mode !== null && (
              <button
                type="button"
                onClick={() => dispatch({ type: 'advanced', advanced: { mode: null } })}
              >
                Stop animation
              </button>
            )}
            <button
              type="button"
              className="ghost"
              onClick={() => dispatch({ type: 'advanced', advanced: { modal: false, mode: null } })}
            >
              Hide
            </button>
          </div>
        </>
      )}

      <h4>Influence lines</h4>
      <p className="muted">
        How one response changes as a 1 kN downward load moves across the structure
        {path.length > 0 ? ` (along ${path.length} member${path.length === 1 ? '' : 's'})` : ''}.
        Useful for placing moving loads in the worst position.
      </p>
      <Row label="Response">
        <select
          aria-label="Response"
          value={kind}
          onChange={(e) => setKind(e.target.value as ResponseKind)}
        >
          {RESPONSES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </Row>
      {(kind === 'reaction' || kind === 'deflection') && (
        <Row label={kind === 'reaction' ? 'Support' : 'Node'}>
          <select aria-label="Node" value={nodeId} onChange={(e) => setNode(e.target.value)}>
            {(kind === 'reaction' ? supports : project.nodes.map((n) => n.id)).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Row>
      )}
      {(kind === 'moment' || kind === 'shear') && (
        <>
          <Row label="Member">
            <select
              aria-label="Member"
              value={memberId}
              onChange={(e) => setMember(e.target.value)}
            >
              {project.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Position (m)" hint="Distance from the start of the member">
            <NumberField
              value={Number((length * fraction).toFixed(3))}
              min={0}
              onCommit={(x) => setFraction(length > 0 ? Math.min(1, x / length) : 0)}
              label="Section position"
            />
          </Row>
        </>
      )}
      <div className="button-row">
        <button type="button" className="primary" onClick={show} disabled={!nodeId && !memberId}>
          Show influence line
        </button>
        {advanced.influence && (
          <button
            type="button"
            onClick={() => dispatch({ type: 'advanced', advanced: { influence: null } })}
          >
            Clear
          </button>
        )}
      </div>
      {advanced.influence && extras.influenceError && (
        <p className="warning">{extras.influenceError}</p>
      )}
      {line && (
        <div className="stat-grid">
          <div>
            <span>
              Largest positive, load on {line.max.member} at {fmt(line.max.x)} m
            </span>
            <strong>{fmt(line.max.value * factor)}</strong>
          </div>
          <div>
            <span>
              Largest negative, load on {line.min.member} at {fmt(line.min.x)} m
            </span>
            <strong>{fmt(line.min.value * factor)}</strong>
          </div>
        </div>
      )}
      {line && <p className="muted">Ordinates in {unit}. Positive ordinates are drawn upward.</p>}
    </>
  );
}
