/**
 * Pure editing operations on a project. Every function returns a new project (or the same
 * object when nothing changes) so they compose with undo/redo history.
 */
import { nextId } from './ids';
import type {
  MemberType,
  Project,
  ProjectLoad,
  ProjectMember,
  ProjectNode,
  SupportKind,
} from './types';

const TOL = 1e-6;

/** Distributive Omit so that each member of the load union keeps its own fields. */
export type NewLoad = ProjectLoad extends infer L
  ? L extends unknown
    ? Omit<L, 'id'>
    : never
  : never;

export function findNodeAt(
  project: Project,
  x: number,
  y: number,
  tol = TOL,
): ProjectNode | undefined {
  return project.nodes.find((n) => Math.abs(n.x - x) <= tol && Math.abs(n.y - y) <= tol);
}

/** Adds a node, or returns the existing node at the same position. */
export function addNode(project: Project, x: number, y: number): { project: Project; id: string } {
  const existing = findNodeAt(project, x, y);
  if (existing) return { project, id: existing.id };
  const id = nextId(
    'N',
    project.nodes.map((n) => n.id),
  );
  return { project: { ...project, nodes: [...project.nodes, { id, x, y }] }, id };
}

export function moveNode(project: Project, id: string, x: number, y: number): Project {
  const node = project.nodes.find((n) => n.id === id);
  if (!node || (node.x === x && node.y === y)) return project;
  // Refuse to stack a node on top of another one.
  const clash = findNodeAt(project, x, y);
  if (clash && clash.id !== id) return project;
  return { ...project, nodes: project.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) };
}

export function addMember(
  project: Project,
  i: string,
  j: string,
  type: MemberType,
  section: string,
): { project: Project; id: string | null } {
  if (i === j) return { project, id: null };
  const duplicate = project.members.find(
    (m) => (m.i === i && m.j === j) || (m.i === j && m.j === i),
  );
  if (duplicate) return { project, id: duplicate.id };
  const id = nextId(
    'M',
    project.members.map((m) => m.id),
  );
  return {
    project: { ...project, members: [...project.members, { id, i, j, type, section }] },
    id,
  };
}

export function updateMember(project: Project, id: string, patch: Partial<ProjectMember>): Project {
  return {
    ...project,
    members: project.members.map((m) => (m.id === id ? { ...m, ...patch, id: m.id } : m)),
  };
}

export function deleteMember(project: Project, id: string): Project {
  return {
    ...project,
    members: project.members.filter((m) => m.id !== id),
    loads: project.loads.filter((l) => l.kind === 'nodal' || l.member !== id),
  };
}

/** Deletes a node together with its members, support and loads. */
export function deleteNode(project: Project, id: string): Project {
  const removed = new Set(project.members.filter((m) => m.i === id || m.j === id).map((m) => m.id));
  return {
    ...project,
    nodes: project.nodes.filter((n) => n.id !== id),
    members: project.members.filter((m) => !removed.has(m.id)),
    supports: project.supports.filter((s) => s.node !== id),
    loads: project.loads.filter((l) =>
      l.kind === 'nodal' ? l.node !== id : !removed.has(l.member),
    ),
  };
}

/** Sets (or with `null` removes) the support at a node. */
export function setSupport(project: Project, node: string, kind: SupportKind | null): Project {
  const others = project.supports.filter((s) => s.node !== node);
  return { ...project, supports: kind ? [...others, { node, kind }] : others };
}

export function addLoad(project: Project, load: NewLoad): { project: Project; id: string } {
  const id = nextId(
    'L',
    project.loads.map((l) => l.id),
  );
  return { project: { ...project, loads: [...project.loads, { ...load, id } as ProjectLoad] }, id };
}

export function updateLoad(project: Project, id: string, patch: Partial<ProjectLoad>): Project {
  return {
    ...project,
    loads: project.loads.map((l) =>
      l.id === id ? ({ ...l, ...patch, id: l.id } as ProjectLoad) : l,
    ),
  };
}

export function deleteLoad(project: Project, id: string): Project {
  return { ...project, loads: project.loads.filter((l) => l.id !== id) };
}

/**
 * Inserts a node on a member at distance `x` from its start, replacing the member with two.
 * Member loads are carried over to the correct piece.
 */
export function splitMember(
  project: Project,
  memberId: string,
  x: number,
): { project: Project; nodeId: string | null } {
  const member = project.members.find((m) => m.id === memberId);
  const a = member && project.nodes.find((n) => n.id === member.i);
  const b = member && project.nodes.find((n) => n.id === member.j);
  if (!member || !a || !b) return { project, nodeId: null };
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (x <= 1e-6 * length) return { project, nodeId: a.id };
  if (x >= length * (1 - 1e-6)) return { project, nodeId: b.id };

  const round = (v: number) => Number(v.toFixed(6));
  const px = round(a.x + ((b.x - a.x) * x) / length);
  const py = round(a.y + ((b.y - a.y) * x) / length);
  const added = addNode(project, px, py);
  const nodeId = added.id;
  const secondId = nextId(
    'M',
    project.members.map((m) => m.id),
  );
  const first: ProjectMember = { ...member, j: nodeId, releaseJ: undefined };
  const second: ProjectMember = { ...member, id: secondId, i: nodeId, releaseI: undefined };

  const loads: ProjectLoad[] = [];
  const ids = project.loads.map((l) => l.id);
  const fresh = () => {
    const id = nextId('L', ids);
    ids.push(id);
    return id;
  };
  for (const load of project.loads) {
    if (load.kind === 'nodal' || load.member !== memberId) {
      loads.push(load);
    } else if (load.kind === 'point' || load.kind === 'moment') {
      loads.push(load.a <= x ? load : { ...load, member: secondId, a: round(load.a - x) });
    } else {
      const la = load.a ?? 0;
      const lb = load.b ?? length;
      const w2 = load.w2 ?? load.w1;
      const wAt = (s: number) =>
        lb - la < TOL ? load.w1 : load.w1 + ((w2 - load.w1) * (s - la)) / (lb - la);
      if (la < x - TOL) {
        const end = Math.min(lb, x);
        loads.push({ ...load, a: round(la), b: round(end), w1: load.w1, w2: round(wAt(end)) });
      }
      if (lb > x + TOL) {
        const start = Math.max(la, x);
        loads.push({
          ...load,
          id: la < x - TOL ? fresh() : load.id,
          member: secondId,
          a: round(start - x),
          b: round(lb - x),
          w1: round(wAt(start)),
          w2,
        });
      }
    }
  }

  return {
    project: {
      ...added.project,
      members: added.project.members.flatMap((m) => (m.id === memberId ? [first, second] : [m])),
      loads,
    },
    nodeId,
  };
}

/** Removes nodes that have no members, supports or loads attached. */
export function pruneOrphanNodes(project: Project): Project {
  const used = new Set<string>();
  for (const m of project.members) {
    used.add(m.i);
    used.add(m.j);
  }
  const nodes = project.nodes.filter((n) => used.has(n.id));
  if (nodes.length === project.nodes.length) return project;
  const keep = new Set(nodes.map((n) => n.id));
  return {
    ...project,
    nodes,
    supports: project.supports.filter((s) => keep.has(s.node)),
    loads: project.loads.filter((l) => l.kind !== 'nodal' || keep.has(l.node)),
  };
}
