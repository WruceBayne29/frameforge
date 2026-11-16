/**
 * Presentation helpers shared by the canvas and the PDF report: model extents, automatic
 * scales for diagrams and deformations, and the utilisation colour ramp.
 */
import type { AnalysisResult } from '../solver';
import type { Project } from './types';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function modelBounds(project: Project): Bounds {
  if (project.nodes.length === 0) return { minX: -2, minY: -2, maxX: 10, maxY: 6 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of project.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Characteristic size of the model, used to scale diagrams and deformations. */
export function modelSize(project: Project): number {
  const b = modelBounds(project);
  return Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
}

export interface Peaks {
  N: number;
  V: number;
  M: number;
}

/** Largest absolute axial force, shear and moment anywhere in the structure. */
export function resultPeaks(result: AnalysisResult): Peaks {
  const peak = { N: 0, V: 0, M: 0 };
  for (const m of Object.values(result.members)) {
    peak.N = Math.max(peak.N, Math.abs(m.maxAxial.value), Math.abs(m.minAxial.value));
    peak.V = Math.max(peak.V, Math.abs(m.maxAbsShear.value));
    peak.M = Math.max(peak.M, Math.abs(m.maxAbsMoment.value));
  }
  return peak;
}

export interface ResultScales {
  /** World metres of deformation drawn per metre of real displacement. */
  deform: number;
  /** World metres of diagram ordinate per unit of N / V / M. */
  diagram: Peaks;
}

/** Automatic scales so the largest deformation / diagram ordinate is a fixed share of the model. */
export function resultScales(
  project: Project,
  result: AnalysisResult,
  deformFactor = 1,
  diagramFactor = 1,
): ResultScales {
  const size = modelSize(project);
  const peak = resultPeaks(result);
  const unit = (p: number) => (p > 1e-9 ? (0.11 * size * diagramFactor) / p : 0);
  return {
    deform:
      result.maxDisplacement > 1e-12 ? (0.045 * size * deformFactor) / result.maxDisplacement : 0,
    diagram: { N: unit(peak.N), V: unit(peak.V), M: unit(peak.M) },
  };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Colour for a utilisation ratio: green → amber → red, magenta when the member fails. */
export function utilisationRgb(ratio: number): [number, number, number] {
  if (!Number.isFinite(ratio)) return [156, 163, 175];
  if (ratio > 1) return [192, 38, 211];
  return hslToRgb(140 - 140 * Math.min(Math.max(ratio, 0), 1), 0.78, 0.42);
}

export function utilisationColor(ratio: number): string {
  const [r, g, b] = utilisationRgb(ratio);
  return `rgb(${r} ${g} ${b})`;
}
