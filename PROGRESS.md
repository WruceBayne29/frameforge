# Progress

## Current work: one 3D app (branch `feat/3d-only`)

Goal: remove the 2D workspace without losing any capability — every 2D feature must work in
the 3D workspace. Branched from `feat/3d-space-structures` (PR #1 was not merged). Phases,
each committed and pushed when `npm run check`, `npm run format:check` and `npm run coverage`
pass:

- [x] **Phase 1 — plane frame mode.** `Project3D.plane = 'XY'`: the solver model holds uz, rx,
  ry at every node (`toSolverModel3D`), `analyzeProject3D` hides those restraints from the
  reactions; orthographic front view locked; tools draw on z = 0 with a snap grid; node
  dragging with live re-analysis (select tool); N / Vy / Mz diagrams; in-plane columns in
  tables and results; 2D support kinds; toggle in Properties (no selection) and "New → Plane
  frame". `from2D` now produces plane-mode projects (steel 7.85 t/m³ × g, so modal mass
  matches 2D). The nine 2D examples are a "2D frames & trusses" category of the 3D picker.
  Tests: `tests/validation/plane.test.ts` (every 2D example and every model analysed by a 2D
  validation case agree with the 2D solver at every station to 1e-8 relative; the two
  axially-rigid portal cases get a conditioning-scaled tolerance, see DECISIONS 36);
  `tests/validation/engine.ts` lets each 2D validation case run on the 2D solver or on the
  plane-frame path (`plane2d.ts`), and the validation test runs both.
- [x] **Phase 2 — IS 800 design check in 3D.** `checkMember` takes optional `momentY`,
  `shearZ`, `torsion`, `cmy`: minor-axis bending (cl. 8.2.1.2, Zpy from the idealised geometry
  — `plasticModulusMinor`), shear across the flanges (Av = 2·bf·tf) with the high-shear
  reduction, biaxial section check (cl. 9.3.1.1 simplified), both member-buckling equations of
  cl. 9.3.2.2, tension + biaxial bending; torsion is reported, not checked. With no minor-axis
  action the result is identical to the 2D check (tested with `toEqual`). `model3d/design.ts`
  (`designMembers3D`: Mz → major, My → minor; project `design.kz` / `ky` plus member `kz` / `ky`
  overrides, kLT = ky; custom sections skipped). UI: Design tab (settings, summary, per-member
  breakdown), utilisation colours (chip + U key), K overrides in member Properties.
  `tests/validation/design.test.ts`: plane-mode design of every 2D example matches the 2D app
  (same members, class, checks, governing check; ratios to 1e-9).
- [x] **Phase 3 — modal analysis in 3D.** `prepareSystem` / `assembleStiffness` split out of
  `analyze3d` (shared by statics, modal, influence lines); `restrainAll` in the solver model
  carries the plane restraint (also to subdivision nodes). Consistent mass: `lineMass` (beam
  12×12 with torsional inertia ρ(Iy+Iz)L, releases by Guyan reduction; truss), `plateMass`
  (translations + rotary inertia ρt³/12), `solidMass` (3×3×3 Gauss). `eigen.ts`: subspace
  iteration on the skyline factorisation, M-orthonormalised Rayleigh–Ritz, subspace widened
  past clusters of close eigenvalues. `modalAnalysis3d` (subdivision like 2D `refineModel`,
  nodal masses, effective mass fractions, zero-frequency mechanism check). Project level:
  `modalProject3D`, `Project3D.masses` (node Properties), material density / g. UI: Advanced
  tab (frequencies table, mass fractions), animated mode shapes. Tests: plane-mode modal of
  every 2D example = 2D app (frequencies 1e-8), V23/V24 through plane mode, closed forms in
  `solver3d/modal.test.ts`, VALIDATION_3D cases M01–M05. Found and fixed: the "Simply
  supported slab" example could spin in its own plane (wrong in-plane support direction).
- [x] **Phase 4 — influence lines in 3D.** `solver3d/influence.ts` (`influenceLine3d`): one
  factorisation, one solve per load position; targets: reactions (6 components), nodal
  displacements, member N / Vy / Vz / T / My / Mz at a section (`lineForcesAt`); load
  default −Y, any member-load direction; left limit at the section like 2D. Project level:
  `influenceProject3D`, `defaultLoadPath3D` (near-horizontal members = beams in plane mode).
  UI: Advanced tab section (response, node / member + section, component; ordinates table),
  the line drawn above its path with max / min labels and a target marker. Tests: plane mode
  = 2D app on every example (supports, mid-member N/V/M, node uy; 1e-8), V25/V26 through
  plane mode, closed forms + "every ordinate equals a static analysis" in
  `solver3d/influence.test.ts`, VALIDATION_3D I01–I02. All 26 2D validation cases now run on
  the plane-frame engine as well as the 2D reference.
- [ ] Phase 5 — PDF report for Project3D.
- [ ] Phase 6 — delete the 2D UI, migrate old files / `#m=` links / autosave.
- [ ] Phase 7 — e2e, screenshots, docs, PR (do not merge).

Dev server for this branch: `.claude/worktrees/3d-only` is a git worktree of the main
checkout; the preview config `frameforge-3d-only` (port 5199) runs it.

## Earlier status

**Status:** COMPLETE — all eight milestones, final deliverables, self-review and all three
stretch features are done. The 2D app is deployed at https://wrucebayne29.github.io/frameforge/;
the 3D workspace is complete on the `feat/3d-space-structures` branch (not yet merged or deployed).

## Done
- Repo scaffold: Vite + React + TS 6, Vitest, ESLint, Prettier.
- GitHub repo created, Pages enabled (build type: GitHub Actions), CI + deploy workflows.
- **Milestone 1 — solver core** (`src/solver/`): truss + frame elements, releases (static
  condensation), supports, settlements, springs, nodal loads, member UDL / trapezoid / point /
  moment loads, N/V/M + deflection stations, instability detection. 99 % coverage.
- Validation suite: 22 textbook problems, 103 quantities, all within 0.1 % → `VALIDATION.md`
  (regenerate with `npm run validation`).
- `src/design-codes/`: IS 800:2007 member check + ISMB/ISMC section table (by subagent, verified).
- `src/model/` (project model, unit conversion, pure edit ops, design wiring), `src/examples/`
  (9 structures incl. transmission tower), docs/THEORY.md + CONTRIBUTING + templates (by subagent).

- **Milestones 2–8 implemented in the UI**: MVP deployed; editor (tools, snap, undo/redo, tables);
  results view (deformed + sliders, N/V/M, reactions, tooltips); IS 800 utilisation colours;
  9 examples; PDF report (`src/io/report.ts`), JSON save/load, share URL (`#m=`), autosave;
  dark/light, responsive CSS, shortcuts, help dialog, onboarding tour.

- Playwright: `scripts/e2e.mjs` (63 checks, passing on the live site) and `scripts/screenshots.mjs`
  (docs/screenshots + hero GIF).
- Final docs: README (full), docs/THEORY.md, VALIDATION.md, CONTRIBUTING, templates, LICENSE,
  LINKEDIN_POST.md, CV_BULLETS.md.

- Self-review: clicked through every feature on the live site with Playwright (`npm run e2e`,
  69 checks); fixed phone-width overflow, view re-fit on resize, truss axial view, support glyph
  orientation, label clutter, clipped reaction labels.
- Stretch: modal analysis (`src/solver/modal.ts`, animated mode shapes) and influence lines
  (`src/solver/influence.ts`), both validated (V23–V26) and exposed in the Advanced tab.

- **3D workspace** (branch `feat/3d-space-structures`, decisions 22–35):
  - `src/solver3d/`: 6-DOF truss, 12-DOF beam with end releases, 4-node flat shell (MITC4 +
    QM6 + drilling), 8-node incompatible-mode hexahedron, member / plate / solid-face loads and
    self-weight, settlements and springs, skyline LDLᵀ with RCM ordering, mechanism handling.
    99.9 % statement coverage.
  - `src/model3d/` (units, edit operations, frame / plate-mesh / solid-block generators,
    conversion from 2D), `src/io/projectFile3d.ts` + `share3d.ts`, `src/examples3d/` (9 examples),
    `src/ui3d/` (lazy-loaded three.js workspace, 2D | 3D switch), `scripts/e2e3d.mjs`.
  - 3D validation suite: 20 problems, 103 quantities, each within its stated tolerance →
    `VALIDATION_3D.md` (`npm run validation3d`).
  - Docs: README 3D section, docs/THEORY_3D.md, DECISIONS 22–35.
- Test suite: 1056 tests (27 files), coverage 99.7 % of statements over both solvers and the
  design code.

## Not done
- 3D: load combinations, PDF report, IS 800 design check, modal analysis and influence lines;
  a drawing tool for solids; settlements and springs in the 3D editor (the solver supports them);
  solving in a Web Worker.

## If you resume
- Nothing is in progress. `npm run check`, `npm run e2e` and `npm run e2e3d` should pass.
- Merge `feat/3d-space-structures` into `main` to deploy the 3D workspace.
- Ideas, in order: load combinations (IS 875), angle sections for trusses, 3D design checks.

## Milestone checklist
- [x] 1. Solver core + validation suite
- [x] 2. MVP deploy
- [x] 3. Interactive editor
- [x] 4. Full results view
- [x] 5. IS 800:2007 design check
- [x] 6. Example library
- [x] 7. Export (PDF / JSON / URL)
- [x] 8. Polish
- [x] Final docs & deliverables
- [x] Self-review on live site
- [x] Stretch features: modal analysis, influence lines
- [x] 3D space structures: truss, beam, plate and solid elements, workspace, validation
