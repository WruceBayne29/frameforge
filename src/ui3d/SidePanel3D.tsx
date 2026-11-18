import { useState } from 'react';
import { Advanced3D } from './panel/Advanced3D';
import { Design3D } from './panel/Design3D';
import { Generate3D } from './panel/Generate3D';
import { Properties3D } from './panel/Properties3D';
import { Results3D } from './panel/Results3D';
import { Tables3D } from './panel/Tables3D';

type Tab = 'properties' | 'tables' | 'generate' | 'results' | 'design' | 'advanced';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'properties', label: 'Properties' },
  { id: 'tables', label: 'Tables' },
  { id: 'generate', label: 'Generate' },
  { id: 'results', label: 'Results' },
  { id: 'design', label: 'Design' },
  { id: 'advanced', label: 'Advanced' },
];

export function SidePanel3D() {
  const [tab, setTab] = useState<Tab>('properties');
  const [open, setOpen] = useState(true);
  return (
    <aside className={`panel${open ? '' : ' collapsed'}`} aria-label="Model data and results">
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
          {tab === 'properties' && <Properties3D />}
          {tab === 'tables' && <Tables3D />}
          {tab === 'generate' && <Generate3D />}
          {tab === 'results' && <Results3D />}
          {tab === 'design' && <Design3D />}
          {tab === 'advanced' && <Advanced3D />}
        </div>
      )}
    </aside>
  );
}
