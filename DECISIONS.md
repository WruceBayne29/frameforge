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

### One 3D app (branch `feat/3d-only`)

36. **Plane frame mode is a project setting, not a separate solver.** `plane: 'XY'` adds the
    restraint uz = rx = ry = 0 at every node of the solver model, so plane frames run through
    the same 3D solver users run for everything else. The restraint is not stored as supports
    and `analyzeProject3D` drops it from the reactions; out-of-plane loads trigger a warning.
    The 2D solver stays in the repo only as a test reference. Agreement is checked at every
    station to 1e-8 relative; for the two portal cases that idealise members as axially rigid
    (A = 10⁴ m², axial/bending stiffness ratio ~10⁹) round-off limits agreement to ~10⁻⁷, so
    the test scales the tolerance by 10⁻¹⁵ × that ratio instead of hiding the cases.
37. **`from2D` gives steel a weight density of 7.85 t/m³ × 9.80665 = 76.98 kN/m³.** The 2D
    app's modal analysis used 7.85 t/m³; matching it makes converted frequencies identical.
    New 3D models keep 77 kN/m³.
38. **Node dragging only in plane frame mode.** In 3D a screen drag has no unique plane to move
    on; in plane mode it moves over z = 0 with the snap grid, one undo step per drag.
39. **The 3D design check extends `checkMember` instead of adding a second function.** New
    inputs are optional and every minor-axis term is exactly zero without them, so a plane
    frame gets bit-identical 2D results and there is one implementation to maintain.
40. **Minor-axis plastic modulus from the idealised section** (parallel flanges of the mean
    thickness, fillets ignored), because the ISMB / ISMC table has no Zpy. For I-sections the
    1.2·Zey·fy/γm0 limit of cl. 8.2.1.2 governs anyway (Zpy/Zey ≈ 1.5–2).
41. **Simplified linear interaction (cl. 9.3.1.1 "alternatively") for the section check**,
    N/Nd + My/Mdy + Mz/Mdz ≤ 1, as in the 2D app. Conservative; avoids Mnd and the α exponents.
42. **One project K per axis plus member overrides; the lateral-torsional buckling length uses
    K about y-y** (the compression flange buckles sideways). `from2D` copies the single 2D K to
    both axes, so converted examples keep their 2D design results.
43. **Design demands are the largest values along each member** (|N|, |Mz|, |My|, |Vy|, |Vz|),
    not the concurrent values at one section — conservative, and how the 2D app worked.
44. **Subspace iteration, not Lanczos, for the 3D eigenproblem.** It reuses the skyline
    factorisation, needs no reorthogonalisation bookkeeping and is easy to verify. Each step
    M-orthonormalises the vectors before the Rayleigh–Ritz projection (with an unfactorised
    copy of K), which keeps the small problem well conditioned; when many members have nearly
    the same local frequency (the braced-frame example has a cluster of 9+ within 0.2 %), the
    subspace is widened by 8 vectors at a time, up to 120, so the iteration does not stall.
45. **Torsional inertia uses the polar moment Ip = Iy + Iz; rotary inertia of bending is
    neglected** (Euler–Bernoulli, consistent with the stiffness and the 2D app).
46. **A (near-)zero-frequency mode is an error, not a result.** It means a mechanism the
    static factorisation did not flag (round-off pivot), e.g. a slab spinning in its own plane
    against only its drilling stiffness. This check exposed exactly that in the "Simply
    supported slab" example (the second in-plane support restrained X along the X edge); the
    example now restrains Z there. Static results under vertical load are unchanged.
47. **VALIDATION_3D case M04 tolerance (2 %) was set after the first run** — the only
    tolerance not fixed in advance: the second plate mode on the 16 × 16 mesh came out 1.4 %
    high while the fundamental is within 0.3 %. Stated in the case and here.
48. **3D influence lines reuse one factorisation** (decision 20 is superseded for 3D): each
    load position only adds the moving load's equivalent nodal loads on one member and one
    forward/back substitution, so a 13-point line over dozens of members costs about one
    analysis. Ordinates are checked against full static analyses in the tests.
49. **The UI folder stays `src/ui3d`.** Renaming it to `src/ui` after deleting the 2D UI would
    touch every import for no functional gain; it is the only UI now.
50. **Start-up migration of two autosaves.** When a visitor has both a 2D and a 3D autosave,
    the model of the workspace they used last opens and the other is loaded underneath it, so
    one Undo brings it back; a toast says which. Nothing is silently dropped.
51. **Plane-frame trusses draw constant axial force on the members** (decision 18, ported):
    offset bands overlap unreadably in a 2D truss. In 3D the bands stay, because their plane
    (local x–y) is what shows which way a member is loaded in space.

### Bring your own model (branch `feat/model-import`)

52. **"API" means input routes into the static site, all ending in one validation.** CSV
    tables, CSV bundles, STAAD files, `?model=`, `window.frameforge`, postMessage and the CLI
    all build a `Project3D` and then run it through `parseProject3D` (via a serialise / parse
    round trip), exactly like opening a saved file. There is no second, looser path.
53. **The interchange JSON is the saved-file format, with a few shortcuts** instead of a new
    format: `format` / `version` / `kind` optional; member `type` defaults to `beam`; supports
    take `"fixed"` / `"pinned"` / `"roller"`, a mask such as `"111000"` or `{ ux: true, … }`;
    loads take a single `node` / `member` / … id. Old files are unaffected (tested), and
    `docs/model.schema.json` is checked against every built-in example and the shortcuts with
    Ajv in the tests.
54. **Untagged JSON is read as 3D unless it is obviously a 2D file.** Previously any file
    without `kind: "space"` (and without plates / solids / materials) was assumed to be from the
    former 2D app. Saved 2D files always carry `format: "frameforge-project"`, so now only tagged
    files, or files whose members use the 2D-only `type: "frame"` or boolean releases, are
    converted. One expectation in `io3d.test.ts` (`{}` → 2D) changed for that reason; the
    tagged cases keep their old expectation.
55. **CSV values follow one unit system; headers can override per column.** Plain columns use
    the chosen length and force units consistently (mm and N ⇒ mm², mm⁴, N/mm² for E, N/mm³ for
    density), because that is what other programs export. `A_cm2`, `x (mm)`, `E_GPa` and similar
    override a column. Point and moment loads in the member-load table are forces and moments,
    not force per length.
56. **A header row is recognised only if it names a known column and holds no numbers.** This
    stops a data row such as `M1,N1,N2,…` from being taken as a header because `n1` is an
    alias of the start node. Tables without a header are read in the documented column order,
    with a warning.
57. **Member sections must resolve in CSV, but fall back in STAAD.** In tables an unknown
    section is an error with its line number (the user can add it to the sections table). STAAD
    files reference whole national tables (AISC, BS, …) that FrameForge does not have, so an
    unknown `TABLE ST` section becomes ISMB 300 with a warning naming it, to be changed in the
    editor, rather than blocking the import of an otherwise good model.
58. **STAAD joint REPEAT numbering: new joints continue from the highest joint so far, in the
    order of the repeated line.** Bentley's reference does not spell this out; it is the
    numbering of their own multi-storey examples. A zero increment set repeats the previous
    set, which is what Bentley's documented `REPEAT 10 0 12 0 15*0 0 10 0 9*0` example needs.
    `;` ends a line, so REPEAT after `1 0 0 0; 2 5 0 0` repeats only joint 2 (use REPEAT ALL).
59. **SET Z UP is a rotation (X, Y, Z) → (X, Z, −Y)**, applied to coordinates, restraints
    (FY↔FZ, MY↔MZ), joint loads and global / projected member-load directions. Member local
    axes then follow FrameForge's Y-up rule; for horizontal members that matches STAAD, for
    vertical members STAAD's Z-up rule may differ in the sign of local y / z, so a warning is
    shown when such a file uses BETA. Tested by importing the same frame written Y-up and Z-up.
60. **STAAD materials: one FrameForge material per distinct (E, ν, density)**, named after the
    STAAD material when E came from one (`MATERIAL STEEL`, `E STEEL`), otherwise `E 205 GPa`.
    A numeric E makes the material the member's own; a numeric POISSON or DENSITY keeps the name.
61. **STAAD self-weight:** `SELFWEIGHT Y -1` (Z with SET Z UP) maps to the self-weight switch;
    any other factor, direction or member list becomes member line loads of
    factor × density × area, so it is still exact for members.
62. **STAAD `CON` / `CMOM` without a distance act at mid-span**, and a triangular `LIN` load
    with a centre value is split into two linear pieces. Load offsets (d3) are ignored with a
    warning. One primary load case is imported (the first by default); combinations are warned
    about, not combined.
63. **postMessage is restricted by sender and by what may be read.** Only the parent frame or
    the opener is listened to, messages must have the documented shape (commands are an own-
    property allowlist — a test caught `"toString"` getting through an `in` check), and
    `analyze` / `getModel` are only answered after that page has loaded a model itself, so a
    page that frames FrameForge cannot read a visitor's own model. `window.frameforge` has no
    such limit: code in the page already has full access.
64. **`?model=` accepts https URLs and same-site paths only, and is removed after loading**, so a
    reload keeps the user's edits (the autosave) instead of re-importing. A blocked fetch says
    that the server must allow CORS. A model with errors opens the Import dialog with the text.
65. **The CLI is a tsx script, not a published `bin`.** The package is private and the solver
    imports use bundler resolution; `npx tsx scripts/analyze.ts` (or `npm run --silent analyze`)
    needs nothing beyond `npm install`. Exit codes separate usage (1), model errors (2) and
    analysis failures (3).
66. **Results JSON reports `Nmax` / `Nmin`, not "tension" / "compression".** The solver's
    `maxAxial` is the algebraic maximum (negative for a member in compression throughout), so
    the names say what the numbers are.
67. **The viewer's label layer is its own stacking context.** CSS2DRenderer gives every label
    a depth-based z-index, which drew labels over the Import (and Help) dialogs; `isolation:
    isolate` on the layer keeps them below.
