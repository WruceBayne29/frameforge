# 3D validation

FrameForge's 3D solver is checked against **25 problems** (117 individual quantities): closed-form answers for space trusses and frames, and published thin-plate, shell and elasticity solutions for the plate and solid elements. Every case runs through the public `analyze3d` API exactly as the app does.

Each case has its own tolerance, shown in the table. Truss and beam elements are exact for
the loads they carry, so those cases must match to **0.1 %**, like the 2D suite. Plate and
solid cases compare a finite-element mesh with a continuum solution; their tolerance is the
accuracy that mesh is expected to reach, stated before the run, and the mesh is named in the
title.

The tables below are generated from the test suite itself (`tests/validation/cases3d.ts`),
so they cannot drift from the code. Regenerate them with `npm run validation3d`.

Units: kN, m (stresses kN/m², plate moments kN·m/m). Global Y is up. Unless a case says
otherwise, line members use E = 200 GPa, G = E/2.6, A = 0.01 m², Iz = 1.2×10⁻⁴ m⁴,
Iy = 4×10⁻⁵ m⁴, J = 2.5×10⁻⁵ m⁴. Where the classical solution neglects axial deformation
(B04), a very large area is used. For a zero reference value the error is measured against
the largest reference value of the case.

## Summary

| # | Problem | Quantities | Tolerance | Max error |
| --- | --- | ---: | ---: | ---: |
| T01 | Tripod (statically determinate space truss) under a general apex load | 7 | 0.1 % | < 0.0001 % |
| T02 | Square pyramid (one redundant bar) under vertical and horizontal apex loads | 5 | 0.1 % | < 0.0001 % |
| B01 | L-shaped cantilever (grillage) with an out-of-plane tip load: bending + torsion | 8 | 0.1 % | < 0.0001 % |
| B02 | Skew cantilever, roll angle β = 30°, with a biaxial tip load | 8 | 0.1 % | < 0.0001 % |
| B03 | Fixed-fixed beam along Z: UDL in the local x–y plane, point load in the local x–z plane | 8 | 0.1 % | < 0.0001 % |
| B04 | Four-column table frame swaying in X and Z (weak and strong column axes) | 6 | 0.1 % | < 0.0001 % |
| B05 | Secondary beam with moment releases at both ends, framing into two fixed girders | 7 | 0.1 % | < 0.0001 % |
| B06 | Simply supported beam on a skew plan line (30° to X) with vertical and lateral UDLs | 7 | 0.1 % | < 0.0001 % |
| B07 | Space frame with every member load type: reactions balance the loads (6 components) | 6 | 0.1 % | < 0.0001 % |
| P01 | Simply supported square plate, uniform pressure (a/t = 100, 16 × 16 mesh) | 4 | 1 % | 0.0746 % |
| P02 | Simply supported square plate, central point load (16 × 16 mesh) | 2 | 1 % | 0.3519 % |
| P03 | Clamped square plate, uniform pressure (a/t = 100, 16 × 16 mesh) | 2 | 2 % | 0.4280 % |
| P04 | Cantilever plate strip (ν = 0) with a tip line load, 10 elements | 4 | 0.5 % | 0.2500 % |
| P05 | Square plate twisted by corner forces (pure Mxy), a/t = 100, 4 × 4 mesh | 2 | 0.5 % | 0.0705 % |
| P06 | Scordelis–Lo barrel vault under self-weight (quarter model, 16 × 16 mesh) | 1 | 1 % | 0.0005 % |
| P07 | Square box-section cantilever of folded plates (20 × 8 mesh), end torque | 4 | 0.5 % | 0.1558 % |
| H01 | Prismatic bar in uniaxial tension (4 × 1 × 1 hexahedra) | 6 | 0.1 % | < 0.0001 % |
| H02 | Slender solid cantilever (L/h = 10) with an end shear, 20 × 2 × 2 hexahedra | 3 | 1 % | 0.1524 % |
| H03 | Constant-strain patch test on a distorted 3 × 3 × 3 mesh of a unit cube | 9 | 0.1 % | < 0.0001 % |
| H04 | Solid column under its own weight (ν = 0, 2 × 6 × 2 hexahedra) | 4 | 0.1 % | < 0.0001 % |
| M01 | Natural frequencies of a simply supported beam, bending about both axes (16 elements) | 4 | 0.1 % | 0.0016 % |
| M02 | Cantilever: first two bending frequencies and effective modal mass (12 elements) | 3 | 0.1 % | 0.0378 % |
| M03 | Fixed–free shaft: torsional and axial frequencies (20 elements) | 3 | 0.3 % | 0.2315 % |
| M04 | Simply supported square plate, first two frequencies (a/t = 100, 16 × 16 mesh) | 2 | 2 % | 1.4340 % |
| M05 | Solid cantilever (ν = 0, L/h = 20, 20 × 2 × 2 hexahedra): bending and axial frequencies | 2 | 1.5 % | 0.1141 % |

## Full results

### T01 — Tripod (statically determinate space truss) under a general apex load

Reference: Joint equilibrium and the unit-load (virtual work) method; Hibbeler, Structural Analysis. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Force in leg 1 | ΣN·e + P = 0 | -1.80185 kN | -1.80185 kN | 0.0000 % |
| Force in leg 2 | ΣN·e + P = 0 | -27.8849 kN | -27.8849 kN | 0.0000 % |
| Force in leg 3 | ΣN·e + P = 0 | -39.6081 kN | -39.6081 kN | 0.0000 % |
| Apex displacement ux | Σ N·n·L/EA | 5.8360e-5 m | 5.8360e-5 m | 0.0000 % |
| Apex displacement uy | Σ N·n·L/EA | -5.8112e-5 m | -5.8112e-5 m | 0.0000 % |
| Apex displacement uz | Σ N·n·L/EA | 9.0640e-5 m | 9.0640e-5 m | 0.0000 % |
| Reaction Fy at foot 1 | N₁·e₁,y | 1.58491 kN | 1.58491 kN | 0.0000 % |

### T02 — Square pyramid (one redundant bar) under vertical and horizontal apex loads

Reference: Joint stiffness K = (EA/L)·Σ e·eᵀ, diagonal by symmetry; Kassimali, Matrix Analysis of Structures. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Apex sway ux | HL³/(4EAa²) | 2.6285e-5 m | 2.6285e-5 m | 0.0000 % |
| Apex deflection uy | PL³/(4EAh²) | -3.8940e-5 m | -3.8940e-5 m | 0.0000 % |
| Force in leg towards +X | −HL/4a − PL/4h | -19.9283 kN | -19.9283 kN | 0.0000 % |
| Force in leg towards −X | +HL/4a − PL/4h | -7.55903 kN | -7.55903 kN | 0.0000 % |
| Vertical reaction, +X foot | −N·h/L | 14.5000 kN | 14.5000 kN | 0.0000 % |

### B01 — L-shaped cantilever (grillage) with an out-of-plane tip load: bending + torsion

Reference: Bent cantilever by superposition of bending and torsion; Gere & Goodno, Mechanics of Materials. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Tip deflection at C | PL₁³/3EI + PL₂²L₁/GJ + PL₂³/3EI | -0.0672611 m | -0.0672611 m | 0.0000 % |
| Twist of AB at B | PL₂L₁/GJ | 0.0312000 rad | 0.0312000 rad | 0.0000 % |
| Slope of AB at B | PL₁²/2EI | -0.00187500 rad | -0.00187500 rad | 0.0000 % |
| Torque in AB | PL₂ | 20.0000 kN·m | 20.0000 kN·m | 0.0000 % |
| Root moment of AB (hogging) | PL₁ | -30.0000 kN·m | -30.0000 kN·m | 0.0000 % |
| Root moment of BC (hogging) | PL₂ | -20.0000 kN·m | -20.0000 kN·m | 0.0000 % |
| Reaction torque Mx at A | −PL₂ | -20.0000 kN·m | -20.0000 kN·m | 0.0000 % |
| Reaction moment Mz at A | PL₁ | 30.0000 kN·m | 30.0000 kN·m | 0.0000 % |

### B02 — Skew cantilever, roll angle β = 30°, with a biaxial tip load

Reference: Inclined load resolved onto the principal axes; Gere & Goodno, Mechanics of Materials. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Tip ux | Σ (P·eₖ)L³/3EIₖ · eₖ | -0.00621496 m | -0.00621496 m | 0.0000 % |
| Tip uy | Σ (P·eₖ)L³/3EIₖ · eₖ | -0.0128453 m | -0.0128453 m | 0.0000 % |
| Tip uz | Σ (P·eₖ)L³/3EIₖ · eₖ | 0.0107850 m | 0.0107850 m | 0.0000 % |
| Root moment Mz | P_y·L | -22.0526 kN·m | -22.0526 kN·m | 0.0000 % |
| Root moment My | P_z·L | 25.8038 kN·m | 25.8038 kN·m | 0.0000 % |
| Reaction Mx | −(r × P)ₓ | -16.0000 kN·m | -16.0000 kN·m | 0.0000 % |
| Reaction My | −(r × P)ᵧ | 11.3205 kN·m | 11.3205 kN·m | 0.0000 % |
| Reaction Mz | −(r × P)_z | 27.7128 kN·m | 27.7128 kN·m | 0.0000 % |

### B03 — Fixed-fixed beam along Z: UDL in the local x–y plane, point load in the local x–z plane

Reference: Fixed-end beam formulas; Roark’s Formulas for Stress and Strain, table 8.1. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| End moment Mz (hogging) | wL²/12 | -27.0000 kN·m | -27.0000 kN·m | 0.0000 % |
| Midspan moment Mz | wL²/24 | 13.5000 kN·m | 13.5000 kN·m | 0.0000 % |
| Midspan deflection v | wL⁴/384EIz | -0.00126563 m | -0.00126563 m | 0.0000 % |
| End moment My at A | Pab²/L² | -14.2222 kN·m | -14.2222 kN·m | 0.0000 % |
| Moment My under the load | 2Pa²b²/L³ | 9.48148 kN·m | 9.48148 kN·m | 0.0000 % |
| Deflection w under the load | Pa³b³/3EIyL³ | -0.00158025 m | -0.00158025 m | 0.0000 % |
| Shear Vz at A | Pb²(3a+b)/L³ | 11.8519 kN | 11.8519 kN | 0.0000 % |
| Vertical reaction at A | wL/2 | 27.0000 kN | 27.0000 kN | 0.0000 % |

### B04 — Four-column table frame swaying in X and Z (weak and strong column axes)

Reference: Fixed-base portal by slope-deflection, Δ = (Hh³/12EI)(3k+2)/(6k+1); Kassimali, Structural Analysis. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Sway along X | H₁h³(3k+2)/12EIz(6k+1), H₁ = Hx/2 | 0.00367063 m | 0.00367063 m | 0.0000 % |
| Sway along Z | H₁h³(3k+2)/12EIy(6k+1), H₁ = Hz/2 | 0.00548387 m | 0.00548387 m | 0.0000 % |
| Base moment Mz, column A | H₁h(3k+1)/2(6k+1) | 27.6786 kN·m | 27.6786 kN·m | 0.0000 % |
| Base moment Mx, column A | −H₁h(3k+1)/2(6k+1) | -15.4839 kN·m | -15.4839 kN·m | 0.0000 % |
| Base shear Fx, column C | −Hx/4 | -12.5000 kN | -12.5000 kN | 0.0000 % |
| Base shear Fz, column C | −Hz/4 | -7.50000 kN | -7.50000 kN | 0.0000 % |

### B05 — Secondary beam with moment releases at both ends, framing into two fixed girders

Reference: Released ends = simple span; fixed-fixed girder with a central load; Roark, table 8.1. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Girder midspan deflection | RL³/192EI, R = wB/2 | -0.00133333 m | -0.00133333 m | 0.0000 % |
| Girder end moment (hogging) | RL/8 | -30.0000 kN·m | -30.0000 kN·m | 0.0000 % |
| Girder end reaction | R/2 | 15.0000 kN | 15.0000 kN | 0.0000 % |
| Secondary midspan moment | wB²/8 | 37.5000 kN·m | 37.5000 kN·m | 0.0000 % |
| Secondary midspan deflection | Δ_girder + 5wB⁴/384EI | -0.00743685 m | -0.00743685 m | 0.0000 % |
| Secondary end shear | wB/2 | 30.0000 kN | 30.0000 kN | 0.0000 % |
| Released end moment | 0 | 0 kN·m | 0 kN·m | 0.0000 % |

### B06 — Simply supported beam on a skew plan line (30° to X) with vertical and lateral UDLs

Reference: Simply supported beam tables; Gere & Goodno, Mechanics of Materials, App. G. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Midspan deflection v | 5wL⁴/384EIz | -0.0130263 m | -0.0130263 m | 0.0000 % |
| Midspan deflection w | 5wL⁴/384EIy | 0.0156315 m | 0.0156315 m | 0.0000 % |
| Midspan moment Mz | wL²/8 | 61.2500 kN·m | 61.2500 kN·m | 0.0000 % |
| Midspan moment My | wL²/8 | -24.5000 kN·m | -24.5000 kN·m | 0.0000 % |
| Vertical reaction at A | wL/2 | 35.0000 kN | 35.0000 kN | 0.0000 % |
| Reaction Fx at B | (wL/2)·sin θ | 7.00000 kN | 7.00000 kN | 0.0000 % |
| Reaction Fz at B | −(wL/2)·cos θ | -12.1244 kN | -12.1244 kN | 0.0000 % |

### B07 — Space frame with every member load type: reactions balance the loads (6 components)

Reference: Statics of a rigid body, ΣF = 0 and ΣM = 0 about the origin. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Σ reaction Fx | −Σ Fx (loads) | -30.0000 kN | -30.0000 kN | 0.0000 % |
| Σ reaction Fy | −Σ Fy (loads incl. self-weight) | 131.481 kN | 131.481 kN | 0.0000 % |
| Σ reaction Fz | −Σ Fz (loads) | -23.0000 kN | -23.0000 kN | 0.0000 % |
| Σ reaction moment Mx | −Σ (r × F + M)ₓ | -222.020 kN·m | -222.020 kN·m | 0.0000 % |
| Σ reaction moment My | −Σ (r × F + M)ᵧ | 50.5000 kN·m | 50.5000 kN·m | 0.0000 % |
| Σ reaction moment Mz | −Σ (r × F + M)_z | 602.198 kN·m | 602.198 kN·m | 0.0000 % |

### P01 — Simply supported square plate, uniform pressure (a/t = 100, 16 × 16 mesh)

Reference: Navier double series (α = 0.00406, β = 0.0479 for ν = 0.3); Timoshenko & Woinowsky-Krieger, Theory of Plates and Shells, ch. 5. Tolerance: 1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Centre deflection | α·qa⁴/D, α = 0.00406 | -0.00443609 m | -0.00443278 m | 0.0746 % |
| Centre moment Mx (sagging) | β·qa², β = 0.0479 | -3.83091 kN·m/m | -3.83114 kN·m/m | 0.0061 % |
| Centre moment My (sagging) | β·qa², β = 0.0479 | -3.83091 kN·m/m | -3.83114 kN·m/m | 0.0061 % |
| Total reaction | qa² | 80.0000 kN | 80.0000 kN | 0.0000 % |

### P02 — Simply supported square plate, central point load (16 × 16 mesh)

Reference: Navier series w = (4Pa²/π⁴D)·Σ 1/(m² + n²)² = 0.01160·Pa²/D; Timoshenko & Woinowsky-Krieger, ch. 5. Tolerance: 1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Centre deflection | γ·Pa²/D, γ = 0.01160 | -0.00316703 m | -0.00316645 m | 0.0181 % |
| Deflection at quarter point (a/4, a/2) | series | -0.00194901 m | -0.00195587 m | 0.3519 % |

### P03 — Clamped square plate, uniform pressure (a/t = 100, 16 × 16 mesh)

Reference: Taylor & Govindjee (2004), Commun. Numer. Meth. Engng 20:757: w = 0.0012653·qa⁴/D, M = 0.02291·qa² (Timoshenko & Woinowsky-Krieger tabulate 0.00126 and 0.0231). Tolerance: 2 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Centre deflection | 0.0012653·qa⁴/D | -0.00138171 m | -0.00138045 m | 0.0914 % |
| Centre moment Mx (sagging) | 0.02291·qa² | -1.83280 kN·m/m | -1.84064 kN·m/m | 0.4280 % |

### P04 — Cantilever plate strip (ν = 0) with a tip line load, 10 elements

Reference: Timoshenko beam per unit width, PL³/3D + PL/(κGt), κ = 5/6; Timoshenko & Gere, Mechanics of Materials. Tolerance: 0.5 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Tip deflection | PL³/3D + PL/κGt | -0.0800048 m | -0.0798048 m | 0.2500 % |
| Moment at the centre of the root element (hogging) | P(L − h/2) | 38.0000 kN·m/m | 38.0000 kN·m/m | 0.0000 % |
| Transverse shear Qx | −P | -4.00000 kN/m | -4.00000 kN/m | 0.0000 % |
| Top surface stress, root element | 6P(L − h/2)/t² | 2.2800e+4 kN/m² | 2.2800e+4 kN/m² | 0.0000 % |

### P05 — Square plate twisted by corner forces (pure Mxy), a/t = 100, 4 × 4 mesh

Reference: Anticlastic surface w = P·x·y/(2(1 − ν)D), Mxy = P/2; Timoshenko & Woinowsky-Krieger, ch. 2. Tolerance: 0.5 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Corner deflection | Pa²/(2(1 − ν)D) | 0.585000 m | 0.585321 m | 0.0548 % |
| Twisting moment Mxy at the centre | −P/2 | -0.150000 kN·m/m | -0.150106 kN·m/m | 0.0705 % |

### P06 — Scordelis–Lo barrel vault under self-weight (quarter model, 16 × 16 mesh)

Reference: MacNeal & Harder (1985), Finite Elem. Anal. Des. 1:3 — vertical deflection at mid free edge 0.3024. Tolerance: 1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Vertical deflection at mid free edge | 0.3024 (reference) | -0.302400 m | -0.302402 m | 0.0005 % |

### P07 — Square box-section cantilever of folded plates (20 × 8 mesh), end torque

Reference: Bredt–Batho closed thin-walled section, J = 4A²t/s; Megson, Aircraft Structures for Engineering Students. Tolerance: 0.5 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Tip twist (nodal rotation rz) | TL/GJ, J = 4A²t/s + Σbt³/3 | 0.00159468 rad | 0.00159310 rad | 0.0995 % |
| Tip twist from wall displacement | ux/(−y) | 0.00159468 rad | 0.00159387 rad | 0.0512 % |
| Membrane shear flow, mid-length | q·J_Bredt/J | 39.8671 kN/m | 39.8050 kN/m | 0.1558 % |
| Root reaction torque | −2Aq | -80.0000 kN·m | -80.0000 kN·m | 0.0000 % |

### H01 — Prismatic bar in uniaxial tension (4 × 1 × 1 hexahedra)

Reference: Hooke’s law, δ = PL/EA, lateral strain −νσ/E; Timoshenko & Goodier, Theory of Elasticity. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Elongation | σL/E | 3.0000e-5 m | 3.0000e-5 m | 0.0000 % |
| Lateral contraction (y) | −νσb/E | -1.1250e-6 m | -1.1250e-6 m | 0.0000 % |
| Lateral contraction (z) | −νσb/E | -1.1250e-6 m | -1.1250e-6 m | 0.0000 % |
| Stress σxx at a corner node | P/A | 1.5000e+3 kN/m² | 1.5000e+3 kN/m² | 0.0000 % |
| Von Mises stress | σ | 1.5000e+3 kN/m² | 1.5000e+3 kN/m² | 0.0000 % |
| Support reaction Σ Fx | −σ·A | -375.000 kN | -375.000 kN | 0.0000 % |

### H02 — Slender solid cantilever (L/h = 10) with an end shear, 20 × 2 × 2 hexahedra

Reference: Timoshenko beam with shear, PL³/3EI + PL/(κGA), κ = 5/6; Timoshenko & Goodier, Theory of Elasticity (cantilever loaded at the end). Tolerance: 1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Tip deflection (axis) | PL³/3EI + PL/κGA | -0.0134373 m | -0.0134169 m | 0.1524 % |
| Top-fibre bending stress at mid-span | M(x)·c/I | 2.8500e+3 kN/m² | 2.8500e+3 kN/m² | 0.0000 % |
| Vertical reaction | P | 100.000 kN | 100.000 kN | 0.0000 % |

### H03 — Constant-strain patch test on a distorted 3 × 3 × 3 mesh of a unit cube

Reference: Patch test (Irons); load and material of MacNeal & Harder (1985), Finite Elem. Anal. Des. 1:3 — strains 10⁻³, σ = 2000, τ = 400. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Interior ux, worst of 8 nodes | 10⁻³(2x + y + z)/2 | 9.5750e-4 m | 9.5750e-4 m | 0.0000 % |
| Interior uy, worst of 8 nodes | 10⁻³(x + 2y + z)/2 | 0.00105000 m | 0.00105000 m | 0.0000 % |
| Interior uz, worst of 8 nodes | 10⁻³(x + y + 2z)/2 | 0.00120917 m | 0.00120917 m | 0.0000 % |
| σxx, worst of 243 points | (3λ + 2μ)·10⁻³ | 2.0000e+3 kN/m² | 2.0000e+3 kN/m² | 0.0000 % |
| σyy, worst of 243 points | (3λ + 2μ)·10⁻³ | 2.0000e+3 kN/m² | 2.0000e+3 kN/m² | 0.0000 % |
| σzz, worst of 243 points | (3λ + 2μ)·10⁻³ | 2.0000e+3 kN/m² | 2.0000e+3 kN/m² | 0.0000 % |
| τxy, worst of 243 points | μ·10⁻³ | 400.000 kN/m² | 400.000 kN/m² | 0.0000 % |
| τyz, worst of 243 points | μ·10⁻³ | 400.000 kN/m² | 400.000 kN/m² | 0.0000 % |
| τzx, worst of 243 points | μ·10⁻³ | 400.000 kN/m² | 400.000 kN/m² | 0.0000 % |

### H04 — Solid column under its own weight (ν = 0, 2 × 6 × 2 hexahedra)

Reference: Prismatic bar under its own weight, σ = −ρg(H − y), δ = ρgH²/2E; Timoshenko & Goodier, Theory of Elasticity. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Top displacement | ρgH²/2E | -1.5000e-5 m | -1.5000e-5 m | 0.0000 % |
| Displacement at mid-height | ρg(Hy − y²/2)/E | -1.1250e-5 m | -1.1250e-5 m | 0.0000 % |
| σyy at the centre of the bottom element | −ρg(H − y) | -137.500 kN/m² | -137.500 kN/m² | 0.0000 % |
| Base reaction | ρg·V | 150.000 kN | 150.000 kN | 0.0000 % |

### M01 — Natural frequencies of a simply supported beam, bending about both axes (16 elements)

Reference: Clough & Penzien, Dynamics of Structures: ωn = (nπ/L)²·√(EI/ρA). Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| ω1 about the minor axis | π²/L²·√(EIy/ρA) | 87.5200 rad/s | 87.5201 rad/s | 0.0001 % |
| ω2 about the minor axis | 4π²/L²·√(EIy/ρA) | 350.080 rad/s | 350.086 rad/s | 0.0016 % |
| ω1 about the major axis | π²/L²·√(EIz/ρA) | 151.589 rad/s | 151.589 rad/s | 0.0001 % |
| ω2 about the major axis | 4π²/L²·√(EIz/ρA) | 606.356 rad/s | 606.366 rad/s | 0.0016 % |

### M02 — Cantilever: first two bending frequencies and effective modal mass (12 elements)

Reference: Blevins, Formulas for Natural Frequency and Mode Shape: β1L = 1.87510, β2L = 4.69409. Tolerance: 0.1 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| ω1 | 1.87510²·√(EI/ρAL⁴) | 121.507 rad/s | 121.507 rad/s | 0.0005 % |
| ω2 | 4.69409²·√(EI/ρAL⁴) | 761.471 rad/s | 761.484 rad/s | 0.0017 % |
| Effective mass of mode 1 | 0.6131·ρAL | 0.613100 – | 0.612868 – | 0.0378 % |

### M03 — Fixed–free shaft: torsional and axial frequencies (20 elements)

Reference: Rao, Mechanical Vibrations: ωn = (2n − 1)π/(2L)·√(GJ/ρIp) and √(E/ρ). Tolerance: 0.3 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| First torsional ω | π/(2L)·√(GJ/ρIp) | 323.946 rad/s | 324.029 rad/s | 0.0257 % |
| Second torsional ω | 3π/(2L)·√(GJ/ρIp) | 971.837 rad/s | 974.086 rad/s | 0.2315 % |
| First axial ω | π/(2L)·√(E/ρ) | 1.3214e+3 rad/s | 1.3218e+3 rad/s | 0.0257 % |

### M04 — Simply supported square plate, first two frequencies (a/t = 100, 16 × 16 mesh)

Reference: Leissa, Vibration of Plates (NASA SP-160): ωmn = π²·((m² + n²)/a²)·√(D/ρt). Tolerance: 2 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| ω11 | π²·(2/a²)·√(D/ρt) | 150.754 rad/s | 151.233 rad/s | 0.3177 % |
| ω12 = ω21 | π²·(5/a²)·√(D/ρt) | 376.885 rad/s | 382.289 rad/s | 1.4340 % |

### M05 — Solid cantilever (ν = 0, L/h = 20, 20 × 2 × 2 hexahedra): bending and axial frequencies

Reference: Euler–Bernoulli beam β1L = 1.87510; axial bar π/(2L)·√(E/ρ). Tolerance: 1.5 %.

| Quantity | Reference value | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| First bending ω | 1.87510²·√(EI/ρAL⁴) | 35.8850 rad/s | 35.8441 rad/s | 0.1141 % |
| First axial ω | π/(2L)·√(E/ρ) | 1.1107e+3 rad/s | 1.1110e+3 rad/s | 0.0257 % |
