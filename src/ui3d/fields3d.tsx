import { SECTIONS } from '../design-codes';
import type { Project3D, Restraints6 } from '../model3d';

export { NumberField, Row, TextField } from '../ui/fields';

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
