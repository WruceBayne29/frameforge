# FrameForge — build plan

Browser-based 2D structural analysis (direct stiffness method) + IS 800:2007 steel checks.
TypeScript + React + Vite, no backend, deployed to GitHub Pages.

## Architecture

```
src/
  solver/         pure TS, no React/DOM. Direct stiffness method, fully unit-tested.
  design-codes/   pure TS. IS 800:2007 member checks + ISMB/ISMC section table.
  model/          app-level project model (units, sections), conversion to solver model.
  examples/       preloaded structures.
  io/             JSON save/load, URL share codec, PDF report.
  ui/             React components (canvas editor, tables, results, panels).
tests/            validation suite (textbook problems vs closed-form answers).
docs/             THEORY.md, screenshots.
scripts/          Playwright screenshot / smoke scripts.
```

Units in the UI: kN, m, kN·m; E in GPa, A in cm², I in cm⁴. The solver is unit-agnostic
(consistent units); `model/` converts.

## Milestones

1. **Solver core** — truss + frame elements, assembly, supports, nodal loads, member UDL /
   point / moment loads, end releases, settlements, springs. Outputs: displacements, reactions,
   member end forces, N/V/M + deflection along members. Validation suite (≥10 textbook
   problems, ≤0.1% error) → `VALIDATION.md`.
2. **MVP deploy** — UI loads examples, shows deformed shape + BMD/SFD. README with live link.
   GitHub Actions CI + Pages deploy. Verify it loads.
3. **Interactive editor** — canvas: add nodes/members/supports/loads, snap-to-grid, undo/redo,
   edit-by-table.
4. **Results view** — deformed shape + scale slider, N/V/M diagrams, reaction arrows, hover tooltips.
5. **Design check** — IS 800:2007 axial + bending interaction, ISMB/ISMC table, utilisation colours.
6. **Example library** — 6+ structures incl. transmission-tower truss.
7. **Export** — PDF report, JSON save/load, shareable URL.
8. **Polish** — dark/light, responsive, keyboard shortcuts, onboarding tour.

## Final deliverables

README (screenshots/GIF, features, theory, validation table, Mermaid architecture, roadmap),
docs/THEORY.md, LINKEDIN_POST.md, CV_BULLETS.md, MIT LICENSE, CONTRIBUTING.md, issue templates.

## Finish

Self-review on the live site with Playwright; fix bugs. Stretch: influence lines, modal
analysis, 3D space frames.

## Working rules

- Update PROGRESS.md after every meaningful step. Small commits, pushed often.
- `npm run check` (lint + tests + build) before every commit.
- Decisions → DECISIONS.md. Things needing the owner → BLOCKERS.md.
