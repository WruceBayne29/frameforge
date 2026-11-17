/** Viewer colours, read from the CSS custom properties so they follow the light / dark theme. */
export interface Palette {
  background: string;
  grid: string;
  gridMajor: string;
  node: string;
  beam: string;
  truss: string;
  plate: string;
  plateEdge: string;
  solid: string;
  solidEdge: string;
  support: string;
  load: string;
  reaction: string;
  deformed: string;
  accent: string;
  hover: string;
  moment: string;
  shear: string;
  axial: string;
  torsion: string;
  tension: string;
  compression: string;
  axisX: string;
  axisY: string;
  axisZ: string;
  text: string;
  muted: string;
}

const VARS: Record<keyof Palette, string> = {
  background: '--canvas',
  grid: '--grid',
  gridMajor: '--grid-major',
  node: '--node',
  beam: '--member',
  truss: '--truss-3d',
  plate: '--plate-3d',
  plateEdge: '--plate-edge-3d',
  solid: '--solid-3d',
  solidEdge: '--solid-edge-3d',
  support: '--support',
  load: '--load',
  reaction: '--reaction',
  deformed: '--deformed',
  accent: '--accent',
  hover: '--hover-3d',
  moment: '--moment',
  shear: '--shear',
  axial: '--tension',
  torsion: '--torsion-3d',
  tension: '--tension',
  compression: '--compression',
  axisX: '--axis-x-3d',
  axisY: '--axis-y-3d',
  axisZ: '--axis-z-3d',
  text: '--text',
  muted: '--muted',
};

/** Used where CSS is not available (tests) or a variable is missing. */
export const FALLBACK_PALETTE: Palette = {
  background: '#fbfdff',
  grid: '#eef2f6',
  gridMajor: '#dfe6ee',
  node: '#0f172a',
  beam: '#1e293b',
  truss: '#0d9488',
  plate: '#7dd3fc',
  plateEdge: '#0369a1',
  solid: '#cbd5e1',
  solidEdge: '#475569',
  support: '#475569',
  load: '#dc2626',
  reaction: '#15803d',
  deformed: '#7c3aed',
  accent: '#0369a1',
  hover: '#f59e0b',
  moment: '#ea580c',
  shear: '#0891b2',
  axial: '#2563eb',
  torsion: '#a21caf',
  tension: '#2563eb',
  compression: '#dc2626',
  axisX: '#dc2626',
  axisY: '#16a34a',
  axisZ: '#2563eb',
  text: '#0f172a',
  muted: '#64748b',
};

export function readPalette(element: Element = document.documentElement): Palette {
  const style = getComputedStyle(element);
  const out = { ...FALLBACK_PALETTE };
  for (const key of Object.keys(VARS) as Array<keyof Palette>) {
    const value = style.getPropertyValue(VARS[key]).trim();
    if (value) out[key] = value;
  }
  return out;
}
