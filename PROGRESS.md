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

## In progress
- Milestone 2/3: MVP UI is rendering (canvas, diagrams, deformed shape, reactions, examples,
  undo/redo, theme). Editing tools exist in `src/ui/Canvas.tsx` but have no toolbar yet.

## Exact next step
- Confirm the Pages deploy loads. Then add `src/ui/Toolbar.tsx` (tool buttons + tool options),
  `src/ui/SidePanel.tsx` (Properties / Tables / Results / Design tabs) and keyboard shortcuts.

## Milestone checklist
- [x] 1. Solver core + validation suite
- [ ] 2. MVP deploy
- [ ] 3. Interactive editor
- [ ] 4. Full results view
- [ ] 5. IS 800:2007 design check
- [ ] 6. Example library
- [ ] 7. Export (PDF / JSON / URL)
- [ ] 8. Polish
- [ ] Final docs & deliverables
- [ ] Self-review on live site
- [ ] Stretch features
