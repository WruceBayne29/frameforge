# CV bullets

Four bullets with numbers taken from the repository. Each number can be reproduced:
tests and coverage from `npm run coverage`, validation from `VALIDATION.md` and
`VALIDATION_3D.md`, end-to-end checks from `npm run e2e`.

**FrameForge — browser-based structural analysis tool (3D and plane frames)** · TypeScript, React, Vite,
three.js · [live demo](https://wrucebayne29.github.io/frameforge/) ·
[source](https://github.com/WruceBayne29/frameforge)

- Specified and shipped an open-source structural analysis web app with **four finite elements
  written from scratch** — 6-DOF truss, 12-DOF space-frame beam, 4-node MITC4 flat shell and
  8-node incompatible-mode solid — and a sparse skyline solver (≈ 5,600 equations in about 0.5 s
  in the browser); validated against **27 3D problems (125 quantities)**, including the Navier
  plate, clamped plate and Scordelis–Lo shell benchmarks.
- Unified a former 2D app into the 3D one with a **plane-frame mode** that reproduces the 2D
  solver to **10⁻⁸ at every station** and passes **26 textbook problems (122 quantities) to
  within 0.1%**; old 2D files, share links and autosaves migrate automatically. **1,363
  automated tests, over 99% solver coverage.**
- Added limit-state steel design to **IS 800:2007** for space-frame members (biaxial bending,
  buckling about both axes, lateral-torsional buckling, shear in both directions) over **25
  ISMB/ISMC sections**, plus **modal analysis** (consistent mass matrices, subspace iteration)
  and **influence lines** (one factorisation, many load positions), all in a generated vector
  **PDF calculation report**.
- Delivered a three.js editor (drawing tools, generators, live results while dragging,
  undo/redo, edit-by-table, shareable URLs) deployed through a **GitHub Actions CI/CD pipeline**
  to GitHub Pages and verified by a **142-check Playwright end-to-end suite**.

## A note on wording

The implementation was written by an AI coding agent (Claude Code) working from your
specification, so the bullets say "specified and shipped", "added" and "delivered" rather than
"hand-wrote". That wording is accurate and still strong. If an interviewer asks, the honest
answer — "I defined the scope, the milestones and the validation bar, and directed an AI agent to
build it; here is how the solver works" — is a good one, provided you can explain the method.
`docs/THEORY.md` covers the direct stiffness method and the IS 800 checks, and
`docs/THEORY_3D.md` the 3D elements, mass matrices, the eigen solver and influence lines. The 3D elements (MITC4, incompatible modes) are graduate-level
finite-element material: read that document before you put the 3D bullet on a CV, and be ready to
say what shear locking is and why the patch test matters.

Shorter variants, if space is tight:

- Built FrameForge, an open-source browser-based structural analysis tool for 3D frames,
  trusses, plates and solids, validated against 53 textbook problems and FE benchmarks.
- Plane-frame mode reproduces a 2D direct stiffness solver to 10⁻⁸; 26 problems within 0.1%.
- IS 800:2007 biaxial steel checks, modal analysis, influence lines and PDF reports.
- Shipped with CI/CD to GitHub Pages, 1,363 tests and over 99% solver coverage.
