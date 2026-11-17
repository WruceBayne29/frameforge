import { useState } from 'react';
import { gridFrame, plateMesh, solidBlock } from '../../model3d';
import type { Generated, Point3, Project3D } from '../../model3d';
import { notify } from '../../ui/toast';
import {
  addCustomSection,
  addMaterial,
  deleteCustomSection,
  deleteMaterial,
  materialInUse,
  updateCustomSection,
  updateMaterial,
} from '../edits';
import { MaterialSelect, NumberField, SectionSelect3D, TextField } from '../fields3d';
import { countText } from '../format3d';
import { useStore3D } from '../store';
import type { Selection3D } from '../store';

function Num({
  label,
  value,
  onChange,
  min,
  integer,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  integer?: boolean;
}) {
  return (
    <label>
      {label}
      <NumberField
        value={value}
        min={min}
        label={label}
        step={integer ? 1 : undefined}
        onCommit={(v) => onChange(integer ? Math.round(v) : v)}
      />
    </label>
  );
}

/** Runs a generator, reporting bad input instead of throwing. */
function useGenerate() {
  const { state, dispatch } = useStore3D();
  return (what: string, run: (project: Project3D) => Generated) => {
    try {
      const made = run(state.project);
      const selection: Selection3D | null =
        made.solids.length > 0
          ? { kind: 'solid', ids: made.solids }
          : made.plates.length > 0
            ? { kind: 'plate', ids: made.plates }
            : made.members.length > 0
              ? { kind: 'member', ids: made.members }
              : null;
      dispatch({ type: 'edit', project: made.project, selection });
      dispatch({ type: 'camera', preset: 'fit' });
      const parts = [
        made.members.length > 0 && countText(made.members.length, 'member'),
        made.plates.length > 0 && countText(made.plates.length, 'plate'),
        made.solids.length > 0 && countText(made.solids.length, 'solid'),
      ].filter(Boolean);
      notify(`${what}: added ${parts.join(', ') || 'nothing new'}.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not generate that.', 'error');
    }
  };
}

function FrameForm() {
  const { state } = useStore3D();
  const generate = useGenerate();
  const [o, setO] = useState({
    baysX: 2,
    baysZ: 1,
    storeys: 2,
    bayWidthX: 6,
    bayWidthZ: 5,
    storeyHeight: 3.5,
    columnSection: 'ISMB 400',
    beamSection: 'ISMB 300',
    material: state.project.materials[0]?.name ?? 'Steel',
    fixedBases: true,
  });
  const set = (patch: Partial<typeof o>) => setO((old) => ({ ...old, ...patch }));
  return (
    <section className="gen-card" aria-label="Building frame generator">
      <h4>Building frame</h4>
      <div className="form-grid">
        <Num label="Bays X" value={o.baysX} min={1} integer onChange={(baysX) => set({ baysX })} />
        <Num label="Bays Z" value={o.baysZ} min={0} integer onChange={(baysZ) => set({ baysZ })} />
        <Num
          label="Storeys"
          value={o.storeys}
          min={1}
          integer
          onChange={(storeys) => set({ storeys })}
        />
        <Num label="Bay X (m)" value={o.bayWidthX} onChange={(bayWidthX) => set({ bayWidthX })} />
        <Num label="Bay Z (m)" value={o.bayWidthZ} onChange={(bayWidthZ) => set({ bayWidthZ })} />
        <Num
          label="Storey (m)"
          value={o.storeyHeight}
          onChange={(storeyHeight) => set({ storeyHeight })}
        />
        <label className="span-all">
          Columns
          <SectionSelect3D
            project={state.project}
            value={o.columnSection}
            label="Column section"
            onChange={(columnSection) => set({ columnSection })}
          />
        </label>
        <label className="span-all">
          Beams
          <SectionSelect3D
            project={state.project}
            value={o.beamSection}
            label="Beam section"
            onChange={(beamSection) => set({ beamSection })}
          />
        </label>
        <label className="span-all">
          Material
          <MaterialSelect
            project={state.project}
            value={o.material}
            onChange={(material) => set({ material })}
          />
        </label>
        <label className="check span-all">
          <input
            type="checkbox"
            checked={o.fixedBases}
            onChange={(e) => set({ fixedBases: e.target.checked })}
          />
          Fixed column bases (else pinned)
        </label>
      </div>
      <button
        type="button"
        className="primary"
        onClick={() => generate('Frame', (p) => gridFrame(p, o))}
      >
        Generate frame
      </button>
    </section>
  );
}

function PointFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Point3;
  onChange: (p: Point3) => void;
}) {
  return (
    <>
      {(['X', 'Y', 'Z'] as const).map((axis, k) => (
        <Num
          key={axis}
          label={`${label} ${axis}`}
          value={value[k]}
          onChange={(v) => onChange(value.map((old, i) => (i === k ? v : old)) as Point3)}
        />
      ))}
    </>
  );
}

function PlateMeshForm() {
  const { state } = useStore3D();
  const generate = useGenerate();
  const [corners, setCorners] = useState<[Point3, Point3, Point3, Point3]>([
    [0, 3.5, 0],
    [6, 3.5, 0],
    [6, 3.5, 5],
    [0, 3.5, 5],
  ]);
  const [o, setO] = useState({
    nx: 6,
    ny: 5,
    thickness: 150,
    material: state.project.materials.at(-1)?.name ?? 'Steel',
  });
  const set = (patch: Partial<typeof o>) => setO((old) => ({ ...old, ...patch }));
  return (
    <section className="gen-card" aria-label="Plate mesh generator">
      <h4>Plate mesh</h4>
      <p className="muted">
        Four corners in order around the region; the mesh joins existing nodes it meets.
      </p>
      <div className="form-grid">
        {corners.map((c, k) => (
          <PointFields
            key={k}
            label={`C${k + 1}`}
            value={c}
            onChange={(p) =>
              setCorners((old) => old.map((x, i) => (i === k ? p : x)) as typeof corners)
            }
          />
        ))}
        <Num label="Divisions 1→2" value={o.nx} min={1} integer onChange={(nx) => set({ nx })} />
        <Num label="Divisions 1→4" value={o.ny} min={1} integer onChange={(ny) => set({ ny })} />
        <Num
          label="t (mm)"
          value={o.thickness}
          min={1}
          onChange={(thickness) => set({ thickness })}
        />
        <label className="span-all">
          Material
          <MaterialSelect
            project={state.project}
            value={o.material}
            onChange={(material) => set({ material })}
          />
        </label>
      </div>
      <button
        type="button"
        className="primary"
        onClick={() => generate('Plate mesh', (p) => plateMesh(p, { corners, ...o }))}
      >
        Generate plates
      </button>
    </section>
  );
}

function SolidBlockForm() {
  const { state } = useStore3D();
  const generate = useGenerate();
  const [origin, setOrigin] = useState<Point3>([0, 0, 0]);
  const [size, setSize] = useState<Point3>([2, 1, 1]);
  const [divisions, setDivisions] = useState<[number, number, number]>([4, 2, 2]);
  const [material, setMaterial] = useState(state.project.materials.at(-1)?.name ?? 'Steel');
  return (
    <section className="gen-card" aria-label="Solid block generator">
      <h4>Solid block</h4>
      <div className="form-grid">
        <PointFields label="Origin" value={origin} onChange={setOrigin} />
        <PointFields label="Size" value={size} onChange={setSize} />
        {(['X', 'Y', 'Z'] as const).map((axis, k) => (
          <Num
            key={axis}
            label={`Divisions ${axis}`}
            value={divisions[k]}
            min={1}
            integer
            onChange={(v) =>
              setDivisions(
                (old) => old.map((x, i) => (i === k ? v : x)) as [number, number, number],
              )
            }
          />
        ))}
        <label className="span-all">
          Material
          <MaterialSelect project={state.project} value={material} onChange={setMaterial} />
        </label>
      </div>
      <button
        type="button"
        className="primary"
        onClick={() =>
          generate('Solid block', (p) => solidBlock(p, { origin, size, divisions, material }))
        }
      >
        Generate solids
      </button>
    </section>
  );
}

function MaterialsEditor() {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const edit = (next: Project3D) => dispatch({ type: 'edit', project: next });
  return (
    <>
      <h4>Materials</h4>
      <div className="table-scroll">
        <table className="data editable compact" aria-label="Materials">
          <thead>
            <tr>
              <th>Name</th>
              <th title="Young's modulus">E (GPa)</th>
              <th title="Poisson's ratio">ν</th>
              <th title="Weight density">γ (kN/m³)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {project.materials.map((m) => (
              <tr key={m.name}>
                <td>
                  <TextField
                    value={m.name}
                    label="Material name"
                    width={110}
                    onCommit={(name) => edit(updateMaterial(project, m.name, { name }))}
                  />
                </td>
                <td>
                  <NumberField
                    value={m.E}
                    min={0.001}
                    width={56}
                    label="E (GPa)"
                    onCommit={(E) => edit(updateMaterial(project, m.name, { E }))}
                  />
                </td>
                <td>
                  <NumberField
                    value={m.nu}
                    min={0}
                    width={48}
                    label="Poisson's ratio"
                    onCommit={(nu) => nu < 0.5 && edit(updateMaterial(project, m.name, { nu }))}
                  />
                </td>
                <td>
                  <NumberField
                    value={m.density}
                    min={0}
                    width={48}
                    label="Density (kN/m³)"
                    onCommit={(density) => edit(updateMaterial(project, m.name, { density }))}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="ghost danger icon"
                    aria-label={`Delete material ${m.name}`}
                    title={
                      materialInUse(project, m.name) ? 'In use — cannot delete' : 'Delete material'
                    }
                    disabled={materialInUse(project, m.name) || project.materials.length <= 1}
                    onClick={() => edit(deleteMaterial(project, m.name))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => edit(addMaterial(project))}>
        + Add material
      </button>
    </>
  );
}

function SectionsEditor() {
  const { state, dispatch } = useStore3D();
  const project = state.project;
  const edit = (next: Project3D) => dispatch({ type: 'edit', project: next });
  return (
    <>
      <h4>Custom sections</h4>
      {project.customSections.length === 0 && (
        <p className="muted">Rolled ISMB / ISMC sections are built in. Add custom sections here.</p>
      )}
      {project.customSections.length > 0 && (
        <div className="table-scroll">
          <table className="data editable compact" aria-label="Custom sections">
            <thead>
              <tr>
                <th>Name</th>
                <th>A (cm²)</th>
                <th title="Major axis">Iz (cm⁴)</th>
                <th title="Minor axis">Iy (cm⁴)</th>
                <th title="Torsion constant">J (cm⁴)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {project.customSections.map((s) => (
                <tr key={s.name}>
                  <td>
                    <TextField
                      value={s.name}
                      label="Section name"
                      width={96}
                      onCommit={(name) => edit(updateCustomSection(project, s.name, { name }))}
                    />
                  </td>
                  {(['A', 'Iz', 'Iy', 'J'] as const).map((key) => (
                    <td key={key}>
                      <NumberField
                        value={s[key]}
                        min={1e-9}
                        width={54}
                        label={key}
                        onCommit={(v) => edit(updateCustomSection(project, s.name, { [key]: v }))}
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="ghost danger icon"
                      aria-label={`Delete section ${s.name}`}
                      disabled={project.members.some((m) => m.section === s.name)}
                      title="Delete section (only when unused)"
                      onClick={() => edit(deleteCustomSection(project, s.name))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" onClick={() => edit(addCustomSection(project))}>
        + Add custom section
      </button>
    </>
  );
}

export function Generate3D() {
  const { state, dispatch } = useStore3D();
  const p = state.project;
  return (
    <>
      <h3>Generate</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={p.selfWeight}
          onChange={(e) =>
            dispatch({ type: 'edit', project: { ...p, selfWeight: e.target.checked } })
          }
        />
        Include self-weight (gravity along −Y)
      </label>
      <FrameForm />
      <PlateMeshForm />
      <SolidBlockForm />
      <MaterialsEditor />
      <SectionsEditor />
    </>
  );
}
