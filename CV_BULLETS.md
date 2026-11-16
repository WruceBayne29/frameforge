# CV bullets

Three bullets with numbers taken from the repository. Each number can be reproduced:
tests and coverage from `npm run coverage`, validation from `VALIDATION.md`, end-to-end checks
from `npm run e2e`.

**FrameForge — browser-based 2D structural analysis tool** · TypeScript, React, Vite ·
[live demo](https://wrucebayne29.github.io/frameforge/) ·
[source](https://github.com/WruceBayne29/frameforge)

- Specified and shipped an open-source 2D structural analysis web app (direct stiffness method,
  no FEM libraries) covering frames, trusses, end releases, modal analysis and influence lines;
  validated against **26 textbook problems (122 quantities) to within 0.1%**, with the solver
  at **99% test coverage** across 490 automated tests.
- Added limit-state steel design to **IS 800:2007** (tension, compression buckling,
  lateral-torsional buckling, shear, axial–bending interaction) over a built-in table of
  **25 ISMB/ISMC sections**, with per-member utilisation shown on the model and in a generated
  vector **PDF calculation report**.
- Delivered an interactive editor (snap-to-grid drawing, live results while dragging, undo/redo,
  edit-by-table, shareable URLs) deployed through a **GitHub Actions CI/CD pipeline** to GitHub
  Pages, verified by a **69-check Playwright end-to-end suite** run against the live site.

## A note on wording

The implementation was written by an AI coding agent (Claude Code) working from your
specification, so the bullets say "specified and shipped", "added" and "delivered" rather than
"hand-wrote". That wording is accurate and still strong. If an interviewer asks, the honest
answer — "I defined the scope, the milestones and the validation bar, and directed an AI agent to
build it; here is how the solver works" — is a good one, provided you can explain the method.
`docs/THEORY.md` covers everything you would be asked.

Shorter variants, if space is tight:

- Built FrameForge, an open-source browser-based structural analysis tool (direct stiffness
  method) validated against 26 textbook problems to within 0.1%.
- Implemented IS 800:2007 steel member checks with 25 rolled sections and PDF report export.
- Shipped with CI/CD to GitHub Pages, 490 tests and 99% solver coverage.
