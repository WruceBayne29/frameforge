import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { SECTIONS } from '../design-codes';
import type { Project3D, Restraints6 } from '../model3d';

/** Dropdown of the rolled sections and the project's custom sections. */
export function SectionSelect3D({
  project,
  value,
  onChange,
  label = 'Section',
}: {
  project: Project3D;
  value: string | undefined;
  onChange: (section: string) => void;
  label?: string;
}) {
  const known =
    value === undefined ||
    SECTIONS.some((s) => s.designation === value) ||
    project.customSections.some((s) => s.name === value);
  return (
    <select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {value === undefined && (
        <option value="" disabled>
          (mixed)
        </option>
      )}
      {!known && <option value={value}>{value} (missing)</option>}
      {project.customSections.length > 0 && (
        <optgroup label="Custom">
          {project.customSections.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="ISMB — beams">
        {SECTIONS.filter((s) => s.family === 'ISMB').map((s) => (
          <option key={s.designation} value={s.designation}>
            {s.designation}
          </option>
        ))}
      </optgroup>
      <optgroup label="ISMC — channels">
        {SECTIONS.filter((s) => s.family === 'ISMC').map((s) => (
          <option key={s.designation} value={s.designation}>
            {s.designation}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

export function MaterialSelect({
  project,
  value,
  onChange,
  label = 'Material',
}: {
  project: Project3D;
  value: string | undefined;
  onChange: (material: string) => void;
  label?: string;
}) {
  const known = value === undefined || project.materials.some((m) => m.name === value);
  return (
    <select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {value === undefined && (
        <option value="" disabled>
          (mixed)
        </option>
      )}
      {!known && <option value={value}>{value} (missing)</option>}
      {project.materials.map((m) => (
        <option key={m.name} value={m.name}>
          {m.name}
        </option>
      ))}
    </select>
  );
}

const DOFS = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] as const;
const DOF_TITLES = [
  'Translation along X',
  'Translation along Y (vertical)',
  'Translation along Z',
  'Rotation about X',
  'Rotation about Y',
  'Rotation about Z',
];

/** Six checkboxes for the restrained degrees of freedom. */
export function RestraintBoxes({
  value,
  onChange,
  idPrefix = 'dof',
}: {
  value: Restraints6;
  onChange: (value: Restraints6) => void;
  idPrefix?: string;
}) {
  return (
    <div className="dof-grid" role="group" aria-label="Restrained degrees of freedom">
      {DOFS.map((dof, k) => (
        <label key={dof} title={DOF_TITLES[k]}>
          <input
            type="checkbox"
            name={`${idPrefix}-${dof}`}
            aria-label={`Restrain ${dof}`}
            checked={value[k]}
            onChange={(e) => {
              const next = [...value] as Restraints6;
              next[k] = e.target.checked;
              onChange(next);
            }}
          />
          {dof}
        </label>
      ))}
    </div>
  );
}

/**
 * Numeric input that keeps its own text while typing and commits on blur or Enter, so a
 * half-typed value ("-", "1.") never reaches the model and each edit is one undo step.
 */
export function NumberField({
  value,
  onCommit,
  label,
  step,
  min,
  width,
  disabled,
  placeholder,
}: {
  value: number | undefined;
  onCommit: (value: number) => void;
  label?: string;
  step?: number;
  min?: number;
  width?: number;
  disabled?: boolean;
  placeholder?: string;
}) {
  const shown = value === undefined ? '' : String(Number(value.toFixed(6)));
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const parsed = Number(text);
    if (text.trim() === '' || !Number.isFinite(parsed) || (min !== undefined && parsed < min)) {
      setText(shown);
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={label}
      title={label}
      step={step ?? 'any'}
      min={min}
      disabled={disabled}
      placeholder={placeholder}
      style={width ? { width } : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(shown);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function TextField({
  value,
  onCommit,
  label,
  width,
}: {
  value: string;
  onCommit: (value: string) => void;
  label?: string;
  width?: number;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      type="text"
      aria-label={label}
      style={width ? { width } : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() && text !== value) onCommit(text.trim());
        else setText(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field-row">
      <span className="field-label" title={hint}>
        {label}
      </span>
      <span className="field-control">{children}</span>
    </div>
  );
}
