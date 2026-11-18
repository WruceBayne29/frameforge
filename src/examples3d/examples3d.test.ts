import { describe, expect, it } from 'vitest';
import { parseProject3DText, serializeProject3D } from '../io/projectFile3d';
import { decodeProject3D, encodeProject3D } from '../io/share3d';
import { modelSize3D, nodalField, resultPeaks3D, toSolverModel3D } from '../model3d';
import type { Project3D } from '../model3d';
import { analyze3d } from '../solver3d';
import type { AnalysisResult3D } from '../solver3d';
import { EXAMPLES_3D, getExample3D } from './index';

function solve(id: string): { project: Project3D; result: AnalysisResult3D } {
  const example = getExample3D(id);
  if (!example) throw new Error(`no example ${id}`);
  const project = example.build();
  return { project, result: analyze3d(toSolverModel3D(project)) };
}

describe('3D example library', () => {
  it('covers every category with unique ids', () => {
    expect(EXAMPLES_3D.length).toBeGreaterThanOrEqual(9);
    expect(new Set(EXAMPLES_3D.map((e) => e.id)).size).toBe(EXAMPLES_3D.length);
    expect(new Set(EXAMPLES_3D.map((e) => e.category))).toEqual(
      new Set(['Trusses', 'Frames', 'Plates', 'Solids', 'Mixed', '2D frames & trusses']),
    );
    expect(getExample3D('tower-25-bar')).toBeDefined();
    expect(getExample3D('nope')).toBeUndefined();
    for (const e of EXAMPLES_3D) {
      expect(e.name.length).toBeGreaterThan(3);
      expect(e.summary.length).toBeGreaterThan(10);
    }
  });

  for (const example of EXAMPLES_3D) {
    describe(example.name, () => {
      const project = example.build();

      it('is a well-formed project that builds the same way every time', () => {
        expect(project.kind).toBe('space');
        expect(project.name.length).toBeGreaterThan(0);
        expect(project.description?.length).toBeGreaterThan(20);
        expect(example.build()).toEqual(project);
        expect(example.build()).not.toBe(project);
        const count = project.members.length + project.plates.length + project.solids.length;
        expect(count).toBeGreaterThan(0);
        expect(project.loads.length).toBeGreaterThan(0);
        // every referenced section and material exists
        const sections = toSolverModel3D(project);
        expect(sections.members?.every((m) => m.A > 0)).toBe(true);
        const materials = new Set(project.materials.map((m) => m.name));
        for (const el of [...project.members, ...project.plates, ...project.solids]) {
          expect(materials.has(el.material), `${el.id} material`).toBe(true);
        }
      });

      it('analyses without warnings, in equilibrium, with plausible displacements', () => {
        // analyze3d throws SolverError('UNSTABLE') for a mechanism, failing the test
        const result = analyze3d(toSolverModel3D(project));
        expect(result.warnings).toEqual([]);
        const applied = Math.hypot(...result.appliedLoad);
        expect(applied).toBeGreaterThan(1);
        const size = modelSize3D(project);
        result.equilibrium.forEach((residual, k) => {
          const scale = k < 3 ? applied : applied * size;
          expect(Math.abs(residual) / scale).toBeLessThan(1e-9);
        });
        expect(Number.isFinite(result.maxDisplacement)).toBe(true);
        expect(result.maxDisplacement).toBeGreaterThan(0);
        expect(result.maxDisplacement).toBeLessThan(size / 50);
        expect(result.dofCount).toBeGreaterThan(0);
        for (const d of Object.values(result.displacements)) {
          expect(Object.values(d).every(Number.isFinite)).toBe(true);
        }
        const peaks = resultPeaks3D(result);
        expect(Object.values(peaks).every(Number.isFinite)).toBe(true);
        // steel members stay elastic-ish: no axial stress beyond 250 MPa
        const model = toSolverModel3D(project);
        for (const m of model.members ?? []) {
          const r = result.members[m.id];
          const stress = Math.max(r.maxAxial.value, -r.minAxial.value) / m.A / 1000;
          expect(stress, `${m.id} axial stress, MPa`).toBeLessThan(250);
        }
      });

      it('round-trips through the file format and the share encoding', async () => {
        expect(parseProject3DText(serializeProject3D(project))).toEqual(project);
        expect(await decodeProject3D(await encodeProject3D(project))).toEqual(project);
      });
    });
  }
});

describe('3D examples against hand calculations', () => {
  it('25-bar tower: reactions balance the applied loads', () => {
    const { result } = solve('tower-25-bar');
    expect(result.appliedLoad).toEqual([11, -80, 80]);
    const sum = [0, 0, 0];
    for (const r of Object.values(result.reactions)) {
      sum[0] += r.fx;
      sum[1] += r.fy;
      sum[2] += r.fz;
    }
    expect(sum[0]).toBeCloseTo(-11, 9);
    expect(sum[1]).toBeCloseTo(80, 9);
    expect(sum[2]).toBeCloseTo(-80, 9);
    expect(Object.keys(result.members)).toHaveLength(25);
    // 10 nodes, 4 pinned: 18 free translations, no rotational unknowns in a truss
    expect(result.dofCount).toBe(18);
  });

  it('space-truss roof: symmetric, with the total load carried by the perimeter', () => {
    const { project, result } = solve('space-truss-roof');
    expect(result.appliedLoad[1]).toBeCloseTo(-12 * 36, 9);
    const total = Object.values(result.reactions).reduce((s, r) => s + r.fy, 0);
    expect(total).toBeCloseTo(12 * 36, 8);
    // four-fold symmetry: mirrored bottom nodes deflect equally
    const at = (x: number, z: number) => {
      const n = project.nodes.find(
        (node) => node.y === 0 && Math.abs(node.x - x) < 1e-9 && Math.abs(node.z - z) < 1e-9,
      );
      if (!n) throw new Error('node not found');
      return result.displacements[n.id].uy;
    };
    expect(at(1, 1)).toBeCloseTo(at(9, 9), 12);
    expect(at(1, 1)).toBeCloseTo(at(1, 9), 12);
    expect(at(3, 5)).toBeCloseTo(at(5, 3), 12);
    expect(at(5, 5)).toBeLessThan(at(1, 1));
    expect(at(5, 5)).toBeLessThan(0);
  });

  it('building frame: base reactions equal the storey loads', () => {
    const { result } = solve('building-frame');
    // 3 floors × (6 X-beams × 6 m + 6 Z-beams × 5 m) × 20 kN/m
    expect(result.appliedLoad[1]).toBeCloseTo(-3 * (36 + 30) * 20, 8);
    expect(result.appliedLoad[0]).toBeCloseTo(3 * (15 + 25 + 20), 9);
    expect(result.appliedLoad[2]).toBeCloseTo(3 * (8 + 12 + 10), 9);
    expect(Object.keys(result.reactions)).toHaveLength(9);
    const base = Object.values(result.reactions);
    expect(base.reduce((s, r) => s + r.fx, 0)).toBeCloseTo(-180, 8);
    expect(base.reduce((s, r) => s + r.fz, 0)).toBeCloseTo(-90, 8);
  });

  it('pin-ended secondary beam: simply supported shears and moment', () => {
    const { project, result } = solve('hinged-secondary-beam');
    const beam = project.members.find((m) => m.releaseI && m.releaseJ);
    if (!beam) throw new Error('secondary beam missing');
    const r = result.members[beam.id];
    expect(r.length).toBeCloseTo(5, 12);
    // 60 kN at 2 m from the start plus 6 kN/m over 5 m, simply supported
    const left = (60 * 3) / 5 + 15;
    const right = (60 * 2) / 5 + 15;
    expect(Math.abs(r.stations[0].Vy)).toBeCloseTo(left, 8);
    expect(Math.abs(r.stations[r.stations.length - 1].Vy)).toBeCloseTo(right, 8);
    expect(r.stations[0].Mz).toBeCloseTo(0, 8);
    expect(r.stations[r.stations.length - 1].Mz).toBeCloseTo(0, 8);
    // moment under the point load: R·a − w·a²/2
    expect(Math.abs(r.maxAbsMz.value)).toBeCloseTo(left * 2 - (6 * 4) / 2, 8);
    expect(r.maxAbsMz.x).toBeCloseTo(2, 8);
  });

  it('braced frame: under wind alone the bracing carries most of the storey shear', () => {
    const example = getExample3D('braced-frame');
    if (!example) throw new Error('example missing');
    const full = example.build();
    // Gravity also loads the diagonals (they prop the floors), so look at the wind on its own.
    const project = { ...full, loads: full.loads.filter((l) => l.kind === 'nodal') };
    const result = analyze3d(toSolverModel3D(project));
    expect(result.appliedLoad).toEqual([120, 0, 72]);
    const braces = project.members.filter((m) => m.type === 'truss');
    expect(braces).toHaveLength(12);
    const nodes = new Map(project.nodes.map((n) => [n.id, n]));
    // Horizontal component of the bottom-storey diagonals lying in the X faces / Z faces.
    const carried = (axis: 'x' | 'z'): number => {
      let sum = 0;
      for (const b of braces) {
        const i = nodes.get(b.i);
        const j = nodes.get(b.j);
        if (!i || !j || Math.min(i.y, j.y) > 0 || Math.abs(i[axis] - j[axis]) < 1) continue;
        const length = Math.hypot(j.x - i.x, j.y - i.y, j.z - i.z);
        const r = result.members[b.id];
        // lower end on the windward side: the diagonal is in tension
        expect(r.minAxial.value).toBeGreaterThan(0);
        sum += r.maxAxial.value * (Math.abs(j[axis] - i[axis]) / length);
      }
      return sum;
    };
    // The remainder is column shear, small because the bases are pinned.
    expect(carried('x')).toBeGreaterThan(0.9 * 120);
    expect(carried('x')).toBeLessThan(120);
    expect(carried('z')).toBeGreaterThan(0.9 * 72);
    expect(carried('z')).toBeLessThan(72);
  });

  it('simply supported slab: centre deflection 0.00406·q·a⁴/D and moment 0.0479·q·a²', () => {
    const { project, result } = solve('simply-supported-slab');
    const q = 10;
    const a = 5;
    const t = 0.18;
    const D = (25e6 * t ** 3) / (12 * (1 - 0.2 ** 2));
    const thin = (0.00406 * q * a ** 4) / D;
    const centre = project.nodes.find((n) => n.x === 2.5 && n.z === 2.5);
    if (!centre) throw new Error('centre node missing');
    const w = -result.displacements[centre.id].uy;
    // Thin-plate theory; the Mindlin element adds a little shear deflection and the soft
    // (w-only) supports a little more, so the mesh result is slightly above it.
    expect(w / thin).toBeGreaterThan(0.99);
    expect(w / thin).toBeLessThan(1.04);
    expect(result.maxDisplacement).toBeCloseTo(w, 12);
    expect(result.appliedLoad[1]).toBeCloseTo(-q * a * a, 9);
    // Centre moments from the nodal average. Navier's 0.0479 is for nu = 0.3; for nu = 0.2
    // the series gives 0.0442·q·a². Sagging = bottom in tension = negative in the solver's
    // convention (plate normal up).
    const mx = nodalField(project, result, 'plateMx').values[centre.id];
    const my = nodalField(project, result, 'plateMy').values[centre.id];
    expect(mx).toBeLessThan(0);
    expect(mx / my).toBeCloseTo(1, 6);
    expect(-mx / (0.0442 * q * a * a)).toBeGreaterThan(0.97);
    expect(-mx / (0.0442 * q * a * a)).toBeLessThan(1.03);
    // top surface in compression, bottom in tension, equal von Mises on both
    const top = nodalField(project, result, 'plateVonMisesTop').values[centre.id];
    const bottom = nodalField(project, result, 'plateVonMisesBottom').values[centre.id];
    expect(top / bottom).toBeCloseTo(1, 6);
    expect(top / ((6 * -mx) / (t * t))).toBeCloseTo(1, 2);
  });

  it('slab on beams: total weight = slab + beams + columns + imposed load', () => {
    const { project, result } = solve('slab-on-beams');
    const slab = 6 * 4 * 0.15 * 25;
    const steel = 56.26e-4 * 77 * (2 * 6 + 2 * 4 + 4 * 3);
    const imposed = 8 * 24;
    expect(-result.appliedLoad[1]).toBeCloseTo(slab + steel + imposed, 8);
    const base = Object.values(result.reactions);
    expect(base).toHaveLength(4);
    // doubly symmetric: each column takes a quarter
    for (const r of base) expect(r.fy).toBeCloseTo((slab + steel + imposed) / 4, 6);
    // the slab sags most at its centre
    const centre = project.nodes.find((n) => n.x === 3 && n.z === 2 && n.y === 3);
    if (!centre) throw new Error('centre node missing');
    const field = nodalField(project, result, 'displacement');
    expect(field.values[centre.id]).toBeCloseTo(field.max, 12);
  });

  it('solid cantilever: tip deflection close to beam theory w·L⁴/(8·E·I) + shear', () => {
    const { project, result } = solve('solid-cantilever');
    const E = 25e6;
    const L = 2;
    const b = 0.3;
    const h = 0.4;
    const w = 50 * b;
    expect(result.appliedLoad[1]).toBeCloseTo(-w * L, 9);
    const I = (b * h ** 3) / 12;
    const G = E / 2.4;
    const beam = (w * L ** 4) / (8 * E * I) + (w * L * L) / (2 * (5 / 6) * G * b * h);
    const tip = project.nodes.filter((n) => n.x === L);
    const mean = tip.reduce((s, n) => s + result.displacements[n.id].uy, 0) / tip.length;
    expect(-mean / beam).toBeGreaterThan(0.95);
    expect(-mean / beam).toBeLessThan(1.03);
    // root bending stress M·c/I = (w·L²/2)·(h/2)/I at the fixed end
    const sigma = (((w * L * L) / 2) * (h / 2)) / I;
    const s1 = nodalField(project, result, 'solidS1');
    expect(s1.max / sigma).toBeGreaterThan(0.8);
    expect(s1.max / sigma).toBeLessThan(1.5);
  });

  it('pad footing: the base carries the column load and its overturning moment', () => {
    const { project, result } = solve('pad-footing');
    let fx = 0;
    let fy = 0;
    let mz = 0;
    for (const [id, r] of Object.entries(result.reactions)) {
      const n = project.nodes.find((node) => node.id === id);
      if (!n) continue;
      fx += r.fx;
      fy += r.fy;
      mz += n.x * r.fy - n.y * r.fx;
    }
    expect(fx).toBeCloseTo(-20, 8);
    expect(fy).toBeCloseTo(400, 8);
    // moment about the origin (top of footing, column axis): 20 kN × 3 m, resisted by the base
    expect(mz).toBeCloseTo(20 * 3, 7);
    // the column behaves as a cantilever from the footing: M = 60 kN·m at the top of the pad
    const column = project.members[project.members.length - 1];
    expect(Math.abs(result.members[column.id].maxAbsMz.value)).toBeCloseTo(60, 8);
    expect(result.members[column.id].minAxial.value).toBeCloseTo(-400, 8);
  });
});
