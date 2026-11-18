# Bringing your own model into FrameForge

FrameForge runs entirely in the browser, so there is no server API. Instead there are five ways
in for nodes, members, supports and loads produced by other software. All of them feed one
documented, validated format: the same checks a saved `.json` project goes through.

| Route | Best for |
| --- | --- |
| [Tables / CSV](#2-tables-csv) in the **Import** dialog | Excel, and any program that can export a table |
| [STAAD.Pro `.std` files](#3-staadpro-std-files) | Models already built in STAAD |
| [`?model=` URLs](#4-load-by-url-model) | Links that open a model straight away |
| [JavaScript API and `postMessage`](#5-javascript-api-and-postmessage) | Embedding FrameForge in another page; scripting |
| [Command line](#6-command-line-headless-analysis) | Running analyses from other programs, with no browser |

Try it on the live site with the bundled samples:
[portal frame (STAAD)](https://wrucebayne29.github.io/frameforge/?model=samples/portal-frame.std),
[space frame, SET Z UP (STAAD)](https://wrucebayne29.github.io/frameforge/?model=samples/space-frame-zup.std),
[Warren truss (CSV bundle)](https://wrucebayne29.github.io/frameforge/?model=samples/warren-truss.csv),
[cantilever (JSON)](https://wrucebayne29.github.io/frameforge/?model=samples/cantilever.json).
The files are in [`public/samples`](../public/samples).

## 1. The model format (JSON)

[`docs/model.schema.json`](model.schema.json) is a JSON Schema (draft 2020-12) of the format.
Every field has its units in the schema. FrameForge writes this format when you press **Save**,
and older saved files keep loading.

Units: **kN, m, kN·m**. E is in GPa, section area in cm², second moments of area and the
torsion constant in cm⁴, plate thickness in mm, weight density in kN/m³ and angles in degrees.
Global axes are right-handed with **Y up**. Loads are positive along the + axis, so gravity loads
are negative Y.

Only `nodes` and `members` (or `plates` / `solids`) are needed. Everything else has a default.
Other software can leave out `format`, `version` and `kind`.

```json
{
  "name": "Portal frame",
  "plane": "XY",
  "nodes": [
    { "id": "1", "x": 0, "y": 0 },
    { "id": "2", "x": 0, "y": 4 },
    { "id": "3", "x": 6, "y": 4 },
    { "id": "4", "x": 6, "y": 0 }
  ],
  "members": [
    { "id": "C1", "i": "1", "j": "2", "section": "ISMB 300" },
    { "id": "B1", "i": "2", "j": "3", "section": "ISMB 400" },
    { "id": "C2", "i": "3", "j": "4", "section": "ISMB 300" }
  ],
  "supports": [
    { "node": "1", "restraints": "fixed" },
    { "node": "4", "restraints": "fixed" }
  ],
  "loads": [
    { "kind": "nodal", "node": "2", "fx": 10 },
    { "kind": "distributed", "member": "B1", "direction": "globalY", "w1": -20 }
  ]
}
```

| Item | Fields |
| --- | --- |
| node | `id`, `x`, `y`, `z` (m; `z` defaults to 0) |
| member | `id`, `i`, `j` (node ids), `section`, `type` (`beam` default, or `truss`), `material`, `beta` (roll angle, °), `releaseI` / `releaseJ` (e.g. `{ "my": true, "mz": true }`), `kz` / `ky` (IS 800 effective length factors) |
| section | a built-in `ISMB …` / `ISMC …` designation, or the `name` of a `customSections` entry: `{ name, A (cm²), Iz (cm⁴, major axis), Iy (cm⁴), J (cm⁴) }` |
| material | `{ name, E (GPa), nu, density (kN/m³) }`. Defaults: Steel (200 GPa, 0.3, 77) and Concrete M25 (25 GPa, 0.2, 25). An element without a material uses the first one |
| plate | `id`, four `nodes` (counter-clockwise from the +z side), `thickness` (mm), `material` |
| solid | `id`, eight `nodes` (1–4 one face, 5–8 the opposite face), `material` |
| support | `node`, `restraints`: six booleans `[ux, uy, uz, rx, ry, rz]`, `"fixed"`, `"pinned"`, `"roller"` (uy only), a mask such as `"110001"`, or `{ "uy": true, … }` |
| load | `kind`: `nodal` (`fx fy fz` kN, `mx my mz` kN·m), `distributed` (`direction`, `w1`, optional `w2`, `a`, `b`), `point` (`direction`, `P`, `a`), `moment` (`direction`, `M`, `a`), `pressure`, `platePoint`, `face`. Targets go in `nodes` / `members` / `plates` / `solids` (a list), or `node` / `member` / … (one id) |
| other | `plane: "XY"` (plane-frame mode: every z must be 0), `selfWeight: true`, `design` (IS 800 settings), `masses` (t, for modal analysis) |

Member load `direction` is `globalX/Y/Z` (per unit length of the member) or `localX/Y/Z`
(member axes). With `beta = 0`, local x runs from i to j, local z is horizontal and local y
points up. For a vertical member, local z is global Z.

## 2. Tables (CSV)

Click **Import**, choose **Tables (CSV)**, and paste each table or load it from a file. You can
copy cells straight from Excel (tab separated). The dialog shows the row counts and any errors
with their table and line number. **Import** then creates a new model; Undo returns to the
previous one.

| Table | Columns (aliases in brackets) |
| --- | --- |
| Nodes | `id` (node, joint, name), `x`, `y`, `z` (optional) |
| Members | `id` (member, element, beam), `i` (start, node_i, n1, from), `j` (end, node_j, n2, to), `section` (profile, property), `type` (beam / frame, truss / bar), `material`, `beta` (angle, roll), `release_i`, `release_j`, `kz`, `ky` |
| Supports | `node`, then `type` (fixed, pinned, roller, or a mask such as `111000`) **or** columns `ux uy uz rx ry rz` with 1/0 or yes/no |
| Nodal loads | `node`, `fx fy fz mx my mz` (blank = 0) |
| Member loads | `member`, `type` (udl, linear / trap, point / con, moment), `direction` (GX GY GZ global, X Y Z member axes), `w1` (value, w, p), `w2`, `a` (d1, start), `b` (d2, end) |
| Sections | `name`, `A`, `Iz`, `Iy`, `J` |
| Materials | `name`, `E`, `nu` (poisson), `density` (gamma, unit weight) |

Reading rules:

- **Separators.** Comma, tab, semicolon or spaces are detected from the first line. With tab
  or semicolon separators, decimal commas (`2,5`) are accepted. Cells may be `"quoted"`.
  Blank lines and lines starting with `#` or `//` are ignored.
- **Headers** are matched loosely: case, spaces, `_` and units in brackets are ignored, so
  `Node I (m)` matches `i`. A table with no recognisable header (the first row has numbers) is
  read in the column order above, and a warning says so.
- **Units.** Choose m or mm and kN or N. Every value follows that choice: lengths, forces,
  kN/m or N/mm for line loads, kN·m or N·mm for moments, m² or mm² for areas, m⁴ or mm⁴ for
  inertias, kN/m² or N/mm² for E, kN/m³ or N/mm³ for density. A column can name its own unit
  instead: `x (mm)`, `A_cm2`, `Iz [mm4]`, `E_GPa`, `E_MPa`, `density kN/m3`.
- Member `section` is a built-in `ISMB 300` / `ISMC 200` (also written `ISMB300`) or a name
  from the Sections table. A member with no section uses ISMB 300, and a warning says so.
- Releases are listed by component: `mz`, `my mz`, `My+Mz`, or `pinned` (= My and Mz).
- Point and moment loads need `a`. `linear` loads need `w2`. Positions must lie on the member.
- **Plane frames.** When every node has z = 0 and no load acts out of plane, the model opens
  in plane-frame mode. The Model setting overrides this: plane frame or 3D.

### CSV bundles

A **CSV bundle** puts all the tables in one text file, each under a `[heading]`. It is what
`?model=`, **Open** and the command line read. A `[settings]` table can set `length` (m / mm),
`force` (kN / N), `name`, `plane` (auto / XY / none) and `selfweight` (yes / no).

```text
[settings]
length,mm
force,kN
name,Warren truss

[nodes]
id,x,y
1,0,0
2,3000,0
3,1500,2500

[members]
id,i,j,section,type
B1,1,2,ISMC 150,truss
D1,1,3,ISMC 125,truss
D2,3,2,ISMC 125,truss

[supports]
node,type
1,pinned
2,roller

[nodal loads]
node,fy
3,-40
```

Headings: `[nodes]`, `[members]`, `[supports]`, `[nodal loads]`, `[member loads]`,
`[sections]`, `[materials]`, `[settings]`. Line numbers in messages are line numbers of the
whole file.

## 3. STAAD.Pro `.std` files

Use **Open** on a `.std` file, or **Import → STAAD / file**. You can also paste the text. One
primary load case is imported. When the file has several, the dialog lets you choose which.

Supported commands:

| Command | Notes |
| --- | --- |
| `STAAD SPACE / PLANE / TRUSS` | PLANE opens in plane-frame mode. TRUSS makes every member a truss (plane mode when flat). FLOOR is read as a space frame |
| `SET Z UP` | Rotated so STAAD's Z becomes FrameForge's Y: (X, Y, Z) → (X, Z, −Y). Supports, loads and directions are mapped to match |
| `UNIT` | METER, CM, MMS, FEET, INCHES, KM; KN, NEWTON, KG, MTON, KIP, POUND, DNS, MNS. Can change anywhere; values are converted as they are read |
| `JOINT COORDINATES` | `i x y z`, `i x y` (z = 0), generation `i1 x1 y1 z1 i2 x2 y2 z2 [step]`, `REPEAT n dx dy dz …` (the previous line; a zero increment set repeats the previous set, `15*0` shorthand), `REPEAT ALL n dx dy dz` (everything since the last REPEAT ALL). New joints are numbered on from the highest joint so far |
| `MEMBER INCIDENCES` | `m i j`, generation `m i j m_last [m_step j_step]`, `REPEAT n m_inc j_inc`, `REPEAT ALL n m_inc j_inc` |
| `START / END GROUP DEFINITION` | Groups (`_NAME`) can be used in any list |
| `DEFINE MATERIAL` | ISOTROPIC name with E, POISSON, DENSITY |
| `CONSTANTS` | `E`, `POISSON`, `DENSITY` (a value or a material name), `MATERIAL name`, `BETA angle`, with `ALL` / `MEMB list`. STEEL, CONCRETE and ALUMINUM are built in |
| `MEMBER PROPERTY` | `TABLE ST ISMB…/ISMC…` (built-in table), `PRIS YD ZD` (rectangle), `PRIS YD` (circle), `PRIS AX IX IY IZ` (explicit) |
| `MEMBER RELEASE` | `START / END / BOTH` with FX…MZ |
| `MEMBER TRUSS` | Truss members |
| `SUPPORTS` | `FIXED`, `PINNED`, `FIXED BUT FX … MZ` |
| `LOAD n` | `JOINT LOAD`; `MEMBER LOAD` with `UNI`, `CON`, `CMOM`, `LIN` (incl. the mid-span triangle), `TRAP` in local X/Y/Z, global GX/GY/GZ and projected PX/PY/PZ; `SELFWEIGHT` |
| Lists | `1 2 5 TO 9 BY 2`, `ALL`, `_GROUP`, `-` continuation lines, `;` separators, `*` comments |

Anything else becomes a warning and never stops the import. That includes plates and solids
(`ELEMENT …`), offsets, partial and spring releases, spring and enforced supports, floor and
area loads, temperature loads, load combinations, design parameters and analysis commands.
Some details to check after importing:

- A `TABLE ST` section that is not ISMB / ISMC (e.g. `W12X26`), or any other `TABLE` type,
  uses ISMB 300 with a warning. Change it in the editor.
- `SELFWEIGHT Y -1` (Z with SET Z UP) turns on self-weight. Any other factor or direction, or a
  member list, becomes member line loads of factor × density × area.
- `CON` / `CMOM` without a distance act at mid-span.
- Load offsets (the perpendicular distance d3) are ignored, with a warning.
- With SET Z UP, member local axes follow FrameForge's Y-up rule. For vertical members this can
  flip the sign of local Y / Z loads and of BETA compared with STAAD. A warning appears when
  BETA is used in such a file.

## 4. Load by URL: `?model=`

```text
https://wrucebayne29.github.io/frameforge/?model=https://raw.githubusercontent.com/you/repo/main/frame.std
```

FrameForge fetches the file when the page loads. It detects the format from the extension
(`.json`, `.std`, `.csv`) or the content, imports it like the dialog does, and removes `model=`
from the address, so a reload keeps your edits. `&format=std|csv|json` forces a format.

- The address must be `https://` or a file on the FrameForge site itself, such as
  `?model=samples/portal-frame.std`.
- **CORS:** the browser only lets FrameForge read the file if the server allows cross-origin
  requests. GitHub raw files (`raw.githubusercontent.com`) and Gists do. If a fetch is
  blocked, a message says so. Download the file and use Import instead.
- If the model has errors, the Import dialog opens with the file so you can see them all.

## 5. JavaScript API and postMessage

### In the page: `window.frameforge`

For scripts in the page, browser automation (Playwright, Selenium) or the developer console:

```js
const report = frameforge.importStd(stdText, { loadCase: 1 });
// → { name, format: 'std', counts: { nodes, members, … }, plane, warnings: [...] }

frameforge.importCsv(
  {
    nodes: 'id,x,y\n1,0,0\n2,4,0',
    members: 'id,i,j,section\nM1,1,2,ISMB 300',
    supports: 'node,type\n1,fixed',
    nodalLoads: 'node,fy\n2,-10',
  },
  { units: { length: 'm', force: 'kN' }, name: 'Cantilever' },
);

const results = frameforge.analyze(); // results JSON, see below
results.reactions['1'].mz; // 40 (kN·m)

frameforge.load(modelObjectOrJsonText); // the JSON format of section 1
frameforge.importText(anyText, { filename: 'frame.std' }); // any format, detected
frameforge.getModel(); // the current model as a plain object (the saved-file format)
```

| Method | Options |
| --- | --- |
| `load(model)` | — |
| `importCsv(tables \| bundleText, options)` | `units: { length: 'm' \| 'mm', force: 'kN' \| 'N' }`, `name`, `plane: 'auto' \| 'XY' \| 'none'`, `selfWeight` |
| `importStd(text, options)` | `loadCase`, `plane`, `name` |
| `importText(text, options)` | `format`, `filename`, `units`, `plane`, `loadCase`, `name` |
| `analyze(options)` | `stations: true` adds internal forces along every member |
| `getModel()` | — |

Each import replaces the current model, which stays one Undo away. A model with errors throws a
`FrameForgeImportError`. Its `errors` property lists every problem, for example
`["nodes line 3: Node \"2\" needs numeric x, y and z."]`. `analyze()` throws when the model
cannot be analysed (e.g. a mechanism).

### From an embedding page: `postMessage`

Put FrameForge in an `<iframe>` and send it messages:

```html
<iframe id="ff" src="https://wrucebayne29.github.io/frameforge/"></iframe>
<script>
  const ff = document.getElementById('ff').contentWindow;
  window.addEventListener('message', (e) => {
    if (e.data?.frameforge === 'ready') {
      ff.postMessage({ frameforge: 'importStd', id: 1, text: stdText }, '*');
      ff.postMessage({ frameforge: 'analyze', id: 2 }, '*');
    }
    if (e.data?.frameforge === 'result') console.log(e.data.id, e.data.ok, e.data.result ?? e.data.errors);
  });
</script>
```

- **Requests:** `{ frameforge: command, id?, …input, options? }`. The command is one of
  `load` (`model`), `importCsv` (`tables`: object or bundle text), `importStd` (`text`),
  `importText` (`text`), `analyze` and `getModel`.
- **Replies:** `{ frameforge: 'result', id, ok, result | error, errors? }`, sent back to the
  sender's origin. When it is ready, FrameForge posts `{ frameforge: 'ready', version: 1 }` to
  its parent (or opener).
- **Restrictions:** only the parent page (or the page that opened FrameForge) is listened to,
  and messages of any other shape are ignored. Messages over 20 MB are dropped.
  `analyze` and `getModel` are only answered after that page has loaded a model itself, so a
  page that frames FrameForge cannot read a model the visitor made or opened.

## 6. Command line (headless analysis)

`scripts/analyze.ts` runs the same importers and solver in Node, with no browser. It accepts
JSON, a CSV bundle or a `.std` file and prints results JSON:

```bash
npx tsx scripts/analyze.ts public/samples/portal-frame.std > results.json
npm run --silent analyze -- frame.csv --length mm --force N --stations
cat model.json | npx tsx scripts/analyze.ts - --compact
```

| Option | Meaning |
| --- | --- |
| `--format json\|csv\|std` | Force the input format |
| `--length m\|mm`, `--force kN\|N` | CSV units (override a bundle's `[settings]`) |
| `--load-case N` | STAAD load case |
| `--plane auto\|XY\|none` | Plane-frame mode |
| `--name NAME` | Model name |
| `--stations` | Include internal forces along every member |
| `--model` | Print the imported model (FrameForge `.json`) instead of results, to convert a file |
| `--compact` | One-line JSON |
| `-o FILE` | Write to a file |

Warnings and errors go to stderr. Exit codes: **0** analysed, **1** bad usage or unreadable
file, **2** the model has errors, **3** the model cannot be analysed. Use `npm run --silent`
(or `npx tsx` directly) so npm's own banner does not end up in the JSON.

## 7. Results JSON

`analyze()`, the `analyze` message and the command line all return the same format. Values are
in kN, m, kN·m and rad:

```jsonc
{
  "format": "frameforge-results",
  "version": 1,
  "units": { "force": "kN", "length": "m", "moment": "kN·m", "rotation": "rad", "stress": "kN/m²" },
  "model": { "name": "PORTAL FRAME", "plane": true, "nodes": 4, "members": 3, "plates": 0, "solids": 0 },
  "warnings": [],
  "maxDisplacement": 0.005066,
  "appliedLoad": [10, -120, 0],
  "equilibrium": [0, 0, 0, 0, 0, 0], // Σ loads + reactions; ~0
  "displacements": { "2": { "ux": 0.001982, "uy": -0.0001976, "uz": 0, "rx": 0, "ry": 0, "rz": -0.002123 } },
  "reactions": { "1": { "fx": 7.489, "fy": 56.99, "fz": 0, "mx": 0, "my": 0, "mz": -5.614 } },
  "members": {
    "2": {
      "length": 6,
      "start": { "N": -17.49, "Vy": 56.99, "Vz": 0, "T": 0, "My": 0, "Mz": -24.34 },
      "end": { "N": -17.49, "Vy": -63.01, "Vz": 0, "T": 0, "My": 0, "Mz": -42.41 },
      "endForces": [/* [Fx, Fy, Fz, Mx, My, Mz] at i, then at j: forces of the joints on the member, local axes */],
      "max": { "Nmax": -17.49, "Nmin": -17.49, "Vy": -63.01, "Vz": 0, "T": 0, "My": 0, "Mz": 56.85, "deflection": 0.004467 }
    }
  },
  "plates": { "P1": { "maxVonMises": 12345 } },
  "solids": {},
  "import": { "format": "std", "warnings": ["…"] } // command line only
}
```

The numbers are those of `public/samples/portal-frame.std` (load case 1: beam 2 carries
20 kN/m and joint 2 a 10 kN sway load), rounded to 4 figures. Only some nodes and members
are shown.

Member forces use the app's convention, in member axes:

- `N` is axial force, positive in tension.
- `Vy` and `Vz` are shear forces, so that dMz/dx = Vy and dMy/dx = Vz.
- `Mz` is bending in the local x–y plane and `My` bending in the x–z plane, positive when the
  member curves towards +y / +z. So a sagging beam has positive `Mz`, and the fixed end of a
  cantilever with a downward tip load has negative `Mz`.
- `T` is torque.

In `max`, `Nmax` and `Nmin` are the algebraic largest and smallest axial forces (both are
negative for a member in compression throughout). The other entries are the signed value
where the magnitude is largest.
