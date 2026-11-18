# Contributing to FrameForge

Thanks for your interest in FrameForge, a browser-based structural analysis tool — 3D space
frames, trusses, plates and solids, and plane frames — with a solver written from scratch. Bug reports, validation problems, new examples
and code are all welcome.

- Live demo: https://wrucebayne29.github.io/frameforge/
- Theory manuals: [docs/THEORY.md](docs/THEORY.md) (direct stiffness method on plane frames,
  IS 800) and [docs/THEORY_3D.md](docs/THEORY_3D.md) (the 3D elements, mass matrices, eigen
  solver, influence lines)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Getting set up

You need Node.js 22 or newer (the version CI uses) and npm.

```bash
git clone https://github.com/WruceBayne29/frameforge.git
cd frameforge
npm install
npm run dev
```

`npm run dev` starts the Vite dev server and prints a local URL.

| Command            | What it does                                                    |
| ------------------ | --------------------------------------------------------------- |
| `npm run dev`      | Start the dev server with hot reload                            |
| `npm test`         | Run all unit and validation tests once (Vitest)                 |
| `npm run coverage` | Run the tests with a coverage report and enforce the thresholds |
| `npm run lint`     | Lint with ESLint                                                |
| `npm run format`   | Format the code with Prettier                                   |
| `npm run check`    | Lint, test and build. Run this before every commit              |
| `npm run e2e`      | Playwright end-to-end checks (`node scripts/e2e3d.mjs <url>`)    |

CI runs lint, a Prettier format check, the tests with coverage, and a production build on every
pull request. If `npm run check` and `npm run format` are clean locally, CI should pass.

## Architecture

The code is layered so that the engineering logic has no dependency on the user interface.

| Path               | Contents                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `src/solver3d`     | The solver: truss, beam, plate and solid elements, skyline solver, modal, influence lines |
| `src/design-codes` | IS 800:2007 member checks and steel section tables. Pure functions                        |
| `src/model3d`      | The project model, unit conversion, plane-frame mode, generators, design wiring, `from2D` |
| `src/io`           | JSON save and load, share links, migration of old 2D files and links, PDF report          |
| `src/examples3d`   | Example structures (3D, and the 2D examples converted to plane frames)                    |
| `src/ui3d`         | React components and the three.js viewer                                                  |
| `src/solver`, `src/model`, `src/examples` | The original 2D solver and model: used to read old 2D files and as the test reference |
| `tests/validation` | Validation suites: textbook problems and benchmarks with closed-form or published answers |

Things to keep in mind:

- **`src/solver3d` and `src/design-codes` stay pure.** They must not import from React, the
  DOM, `src/ui3d`, `src/model3d` or `src/io`. Dependencies point inward: the UI depends on the solver,
  never the other way round.
- **The solver is unit-agnostic.** It works in any consistent set of units. The UI works in kN,
  m, kN·m, GPa, cm², cm⁴ and mm, and `src/model3d` does the conversion.
- **Sign conventions are fixed** and documented in `src/solver3d/types.ts` and section 1–2 of
  THEORY_3D.md: right-handed axes with Y up, rotations by the right-hand rule, axial force
  tension-positive, member local y "web up". New code must follow them.
- **The 2D solver is a reference, not a dependency.** Production code must not import from
  `src/solver`; plane-frame features go through the 3D solver and are tested against the 2D one.

## Rules

1. **Strict TypeScript.** The project compiles with `strict` on. Do not use `any`; ESLint
   rejects it. Prefer precise types and `unknown` with narrowing for untrusted input.
2. **Solver coverage stays at 90% or above.** `npm run coverage` enforces thresholds on
   `src/solver3d`, `src/solver` and `src/design-codes` (90% lines, functions and statements; 80% branches).
3. **Every solver change needs a test.** A bug fix needs a test that fails without the fix. A
   new feature needs unit tests and, where a known answer exists, a validation problem.
4. **Validation problems must cite a source and match within their stated tolerance** (0.1% for
   line elements; mesh-dependent cases state theirs before the run). Each problem in
   `tests/validation` names where the expected values come from: a textbook (author, title,
   edition, example or problem number) or a closed-form formula. Computed results must agree
   with the expected values to within 0.1%. If the source prints rounded numbers that cannot
   support that tolerance, derive the exact value by hand and say so in a comment.
5. **Design-code functions cite their clause.** Each check in `src/design-codes` names the
   clause or table it implements in a comment.
6. **No new runtime dependencies without discussion.** The solver is deliberately written from
   scratch. Open an issue before adding a library.
7. **Keep the theory manual in step.** If you change a formula, a sign convention or an
   assumption, update `docs/THEORY.md` or `docs/THEORY_3D.md` in the same pull request.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary in the imperative>
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore` and `ci`. Use the
folder as the scope where it helps. For example:

```
feat(solver): add trapezoidal member loads
fix(design-codes): use minor-axis buckling curve for ISMC sections
test(validation): add propped cantilever under uniform load
docs: explain static condensation in THEORY.md
```

Keep commits small and focused, and keep each pull request to one topic.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests.
3. Run `npm run format` and `npm run check`.
4. Open a pull request and fill in the template. Add before and after screenshots for any UI
   change.

## How to add an example structure

Examples live in `src/examples3d/index.ts`, built with the small builder in the same folder. Each
one is a complete project model in UI units. A plane frame is an example with `plane: 'XY'`.

1. Add a builder function following an existing example: nodes, members (or plates / solids),
   sections, supports and loads, plus a short name and description.
2. Register it in `EXAMPLES_3D` with a category so it appears in the example picker.
3. Add or extend a test that loads the example and solves it, so a broken example fails CI.
4. If the structure has a known answer (a textbook truss, a portal frame with published
   moments), consider adding it to `tests/validation` too.
5. Check it in the browser: the structure should fit the view, and the deflected shape and
   diagrams should look right.

Good examples are small enough to understand at a glance and show one idea clearly.

## How to add a design code

Design checks live in `src/design-codes`, with one folder per code.

1. Create a folder for the code (for example `src/design-codes/ec3`).
2. Write the checks as pure functions. Inputs are section properties, material properties,
   effective lengths and the design forces from the solver. Outputs follow the same result
   shape as the IS 800 checks: a capacity, a demand, a utilisation ratio, and the governing
   clause.
3. Add the section table the code needs, with the source of the data cited at the top of the
   file.
4. Write unit tests against worked examples from a textbook or a design guide, with the
   reference cited in each test.
5. Register the code where the UI lists the available design codes.
6. Add a short section to `docs/THEORY.md` with the equations and clause numbers.

## How to report a wrong result

A wrong answer from the solver is the most serious kind of bug in this project. Please use the
**Wrong result** issue template and include:

- **The model.** Either the share URL (use the share button in the app) or the exported JSON
  file. Without the exact model the problem usually cannot be reproduced.
- **The quantity that is wrong**: which node or member, and which result (displacement,
  reaction, axial force, shear, moment, utilisation ratio).
- **The value FrameForge gives and the value you expect**, with units.
- **Where the expected value comes from**: a textbook example, a hand calculation, or another
  program (name and version).

Before reporting, please check the sign conventions and units (THEORY_3D.md section 1–2, or
THEORY.md section 2 for plane frames) and the limitations (THEORY_3D.md section 11). A difference caused by shear deformation or
second-order effects, which FrameForge does not model, is a limitation and not a bug.

## Licence

By contributing you agree that your contributions are licensed under the MIT licence, the same
as the rest of the project.
