# LinkedIn post

> **Before you post — read this once.** The numbers below are real and come from the repo
> (`npm run coverage`, `VALIDATION.md`, `VALIDATION_3D.md`, `npm run e2e`). The post says plainly that the project was
> built with an AI coding agent, because it was: the code in this repo was written by Claude Code
> working from your specification. I'd keep that line. Recruiters and seniors who open the commit
> history will see it anyway, and being upfront about how you used the tool reads far better than
> being asked about it later. Before posting, spend an hour with `docs/THEORY.md` and
> `src/solver/` so you can answer questions about how it works — and, for the 3D part,
> `docs/THEORY_3D.md`. Add the hero GIF (`docs/screenshots/hero.gif`) as the post's media, or a
> 3D screenshot (`docs/screenshots/3d-building-frame.png`). The 3D workspace lives on the
> `feat/3d-space-structures` branch: merge and deploy it before you post the 3D paragraphs, or
> cut them.
>
> There are two versions below: the original launch post with a 3D paragraph added, and a short
> follow-up post if the original has already gone out.

---

**I wanted a structural analysis tool I could open in a browser tab. So I built one.**

In my first semester of Civil Engineering at BITS Pilani, I kept running into the same problem.
STAAD and SAP2000 are what the industry uses, but they are expensive, heavy, and a lot of software
to open just to check what a hinge does to a bending moment diagram.

So I built FrameForge: a free structural analysis tool that runs entirely in the browser — 2D
frames and trusses, and now 3D structures too.

🔗 Try it: https://wrucebayne29.github.io/frameforge/
💻 Code: https://github.com/WruceBayne29/frameforge

What it does:

▪️ Analyses trusses, beams and frames with the direct stiffness method
▪️ Draws axial force, shear force and bending moment diagrams, and the deflected shape
▪️ Lets you drag a joint and watch the diagrams change live
▪️ Checks steel members to IS 800:2007 and colours each one by its utilisation ratio
▪️ Exports a PDF calculation report, and shares a whole model as a link
▪️ Goes beyond statics: natural frequencies with animated mode shapes, and influence lines for moving loads
▪️ Has a 3D workspace for space frames, space trusses, slabs (plate elements) and solid blocks, with force diagrams and stress contours

The part I care about most is that the answers are right. The solver has no FEM library under it.
It is checked against 26 textbook problems with closed-form answers (cantilevers, propped
cantilevers, continuous beams, portal frames, Pratt and Warren trusses, beam natural frequencies), 122 quantities in all,
every one matching to within 0.1%. It also tells you when a structure is unstable and which node
is free to move, instead of returning nonsense.

The 3D solver is held to the same standard: 20 more problems with 103 checked quantities, from a
space tripod and a bent cantilever in bending and torsion to the classic plate and shell
benchmarks (Navier's simply supported plate, the clamped plate, the Scordelis–Lo roof). Beams and
trusses match theory to within 0.1%; the plate and solid meshes land within 0.5% of the reference
solutions. While checking the clamped plate I found that the centre moment printed in the
standard plate-theory tables is nearly 1% high — a nice lesson in checking your references too.

How I built it: I wrote the specification, the milestones and the quality bar, and used Claude Code
as an AI coding agent to implement it. Working that way taught me more than I expected. To specify
a solver you have to know what a stiffness matrix is, why end releases need static condensation,
and what "validated" should actually mean. The theory write-up in the repo is where I'd point
anyone who wants to learn the method.

What I learned:

1️⃣ The direct stiffness method is the same five steps whether the structure has 3 members or 300.
2️⃣ A validation suite is worth more than any amount of "it looks right".
3️⃣ Sign conventions are where most of the bugs hide.

It is open source under the MIT licence. If you are a student, try breaking it and tell me what
goes wrong. If you are a practising engineer, I would really value your view on what a tool like
this should do next. Load combinations to IS 875 are first on my list.

#CivilEngineering #StructuralEngineering #OpenSource #BITSPilani #TypeScript #IS800

---

**Follow-up post (3D release)**

FrameForge now does 3D.

After the first version, a practising structural engineer asked whether it could handle "any 3D
structure": trusses, beams, plates and solids, with distributed loads and point loads on nodes
and on members. It now can, still entirely in the browser:

▪️ Space trusses (6 degrees of freedom per bar) and space frames (12 per beam), with end releases and member loads
▪️ Plates — slabs and walls — as 4-node shell elements, with moment and stress contours
▪️ Solids — footings and blocks — as 8-node brick elements
▪️ Force diagrams in both bending planes plus torsion, reactions, and an equilibrium check

Every element is written from scratch and checked against 20 reference problems, from hand
calculations to published finite-element benchmarks such as the Scordelis–Lo roof. The
validation tables and the theory write-up are in the repo.

As before, I specified it and Claude Code, an AI coding agent, implemented it. The interesting
part for me was learning why the obvious element formulations fail (shear locking in thin plates
and in bricks) and what the fixes look like.

🔗 https://wrucebayne29.github.io/frameforge/

#StructuralEngineering #FiniteElements #CivilEngineering #OpenSource
