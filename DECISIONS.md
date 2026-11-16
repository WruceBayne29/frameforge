# Decisions log

Calls made autonomously while building, newest last.

1. **TypeScript pinned to 6.0** — the Vite template ships TS 7, but `typescript-eslint` 8.x
   only supports `<6.1`. ESLint + strict typing was a requirement, so TS was pinned.
2. **ESLint instead of oxlint** — the template defaults to oxlint; the brief asks for ESLint + Prettier.
3. **Vite `base: './'`** — relative asset paths, so the same build works on GitHub Pages and locally.
4. **Solver is unit-agnostic**; the UI works in kN / m / GPa / cm² / cm⁴ and converts in `src/model`.
5. **Member loads via consistent nodal loads** (Hermite shape-function integration with Gauss
   quadrature) rather than a table of fixed-end-moment formulas — one code path handles full or
   partial, uniform or trapezoidal loads, point loads and point moments exactly.
6. **End releases via static condensation** of the element stiffness and fixed-end vector —
   general, and keeps the global DOF count at 3 per node.
7. **Unrestrained zero-stiffness rotations are auto-fixed** (e.g. pure-truss joints), so trusses
   don't need a fake rotational restraint. Genuine mechanisms still raise a clear error.
