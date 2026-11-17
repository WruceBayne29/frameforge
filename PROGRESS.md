# Progress

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
