import { useState } from 'react';
import { Advanced } from './panel/Advanced';
import { Design } from './panel/Design';
import { Properties } from './panel/Properties';
import { Results } from './panel/Results';
import { Tables } from './panel/Tables';

type Tab = 'properties' | 'tables' | 'results' | 'design' | 'advanced';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'properties', label: 'Properties' },
  { id: 'tables', label: 'Tables' },
  { id: 'results', label: 'Results' },
  { id: 'design', label: 'Design' },
  { id: 'advanced', label: 'Advanced' },
];

export function SidePanel() {
  const [tab, setTab] = useState<Tab>('properties');
  const [open, setOpen] = useState(true);
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
          {tab === 'advanced' && <Advanced />}
        </div>
      )}
    </aside>
  );
}
