# Progress

**Status:** IN PROGRESS

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

## In progress
- Self-review of the live site, then stretch features.

## Exact next step
- Stretch 1: modal analysis (`src/solver/modal.ts`: consistent mass matrix + generalised
  eigenproblem, validated against beam natural-frequency formulas) with a UI tab.
- Stretch 2: influence lines (`src/solver/influence.ts`) with a UI control.
- Then refresh metrics in README / CV_BULLETS / LINKEDIN_POST, re-run `npm run e2e`, mark COMPLETE.

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
- [ ] Self-review on live site
- [ ] Stretch features
