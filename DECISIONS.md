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
8. **SVG canvas, no canvas/WebGL library** — models are small (hundreds of members), SVG gives crisp
   text, CSS theming and easy hit-testing; pan/zoom is a manual world→screen transform.
9. **Single load case, no load combinations** — keeps the UI learnable; factored loads are entered
   directly. Load combinations are on the roadmap.
10. **Design check uses the analysis loads as design loads** and one steel grade / K factor per
    project. Members with custom sections are skipped (no Zp, r available).
11. **Examples assume laterally restrained compression flanges for beams/frames** (slab or purlins),
    and trusses use I/channel sections because the table has no angles. Tower X-bracing is connected
    at the crossing to halve buckling lengths. All examples pass their IS 800 check (test-enforced).
12. **Share links = deflate + base64url of the project JSON in the URL fragment** — nothing is sent
    to a server; the largest example fits in < 4000 characters.
13. **PDF via jsPDF with hand-drawn vector figures** (lazy-loaded chunk) instead of rasterising the
    SVG — sharper output and it works in Node, so the report is unit-tested.
14. **Loading an example / file is undoable** rather than guarded by a confirm dialog.
15. **The in-app browser could not open the public Pages URL** (site approval needed, owner AFK), so
    the live deploy is verified with curl and Playwright instead.
16. **LINKEDIN_POST.md and CV_BULLETS.md state that an AI coding agent wrote the implementation.**
    The brief asked for first-person copy; the repo history shows how it was built, so the copy says
    so plainly and uses "specified / shipped" rather than "hand-wrote". Edit if you disagree — but
    read the note at the top of each file first.
17. **README validation table is generated** by the validation test (`npm run validation`) between
    HTML comment markers, so it cannot drift from the suite.
