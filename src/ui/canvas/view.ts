import type { Project } from '../../model';

/** Maps world coordinates (m, y up) to screen pixels (y down). */
export interface View {
  /** Pixels per metre. */
  scale: number;
  ox: number;
  oy: number;
}

export type Point = [number, number];

export const toScreen = (v: View, x: number, y: number): Point => [
  v.ox + x * v.scale,
  v.oy - y * v.scale,
];

export const toWorld = (v: View, sx: number, sy: number): Point => [
  (sx - v.ox) / v.scale,
  (v.oy - sy) / v.scale,
];

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

/** View that fits the whole model in the viewport with padding for loads and diagrams. */
export function fitView(project: Project, width: number, height: number): View {
  const b = modelBounds(project);
  const padX = Math.min(110, width * 0.16);
  const padY = Math.min(110, height * 0.2);
  const w = Math.max(b.maxX - b.minX, 1e-6);
  const h = Math.max(b.maxY - b.minY, 1e-6);
  const scale = Math.max(Math.min((width - 2 * padX) / w, (height - 2 * padY) / h, 400), 1);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { scale, ox: width / 2 - cx * scale, oy: height / 2 + cy * scale };
}

/** Zooms about a screen point, keeping the world point under it fixed. */
export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const scale = Math.min(Math.max(v.scale * factor, 2), 4000);
  const [wx, wy] = toWorld(v, sx, sy);
  return { scale, ox: sx - wx * scale, oy: sy + wy * scale };
}

/** A "nice" grid spacing (1, 2 or 5 × 10ⁿ) that is at least `minPixels` apart on screen. */
export function niceStep(scale: number, minPixels: number): number {
  const raw = minPixels / scale;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/** Distance from point p to segment ab, and the parameter t (0..1) of the closest point. */
export function distanceToSegment(p: Point, a: Point, b: Point): { distance: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return { distance: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t };
}
