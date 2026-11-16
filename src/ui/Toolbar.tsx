import type { ReactNode } from 'react';
import type { SupportKind } from '../model';
import { NumberField, SectionSelect } from './fields';
import { useStore } from './store';
import type { LoadToolKind, Tool } from './store';

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

const TOOLS: Array<{ id: Tool; label: string; key: string; hint: string; icon: ReactNode }> = [
  {
    id: 'select',
    label: 'Select',
    key: 'V',
    hint: 'Select and drag nodes; drag empty space to pan',
    icon: icon(<path d="M5 3l14 8-6 2-2 6z" />),
  },
  {
    id: 'node',
    label: 'Node',
    key: 'N',
    hint: 'Click to add a node (click a member to split it)',
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
    hint: 'Click two points to draw a member; keep clicking to chain',
    icon: icon(
      <>
        <path d="M6 18L18 6" />
        <circle cx="5" cy="19" r="2" />
        <circle cx="19" cy="5" r="2" />
      </>,
    ),
  },
  {
    id: 'support',
    label: 'Support',
    key: 'S',
    hint: 'Click a node to add or remove a support',
    icon: icon(<path d="M12 5l-6 10h12zM4 19h16" />),
  },
  {
    id: 'load',
    label: 'Load',
    key: 'L',
    hint: 'Click a node or member to apply a load',
    icon: icon(<path d="M12 3v15M7 13l5 5 5-5M4 21h16" />),
  },
  {
    id: 'delete',
    label: 'Delete',
    key: 'X',
    hint: 'Click a node or member to delete it',
    icon: icon(<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6" />),
  },
];

const SUPPORTS: Array<{ id: SupportKind; label: string }> = [
  { id: 'fixed', label: 'Fixed' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'rollerX', label: 'Roller (rolls in X)' },
  { id: 'rollerY', label: 'Roller (rolls in Y)' },
];

const LOADS: Array<{ id: LoadToolKind; label: string; unit: string }> = [
  { id: 'nodal', label: 'Point load on a node', unit: 'kN' },
  { id: 'udl', label: 'UDL on a member', unit: 'kN/m' },
  { id: 'point', label: 'Point load on a member', unit: 'kN' },
];

export function Toolbar() {
  const { state, dispatch } = useStore();
  const { tool, toolOptions: o } = state;
  const set = (options: Partial<typeof o>) => dispatch({ type: 'toolOptions', options });
  const current = TOOLS.find((t) => t.id === tool);
  const loadUnit = LOADS.find((l) => l.id === o.loadKind)?.unit ?? 'kN';

  return (
    <aside className="toolbar" data-tour="toolbar" aria-label="Drawing tools">
      <div className="tool-buttons">
        {TOOLS.map((t) => (
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

        {tool === 'member' && (
          <>
            <label>
              Type
              <select
                value={o.memberType}
                onChange={(e) => set({ memberType: e.target.value as 'frame' | 'truss' })}
              >
                <option value="frame">Frame (rigid ends)</option>
                <option value="truss">Truss (pin ends)</option>
              </select>
            </label>
            <label>
              Section
              <SectionSelect
                project={state.project}
                value={o.section}
                onChange={(section) => set({ section })}
              />
            </label>
          </>
        )}

        {tool === 'support' && (
          <label>
            Support type
            <select
              value={o.supportKind}
              onChange={(e) => set({ supportKind: e.target.value as SupportKind })}
            >
              {SUPPORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {tool === 'load' && (
          <>
            <label>
              Load type
              <select
                value={o.loadKind}
                onChange={(e) => set({ loadKind: e.target.value as LoadToolKind })}
              >
                {LOADS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Magnitude, downward ({loadUnit})
              <NumberField
                value={o.loadValue}
                onCommit={(loadValue) => set({ loadValue })}
                label="Load magnitude"
              />
            </label>
          </>
        )}

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
          <select value={o.grid} onChange={(e) => set({ grid: Number(e.target.value) })}>
            {[0.1, 0.25, 0.5, 1, 2].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
      </div>
    </aside>
  );
}
