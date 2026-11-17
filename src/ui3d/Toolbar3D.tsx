import { useState } from 'react';
import type { ReactNode } from 'react';
import { addNode } from '../model3d';
import type { GlobalDirection, SolidFace } from '../model3d';
import { NumberField, RestraintBoxes, SectionSelect3D } from './fields3d';
import { LOAD_TOOL_TARGET, LOAD_TOOL_UNIT, applySupport, applyToolLoad } from './state';
import type { LoadToolKind, SupportPreset, Tool3D } from './state';
import { useStore3D } from './store';
import { notify } from '../ui/toast';

const icon = (path: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

export const TOOLS_3D: Array<{
  id: Tool3D;
  label: string;
  key: string;
  hint: string;
  icon: ReactNode;
}> = [
  {
    id: 'select',
    label: 'Select',
    key: 'V',
    hint: 'Click to select, Shift+click to add; drag to orbit, right-drag to pan',
    icon: icon(<path d="M5 3l14 8-6 2-2 6z" />),
  },
  {
    id: 'node',
    label: 'Node',
    key: 'N',
    hint: 'Type coordinates, or click the grid at the working elevation',
    icon: icon(
      <>
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      </>,
    ),
  },
  {
    id: 'member',
    label: 'Member',
    key: 'M',
    hint: 'Click two nodes (or grid points); keep clicking to chain',
    icon: icon(
      <>
        <path d="M6 18L18 6" />
        <circle cx="5" cy="19" r="2" />
        <circle cx="19" cy="5" r="2" />
      </>,
    ),
  },
  {
    id: 'plate',
    label: 'Plate',
    key: 'P',
    hint: 'Click four corner nodes in order around the plate',
    icon: icon(<path d="M4 16l6-9h10l-6 9z" />),
  },
  {
    id: 'support',
    label: 'Support',
    key: 'S',
    hint: 'Click a node, or apply to the selected nodes',
    icon: icon(<path d="M12 5l-6 10h12zM4 19h16" />),
  },
  {
    id: 'load',
    label: 'Load',
    key: 'L',
    hint: 'Click an element, or apply to the selection',
    icon: icon(<path d="M12 3v15M7 13l5 5 5-5M4 21h16" />),
  },
  {
    id: 'delete',
    label: 'Delete',
    key: 'X',
    hint: 'Click anything to delete it',
    icon: icon(<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6" />),
  },
];

const LOAD_KINDS: Array<{ id: LoadToolKind; label: string }> = [
  { id: 'nodal', label: 'Force on a node' },
  { id: 'distributed', label: 'UDL on a member' },
  { id: 'point', label: 'Point load at mid-member' },
  { id: 'pressure', label: 'Pressure on a plate' },
  { id: 'face', label: 'Pressure on a solid face' },
];

/** Adds a node at typed coordinates. */
function NodeInput() {
  const { state, dispatch } = useStore3D();
  const [xyz, setXyz] = useState<[number, number, number]>([0, state.toolOptions.elevation, 0]);
  const add = () => {
    const r = addNode(state.project, xyz[0], xyz[1], xyz[2]);
    if (r.project === state.project) notify(`Node ${r.id} is already there.`);
    dispatch({ type: 'edit', project: r.project, selection: { kind: 'node', ids: [r.id] } });
  };
  return (
    <>
      <div className="coord-row">
        {(['X', 'Y', 'Z'] as const).map((axis, k) => (
          <NumberField
            key={axis}
            value={xyz[k]}
            label={`New node ${axis} (m)`}
            placeholder={axis}
            onCommit={(v) =>
              setXyz((old) => old.map((o, i) => (i === k ? v : o)) as [number, number, number])
            }
          />
        ))}
      </div>
      <button type="button" className="primary" onClick={add}>
        Add node
      </button>
    </>
  );
}

export function Toolbar3D() {
  const { state, dispatch } = useStore3D();
  const { tool, toolOptions: o, project, selection } = state;
  const set = (options: Partial<typeof o>) => dispatch({ type: 'toolOptions', options });
  const current = TOOLS_3D.find((t) => t.id === tool);
  const target = LOAD_TOOL_TARGET[o.loadKind];
  const plane = tool === 'node' || tool === 'member' || tool === 'plate';

  const applySupportToSelection = () => {
    if (selection?.kind !== 'node') return;
    dispatch({ type: 'edit', project: applySupport(project, selection.ids, o) });
  };
  const applyLoadToSelection = () => {
    if (!selection) return;
    const r = applyToolLoad(project, o, selection.kind, selection.ids);
    if (r) dispatch({ type: 'edit', project: r.project, selection: { kind: 'load', ids: [r.id] } });
  };

  return (
    <aside className="toolbar" aria-label="Modelling tools">
      <div className="tool-buttons">
        {TOOLS_3D.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tool${tool === t.id ? ' active' : ''}`}
            title={`${t.label} (${t.key}) — ${t.hint}`}
            aria-pressed={tool === t.id}
            onClick={() => dispatch({ type: 'tool', tool: t.id })}
          >
            {t.icon}
            <span>{t.label}</span>
            <kbd>{t.key}</kbd>
          </button>
        ))}
      </div>

      <div className="tool-options">
        {current && <p className="tool-hint">{current.hint}.</p>}

        {tool === 'node' && <NodeInput />}

        {tool === 'member' && (
          <>
            <label>
              Type
              <select
                value={o.memberType}
                aria-label="Member type"
                onChange={(e) => set({ memberType: e.target.value as 'beam' | 'truss' })}
              >
                <option value="beam">Beam (rigid ends)</option>
                <option value="truss">Truss (axial only)</option>
              </select>
            </label>
            <label>
              Section
              <SectionSelect3D
                project={project}
                value={o.section}
                onChange={(section) => set({ section })}
              />
            </label>
          </>
        )}

        {tool === 'plate' && (
          <label>
            Thickness (mm)
            <NumberField
              value={o.thickness}
              min={1}
              label="Plate thickness (mm)"
              onCommit={(thickness) => set({ thickness })}
            />
          </label>
        )}

        {(tool === 'member' || tool === 'plate') && state.pending.length > 0 && (
          <span className="pending-chip">Picked: {state.pending.join(', ')}</span>
        )}

        {tool === 'support' && (
          <>
            <label>
              Support
              <select
                value={o.supportPreset}
                aria-label="Support type"
                onChange={(e) => set({ supportPreset: e.target.value as SupportPreset })}
              >
                <option value="fixed">Fixed (all six)</option>
                <option value="pinned">Pinned (ux uy uz)</option>
                <option value="roller">Roller (uy only)</option>
                <option value="custom">Custom…</option>
                <option value="none">Remove support</option>
              </select>
            </label>
            {o.supportPreset === 'custom' && (
              <RestraintBoxes
                value={o.restraints}
                onChange={(restraints) => set({ restraints })}
                idPrefix="tool"
              />
            )}
            <button
              type="button"
              disabled={selection?.kind !== 'node'}
              title="Apply to every selected node"
              onClick={applySupportToSelection}
            >
              Apply to selected nodes
            </button>
          </>
        )}

        {tool === 'load' && (
          <>
            <label>
              Load type
              <select
                value={o.loadKind}
                aria-label="Load type"
                onChange={(e) => set({ loadKind: e.target.value as LoadToolKind })}
              >
                {LOAD_KINDS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            {o.loadKind === 'face' && (
              <label>
                Face
                <select
                  value={o.loadFace}
                  aria-label="Solid face"
                  onChange={(e) => set({ loadFace: Number(e.target.value) as SolidFace })}
                >
                  {[1, 2, 3, 4, 5, 6].map((f) => (
                    <option key={f} value={f}>
                      Face {f}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Direction
              <select
                value={o.loadDirection}
                aria-label="Load direction"
                onChange={(e) => set({ loadDirection: e.target.value as GlobalDirection })}
              >
                <option value="globalY">Global Y (vertical)</option>
                <option value="globalX">Global X</option>
                <option value="globalZ">Global Z</option>
              </select>
            </label>
            <label>
              Value ({LOAD_TOOL_UNIT[o.loadKind]}, + along axis)
              <NumberField
                value={o.loadValue}
                label="Load value"
                onCommit={(loadValue) => set({ loadValue })}
              />
            </label>
            <button
              type="button"
              disabled={selection?.kind !== target}
              title={`Apply to every selected ${target}`}
              onClick={applyLoadToSelection}
            >
              Apply to selected {target}s
            </button>
          </>
        )}

        {plane && (
          <>
            <label>
              Working elevation Y (m)
              <NumberField
                value={o.elevation}
                label="Working elevation (m)"
                onCommit={(elevation) => set({ elevation })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={o.snap}
                onChange={(e) => set({ snap: e.target.checked })}
              />
              Snap to grid (G)
            </label>
            <label>
              Grid spacing (m)
              <select
                value={o.grid}
                aria-label="Grid spacing"
                onChange={(e) => set({ grid: Number(e.target.value) })}
              >
                {[0.1, 0.25, 0.5, 1, 2, 5].map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {tool === 'select' && (
          <p className="tool-hint">
            Edit the selection in Properties; generators, materials and sections are under Generate.
          </p>
        )}
      </div>
    </aside>
  );
}
