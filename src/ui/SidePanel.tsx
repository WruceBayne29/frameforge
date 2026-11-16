import { useEffect, useState } from 'react';
import { Design } from './panel/Design';
import { Properties } from './panel/Properties';
import { Results } from './panel/Results';
import { Tables } from './panel/Tables';
import { useStore } from './store';

type Tab = 'properties' | 'tables' | 'results' | 'design';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'properties', label: 'Properties' },
  { id: 'tables', label: 'Tables' },
  { id: 'results', label: 'Results' },
  { id: 'design', label: 'Design' },
];

export function SidePanel() {
  const { state } = useStore();
  const [tab, setTab] = useState<Tab>('properties');
  const [open, setOpen] = useState(true);
  const selectionKey = state.selection ? `${state.selection.kind}:${state.selection.id}` : '';

  // Selecting something on the canvas brings up its properties, unless the user is working in
  // one of the tables (where selection just highlights the row).
  useEffect(() => {
    if (selectionKey)
      setTab((t) => (t === 'tables' || t === 'design' || t === 'results' ? t : 'properties'));
  }, [selectionKey]);

  return (
    <aside
      className={`panel${open ? '' : ' collapsed'}`}
      data-tour="panel"
      aria-label="Model data and results"
    >
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id && open ? 'active' : ''}
            onClick={() => {
              setTab(t.id);
              setOpen(true);
            }}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="ghost panel-toggle"
          title={open ? 'Collapse panel' : 'Expand panel'}
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾' : '▴'}
        </button>
      </div>
      {open && (
        <div className="panel-body" role="tabpanel">
          {tab === 'properties' && <Properties />}
          {tab === 'tables' && <Tables />}
          {tab === 'results' && <Results />}
          {tab === 'design' && <Design />}
        </div>
      )}
    </aside>
  );
}
