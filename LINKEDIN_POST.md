# LinkedIn post

> **Before you post — read this once.** The numbers below are real and come from the repo
> (`npm run coverage`, `VALIDATION.md`, `npm run e2e`). The post says plainly that the project was
> built with an AI coding agent, because it was: the code in this repo was written by Claude Code
> working from your specification. I'd keep that line. Recruiters and seniors who open the commit
> history will see it anyway, and being upfront about how you used the tool reads far better than
> being asked about it later. Before posting, spend an hour with `docs/THEORY.md` and
> `src/solver/` so you can answer questions about how it works. Add the hero GIF
> (`docs/screenshots/hero.gif`) as the post's media.

---

**I wanted a structural analysis tool I could open in a browser tab. So I built one.**

In my first semester of Civil Engineering at BITS Pilani, I kept running into the same problem.
STAAD and SAP2000 are what the industry uses, but they are expensive, heavy, and a lot of software
to open just to check what a hinge does to a bending moment diagram.

So I built FrameForge: a free 2D structural analysis tool that runs entirely in the browser.

🔗 Try it: https://wrucebayne29.github.io/frameforge/
💻 Code: https://github.com/WruceBayne29/frameforge

What it does:

▪️ Analyses trusses, beams and frames with the direct stiffness method
▪️ Draws axial force, shear force and bending moment diagrams, and the deflected shape
▪️ Lets you drag a joint and watch the diagrams change live
▪️ Checks steel members to IS 800:2007 and colours each one by its utilisation ratio
▪️ Exports a PDF calculation report, and shares a whole model as a link
▪️ Goes beyond statics: natural frequencies with animated mode shapes, and influence lines for moving loads

The part I care about most is that the answers are right. The solver has no FEM library under it.
It is checked against 26 textbook problems with closed-form answers (cantilevers, propped
cantilevers, continuous beams, portal frames, Pratt and Warren trusses, beam natural frequencies), 122 quantities in all,
every one matching to within 0.1%. It also tells you when a structure is unstable and which node
is free to move, instead of returning nonsense.

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
