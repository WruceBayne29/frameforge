/**
 * What a click in the 3D viewer does with each tool. Pure: given the state and what was hit,
 * returns the action to dispatch, so every tool is unit tested without WebGL.
 */
import { addMember, addNode, addPlate } from '../model3d';
import type { Project3D } from '../model3d';
import type { Vec3 } from '../solver3d';
import {
  applySupport,
  applyToolLoad,
  deleteSelection,
  LOAD_TOOL_TARGET,
  LOAD_TOOL_UNIT,
} from './state';
import type { Action3D, AppState3D, Pick3D, SelectionKind, Tool3D, ToolOptions3D } from './state';

/** What the pointer was over when the user clicked. */
export interface ClickHit {
  pick: Pick3D | null;
  /** Point on the working plane under the pointer (already snapped), if the tool uses it. */
  plane: Vec3 | null;
  /** Shift (add to selection) was held. */
  additive: boolean;
}

const ALL: SelectionKind[] = ['node', 'member', 'plate', 'solid', 'load'];

/** The kinds of thing a tool can click on. */
export function pickKindsFor(
  tool: Tool3D,
  options: Pick<ToolOptions3D, 'loadKind'>,
): SelectionKind[] {
  switch (tool) {
    case 'select':
    case 'delete':
      return ALL;
    case 'node':
    case 'member':
    case 'plate':
    case 'support':
      return ['node'];
    case 'load':
      return [LOAD_TOOL_TARGET[options.loadKind]];
  }
}

/** Tools that place new nodes on the working plane. */
export function usesPlane(tool: Tool3D): boolean {
  return tool === 'node' || tool === 'member' || tool === 'plate';
}

/** The node clicked, or a new node created at the plane point. */
function nodeFor(project: Project3D, hit: ClickHit): { project: Project3D; id: string } | null {
  if (hit.pick?.kind === 'node') return { project, id: hit.pick.id };
  if (hit.plane) return addNode(project, hit.plane[0], hit.plane[1], hit.plane[2]);
  return null;
}

export function clickAction(state: AppState3D, hit: ClickHit): Action3D | null {
  const { project, toolOptions: o, pending } = state;
  switch (state.tool) {
    case 'select':
      return { type: 'pick', pick: hit.pick, additive: hit.additive };
    case 'node': {
      if (hit.pick?.kind === 'node') {
        return { type: 'select', selection: { kind: 'node', ids: [hit.pick.id] } };
      }
      if (!hit.plane) return null;
      const r = addNode(project, hit.plane[0], hit.plane[1], hit.plane[2]);
      return { type: 'edit', project: r.project, selection: { kind: 'node', ids: [r.id] } };
    }
    case 'member': {
      const r = nodeFor(project, hit);
      if (!r) return null;
      if (pending.length === 0 || pending[0] === r.id) {
        return { type: 'edit', project: r.project, pending: [r.id] };
      }
      const m = addMember(r.project, pending[0], r.id, {
        type: o.memberType,
        section: o.section,
      });
      // Keep drawing from the last node, like a polyline.
      return {
        type: 'edit',
        project: m.project,
        pending: [r.id],
        selection: m.id ? { kind: 'member', ids: [m.id] } : undefined,
      };
    }
    case 'plate': {
      const r = nodeFor(project, hit);
      if (!r) return null;
      if (pending.includes(r.id)) return { type: 'edit', project: r.project, pending };
      const nodes = [...pending, r.id];
      if (nodes.length < 4) return { type: 'edit', project: r.project, pending: nodes };
      const p = addPlate(r.project, nodes, { thickness: o.thickness });
      return {
        type: 'edit',
        project: p.project,
        pending: [],
        selection: p.id ? { kind: 'plate', ids: [p.id] } : undefined,
      };
    }
    case 'support': {
      if (hit.pick?.kind !== 'node') return null;
      return {
        type: 'edit',
        project: applySupport(project, [hit.pick.id], o),
        selection: { kind: 'node', ids: [hit.pick.id] },
      };
    }
    case 'load': {
      if (!hit.pick) return null;
      const r = applyToolLoad(project, o, hit.pick.kind, [hit.pick.id]);
      return r
        ? { type: 'edit', project: r.project, selection: { kind: 'load', ids: [r.id] } }
        : null;
    }
    case 'delete': {
      if (!hit.pick) return null;
      const next = deleteSelection(project, { kind: hit.pick.kind, ids: [hit.pick.id] });
      return { type: 'edit', project: next };
    }
  }
}

const TARGET_NAME: Record<SelectionKind, string> = {
  node: 'node',
  member: 'member',
  plate: 'plate',
  solid: 'solid',
  load: 'load',
};

/** Short instruction shown over the viewer for the active tool. */
export function toolHint(state: AppState3D): string | null {
  const n = state.pending.length;
  switch (state.tool) {
    case 'select':
      return null;
    case 'node':
      return `Click the grid (elevation Y = ${state.toolOptions.elevation} m) to add a node`;
    case 'member':
      return n === 0
        ? 'Click the first node (or the grid) of the member'
        : `Click the end node — from ${state.pending[0]} (Esc to stop)`;
    case 'plate':
      return `Click four corner nodes in order around the plate — ${n} / 4`;
    case 'support':
      return 'Click a node to apply the support';
    case 'load': {
      const kind = state.toolOptions.loadKind;
      return `Click a ${TARGET_NAME[LOAD_TOOL_TARGET[kind]]} to apply ${state.toolOptions.loadValue} ${LOAD_TOOL_UNIT[kind]}`;
    }
    case 'delete':
      return 'Click anything to delete it';
  }
}
