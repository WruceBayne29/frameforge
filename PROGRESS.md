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
- `src/design-codes/`: IS 800:2007 member check + ISMB/ISMC section table (done early, by subagent;
  not wired into the UI yet).

## In progress
- Milestone 2: MVP UI + first deploy.
- Subagent writing docs/THEORY.md, CONTRIBUTING.md, issue templates (uncommitted until it reports).

## Exact next step
- Write `src/model/` (project model in kN/m/GPa/cm units → solver model), `src/examples/`, and a
  basic `src/ui/` that loads an example and draws deformed shape + BMD/SFD. Push, confirm the
  Pages deploy at https://wrucebayne29.github.io/frameforge/ loads.

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
