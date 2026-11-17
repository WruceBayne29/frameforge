/**
 * Internal contract between the element modules and the assembler (`analyze.ts`).
 *
 * Every element module builds, for one element, a stiffness matrix and an equivalent nodal
 * load vector **in global axes**, plus whatever it needs to recover results later. The
 * assembler scatters them into the global system, solves, and hands each element its own
 * displacement vector back for result recovery.
 *
 * Element DOF order is node by node: with `dofsPerNode = 3` each node contributes
 * [ux, uy, uz]; with `dofsPerNode = 6` it contributes [ux, uy, uz, rx, ry, rz].
 *
 * Signatures the element modules export (see each file):
 *
 *   line.ts   lineElement(member, xi, xj, loads, gravity): LineElement
 *             lineResult(el, u, segments): MemberResult3D
 *   plate.ts  plateElement(plate, coords, loads, gravity): PlateElement
 *             plateResult(el, u): PlateResult3D
 *   solid.ts  solidElement(solid, coords, loads, gravity): SolidElement
 *             solidResult(el, u): SolidResult3D
 *
 * where `coords` are the node positions in element node order, `loads` are the loads that
 * name this element, `gravity` is the summed self-weight vector g (body force per unit
 * volume = density · g; zero when there is no self-weight load) and `u` is the element's
 * displacement vector in global axes, in element DOF order. `LineElement`, `PlateElement`
 * and `SolidElement` extend `ElementMatrices` with module-private recovery data.
 *
 * Element modules throw `SolverError('INVALID_MODEL', …, { memberId: element id })` from
 * `../solver/errors` for bad geometry or properties.
 */

export interface ElementMatrices {
  /** Node ids in element order. */
  nodes: string[];
  /** 3 = translations only (truss, solid); 6 = translations + rotations (beam, plate). */
  dofsPerNode: 3 | 6;
  /** Stiffness in global axes, size n × n with n = nodes.length · dofsPerNode. Symmetric. */
  k: number[][];
  /** Equivalent nodal loads in global axes (element loads + self-weight), length n. */
  f: number[];
}
