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
18. **Axial forces that are constant along a member are drawn on the member itself** (colour = sign,
    thickness = magnitude) instead of as offset bands, which overlap unreadably in a truss.
19. **Modal analysis uses member self-weight only** (steel density × area) and subdivides frame
    members (6 / 3 / 1 elements depending on model size) so higher modes are accurate. All eigenvalues
    come from a cyclic Jacobi solve — simple and robust at these sizes (≤ a few hundred DOF).
20. **Influence lines run one full analysis per load position** rather than reusing the factorised
    stiffness. It is the definition, it is exact at each sampled point, and it is fast enough here.
    The default load path is the near-horizontal members.
21. **3D space frames were not attempted in the first build.** They needed a new element, viewer
    and editor. They were added later on the `feat/3d-space-structures` branch, together with
    plates and solids — see decisions 22–35.

### 3D workspace (branch `feat/3d-space-structures`)

Built to the brief "support any 3D structure with truss (2-node, 6 DOF), beam (2-node, 12 DOF),
plate (4-node) and solid (8-node) elements; loads: UDL, point load on nodes, point load on
members".

22. **A separate 3D workspace, not a 3D mode of the 2D editor.** A 2D | 3D switch in the top bar;
    each workspace keeps its own model, file format and share-link key (`#s=` vs `#m=`). The 2D
    solver and its validation suite are unchanged; the 2D UI only gained the switch and an
    "Open in 3D" command. The 3D workspace (three.js + solver) is a lazily loaded chunk, so the 2D
    first load does not grow.
23. **Y-up global axes, six DOFs per node.** The 2D XY plane becomes the z = 0 plane, so
    "Open in 3D" converts a 2D model without rotating it, and gravity is −Y in both workspaces.
24. **Member local axes by the "web up" rule plus a roll angle β** (local z = x × Y for
    non-vertical members, local z = Z for vertical ones). This is what STAAD-style tools do and it
    makes a horizontal member's strong axis (Iz) carry gravity by default.
25. **Euler–Bernoulli beams, as in 2D, and any of the six end forces releasable** by static
    condensation. Keeps one beam theory across both solvers (a planar 3D model reproduces the 2D
    results to 1e-8, test-enforced).
26. **Plate = MITC4 bending + QM6 membrane + a drilling penalty (γ = 10⁻³·G·t).** MITC4 has no
    shear locking down to a/t = 1000 and passes the bending patch test; QM6 removes membrane shear
    locking and passes the membrane patch test; the drilling penalty is rigid-body invariant, so
    coplanar meshes need no fictitious springs. Warped quads are projected flat with a warning
    rather than corrected with rigid links.
27. **Solid = 8-node hexahedron with modified (Taylor–Beresford–Wilson) incompatible modes.**
    Plain bricks lock in bending; 20-node bricks would need a mid-side-node editor. The modified
    form passes the patch test on distorted meshes.
28. **Sparse skyline LDLᵀ with reverse Cuthill–McKee numbering, written in-house,** instead of the
    2D dense Cholesky or a sparse-matrix library. Plate and solid meshes reach thousands of
    equations; the profile solver keeps memory proportional to the profile and gives the sign of
    every pivot for mechanism detection. The solve runs on the main thread (≈ 0.5 s for ≈ 5,600
    equations); a Web Worker was not needed at the model sizes of the examples.
29. **Unexcited mechanisms are held with a warning, excited ones are errors** (extends decision 7
    to 3D). A singular pivot is restrained during factorisation and the holding force decides:
    a beam on two pins spinning about its axis is held; a loaded mechanism names the node and DOF.
30. **One load case, no 3D PDF report, design check, modal analysis or influence lines.** The brief
    asked for the elements and load types; these 2D features would each need a 3D counterpart
    (biaxial bending interaction, 3D mass matrices, moving-load paths in space).
31. **Torsion constant of rolled ISMB / ISMC sections from Σ b·t³/3** (flanges + clear web,
    fillets ignored). The section table has no J; the formula is slightly conservative (lower J).
32. **Solids are created only by the block generator.** A click-to-draw hexahedron tool is error
    prone (eight nodes in the right order); the generator covers footings, blocks and walls.
33. **The 3D validation suite has a tolerance per case, shown in the table.** Line elements are
    exact, so 0.1 % as in 2D. Plate and solid benchmarks compare a mesh with a continuum
    solution, so each case states the tolerance its mesh should meet (0.5–2 %); tolerances were
    set before the run and not adjusted to make a case pass.
34. **Clamped-plate centre moment taken as 0.02291·qa² (Taylor & Govindjee 2004)**, not the
    0.0231 tabulated by Timoshenko & Woinowsky-Krieger. An independent Ritz solution
    (Legendre-polynomial basis, converged to 5 digits) gave 0.02291 and w = 0.0012653·qa⁴/D, so
    the tabulated value is about 0.8 % high. FrameForge's 16 × 16 mesh is within 0.43 % of 0.02291.
35. **The solid patch test uses a distorted 3 × 3 × 3 mesh, not the 7-element MacNeal–Harder
    mesh.** With the published interior-node coordinates one of the seven elements has a negative
    Jacobian determinant at one corner (positive at all Gauss points), and FrameForge rejects any
    element whose Jacobian is not positive at its corners. The check was left as it is; the
    MacNeal–Harder strain field and material are used on a mesh FrameForge accepts.
