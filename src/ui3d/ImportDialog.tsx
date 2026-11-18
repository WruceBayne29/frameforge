import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PlaneOption,
  StaadLoadCase,
  ForceUnit,
  ImportResult,
  LengthUnit,
  StaadImportResult,
  TableName,
  TableTexts,
} from '../import';
import {
  detectFormat,
  importModelText,
  importTables,
  issueText,
  TABLE_COLUMNS,
  TABLE_LABELS,
  TABLE_NAMES,
} from '../import';
import type { Project3D } from '../model3d';

/** A small portal frame, to show what each table looks like. */
export const EXAMPLE_TABLES: Required<TableTexts> = {
  nodes: 'id,x,y,z\n1,0,0,0\n2,0,4,0\n3,6,4,0\n4,6,0,0',
  members: 'id,i,j,section,type\nC1,1,2,ISMB 300,beam\nB1,2,3,ISMB 400,beam\nC2,3,4,ISMB 300,beam',
  supports: 'node,type\n1,fixed\n4,fixed',
  nodalLoads: 'node,fx,fy\n2,10,0',
  memberLoads: 'member,type,direction,w1\nB1,udl,GY,-20',
  sections: 'name,A_cm2,Iz_cm4,Iy_cm4,J_cm4',
  materials: 'name,E_GPa,nu,density',
};

const EMPTY_TABLES: TableTexts = {};

export interface ImportSource {
  text: string;
  filename: string;
}

type Mode = 'tables' | 'file';
type PlaneChoice = 'auto' | 'on' | 'off';

function readFile(file: File): Promise<string> {
  return file.text();
}

/** Counts the data rows of a table (non-blank, non-comment lines after the header). */
function rowCount(text: string | undefined): number {
  if (!text) return 0;
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() && !/^\s*(#|\/\/)/.test(l));
  return Math.max(0, lines.length - 1);
}

export function ImportDialog({
  initial,
  onImport,
  onClose,
}: {
  initial?: ImportSource | null;
  onImport: (project: Project3D, result: ImportResult) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>(initial ? 'file' : 'tables');
  const [tables, setTables] = useState<TableTexts>(EMPTY_TABLES);
  const [table, setTable] = useState<TableName>('nodes');
  const [source, setSource] = useState<ImportSource>(initial ?? { text: '', filename: '' });
  const [length, setLength] = useState<LengthUnit | 'file'>('m');
  const [force, setForce] = useState<ForceUnit | 'file'>('kN');
  const [plane, setPlane] = useState<PlaneChoice>('auto');
  const [loadCase, setLoadCase] = useState<number | undefined>(undefined);
  const [name, setName] = useState('');
  const tableFile = useRef<HTMLInputElement>(null);
  const modelFile = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const format = mode === 'file' ? detectFormat(source.text, source.filename) : 'csv';
  const result: ImportResult | StaadImportResult | null = useMemo(() => {
    const planeOption: PlaneOption | undefined =
      plane === 'on' ? 'XY' : plane === 'off' ? 'none' : undefined;
    const options = { name: name.trim() || undefined, plane: planeOption };
    if (mode === 'tables') {
      if (!Object.values(tables).some((t) => t?.trim())) return null;
      return importTables(tables, {
        ...options,
        units: { length: length === 'file' ? 'm' : length, force: force === 'file' ? 'kN' : force },
      });
    }
    if (!source.text.trim()) return null;
    const units: { length?: LengthUnit; force?: ForceUnit } = {};
    if (length !== 'file') units.length = length;
    if (force !== 'file') units.force = force;
    return importModelText(source.text, {
      ...options,
      filename: source.filename,
      units,
      loadCase,
    });
  }, [mode, tables, source, length, force, plane, loadCase, name]);

  const cases: StaadLoadCase[] = (result as StaadImportResult | null)?.loadCases ?? [];
  const project = result?.project ?? null;
  const counts = project
    ? [
        [project.nodes.length, 'nodes'],
        [project.members.length, 'members'],
        [project.plates.length, 'plates'],
        [project.solids.length, 'solids'],
        [project.supports.length, 'supports'],
        [project.loads.length, 'loads'],
      ].filter(([n, noun]) => n !== 0 || noun === 'nodes' || noun === 'members')
    : [];

  const switchMode = (next: Mode) => {
    setMode(next);
    // Tables have no units of their own; files may carry them ([settings] of a CSV bundle).
    if (next === 'tables') {
      if (length === 'file') setLength('m');
      if (force === 'file') setForce('kN');
    } else {
      setLength('file');
      setForce('file');
    }
  };

  const loadModelFile = async (file: File) => {
    setSource({ text: await readFile(file), filename: file.name });
    setLoadCase(undefined);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import a model"
        data-testid="import-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Import a model</h2>
        <p className="muted">
          Bring in nodes and members from a spreadsheet or another program. Paste tables (CSV, tab
          or semicolon separated — straight from Excel works), or open a STAAD.Pro .std file, a CSV
          bundle or a FrameForge .json. The import becomes a new model; Undo returns to the current
          one.
        </p>
        <div className="segmented" role="tablist" aria-label="Import from">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'tables'}
            className={mode === 'tables' ? 'active' : ''}
            onClick={() => switchMode('tables')}
          >
            Tables (CSV)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'file'}
            className={mode === 'file' ? 'active' : ''}
            onClick={() => switchMode('file')}
          >
            STAAD / file
          </button>
        </div>

        {mode === 'tables' ? (
          <>
            <div className="import-tabs" role="tablist" aria-label="Table">
              {TABLE_NAMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={table === t}
                  className={table === t ? 'active' : ''}
                  onClick={() => setTable(t)}
                >
                  {TABLE_LABELS[t]}
                  {rowCount(tables[t]) > 0 && <span className="count">{rowCount(tables[t])}</span>}
                </button>
              ))}
            </div>
            <textarea
              className="import-text"
              aria-label={`${TABLE_LABELS[table]} table`}
              spellCheck={false}
              value={tables[table] ?? ''}
              placeholder={`${TABLE_COLUMNS[table].join(',')}\n…`}
              onChange={(e) => setTables({ ...tables, [table]: e.target.value })}
            />
            <div className="button-row">
              <button type="button" className="ghost" onClick={() => tableFile.current?.click()}>
                Load {TABLE_LABELS[table].toLowerCase()} file…
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setTables({ ...EXAMPLE_TABLES })}
              >
                Fill with example
              </button>
              <button
                type="button"
                className="ghost"
                disabled={!Object.values(tables).some((t) => t?.trim())}
                onClick={() => setTables(EMPTY_TABLES)}
              >
                Clear
              </button>
              <span className="muted small">Columns: {TABLE_COLUMNS[table].join(', ')}</span>
            </div>
            <input
              ref={tableFile}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              hidden
              aria-label="Table file"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) setTables({ ...tables, [table]: await readFile(file) });
              }}
            />
          </>
        ) : (
          <>
            <textarea
              className="import-text"
              aria-label="Model text"
              spellCheck={false}
              value={source.text}
              placeholder={'STAAD SPACE\nUNIT METER KN\nJOINT COORDINATES\n1 0 0 0; 2 5 0 0\n…'}
              onChange={(e) => setSource({ text: e.target.value, filename: source.filename })}
            />
            <div className="button-row">
              <button type="button" className="ghost" onClick={() => modelFile.current?.click()}>
                Choose file…
              </button>
              <span className="muted small">
                {source.filename && `${source.filename} · `}
                {format === 'std'
                  ? 'STAAD.Pro input'
                  : format === 'csv'
                    ? 'CSV bundle'
                    : format === 'json'
                      ? 'JSON model'
                      : source.text.trim()
                        ? 'Format not recognised'
                        : '.std, .csv bundle or .json'}
              </span>
            </div>
            <input
              ref={modelFile}
              type="file"
              accept=".std,.json,.csv,.txt,application/json,text/plain"
              hidden
              aria-label="Model file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void loadModelFile(file);
              }}
            />
          </>
        )}

        <div className="import-options">
          <label>
            Length
            <select
              aria-label="Length unit"
              value={length}
              onChange={(e) => setLength(e.target.value as LengthUnit | 'file')}
            >
              {mode === 'file' && <option value="file">from file</option>}
              <option value="m">m</option>
              <option value="mm">mm</option>
            </select>
          </label>
          <label>
            Force
            <select
              aria-label="Force unit"
              value={force}
              onChange={(e) => setForce(e.target.value as ForceUnit | 'file')}
            >
              {mode === 'file' && <option value="file">from file</option>}
              <option value="kN">kN</option>
              <option value="N">N</option>
            </select>
          </label>
          <label>
            Model
            <select
              aria-label="Plane frame"
              value={plane}
              onChange={(e) => setPlane(e.target.value as PlaneChoice)}
            >
              <option value="auto">automatic</option>
              <option value="on">plane frame (XY)</option>
              <option value="off">3D</option>
            </select>
          </label>
          {cases.length > 1 && (
            <label>
              Load case
              <select
                aria-label="Load case"
                value={loadCase ?? cases[0].number}
                onChange={(e) => setLoadCase(Number(e.target.value))}
              >
                {cases.map((c) => (
                  <option key={c.number} value={c.number}>
                    {c.number}
                    {c.title ? ` — ${c.title}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="grow">
            Name
            <input
              type="text"
              aria-label="Model name"
              value={name}
              placeholder={project?.name ?? 'Imported model'}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        {mode === 'file' && (
          <p className="muted small">
            Units apply to CSV bundles; STAAD files carry their own UNIT commands and JSON models
            are in kN and m.
          </p>
        )}

        <div className="import-preview" aria-live="polite" data-testid="import-preview">
          {!result && <span className="muted">Paste or load data to see a preview.</span>}
          {project && (
            <div className="import-summary">
              <strong>Ready:</strong> {counts.map(([n, noun]) => `${n} ${noun}`).join(' · ')}
              {project.plane === 'XY' ? ' · plane frame' : ' · 3D'}
              {project.selfWeight ? ' · self-weight' : ''}
              {result?.planeSuggested && project.plane !== 'XY' && (
                <span className="muted"> (every node has z = 0: a plane frame is possible)</span>
              )}
            </div>
          )}
          {result && result.errors.length > 0 && (
            <ul className="import-issues errors">
              {result.errors.slice(0, 50).map((issue, k) => (
                <li key={k}>{issueText(issue)}</li>
              ))}
              {result.errors.length > 50 && <li>… and {result.errors.length - 50} more</li>}
            </ul>
          )}
          {result && result.warnings.length > 0 && (
            <ul className="import-issues warnings">
              {result.warnings.slice(0, 50).map((issue, k) => (
                <li key={k}>{issueText(issue)}</li>
              ))}
              {result.warnings.length > 50 && <li>… and {result.warnings.length - 50} more</li>}
            </ul>
          )}
        </div>

        <div className="button-row end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!project}
            onClick={() => project && result && onImport(project, result)}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
