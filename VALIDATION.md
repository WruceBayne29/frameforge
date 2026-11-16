# Validation

FrameForge's solver is checked against **26 textbook problems** (122 individual quantities) with closed-form answers. Every quantity must match to within **0.1 %**; in practice the error is at the level of floating-point round-off.

The table below is generated from the test suite itself (`tests/validation/cases.ts`), so it
cannot drift from the code. Regenerate it with `npm run validation`. The suite runs in CI on
every push.

Units: kN, m, kN·m, rad. E = 200 GPa, I = 1.2×10⁻⁴ m⁴, A = 8×10⁻³ m² unless a case says otherwise.
Where the classical solution neglects axial deformation (portal frames), a very large area is used.
Deflections are positive upward, so downward deflections are negative.

## Summary

| # | Problem | Closed-form checks | Quantities | Max error |
| --- | --- | --- | ---: | ---: |
| V01 | Cantilever with a point load at the tip | PL³/3EI, PL²/2EI, PL (hogging), … | 5 | < 0.0001 % |
| V02 | Cantilever with a uniformly distributed load | wL⁴/8EI, wL³/6EI, wL²/2 (hogging), … | 5 | < 0.0001 % |
| V03 | Simply supported beam with a central point load | PL³/48EI, PL/4, PL²/16EI, … | 5 | < 0.0001 % |
| V04 | Simply supported beam with a UDL (single element) | 5wL⁴/384EI, wL²/8, wL³/24EI, … | 5 | < 0.0001 % |
| V05 | Simply supported beam with an off-centre point load (member load) | Pb/L, Pa/L, Pab/L, … | 5 | < 0.0001 % |
| V06 | Propped cantilever with a UDL | 3wL/8, 5wL/8, wL²/8 (hogging), … | 6 | < 0.0001 % |
| V07 | Fixed-fixed beam with a UDL | wL²/12 (hogging), wL²/24, wL⁴/384EI, … | 4 | < 0.0001 % |
| V08 | Fixed-fixed beam with a central point load | PL/8 (hogging), PL/8, PL³/192EI | 3 | < 0.0001 % |
| V09 | Two-span continuous beam, equal spans, UDL | 3wL/8, 10wL/8, wL²/8 (hogging), … | 5 | < 0.0001 % |
| V10 | Three-span continuous beam, equal spans, UDL | 0.4wL, 1.1wL, 0.1wL² (hogging), … | 5 | < 0.0001 % |
| V11 | Fixed-base portal frame with a lateral load | Ph(3k+1)/[2(6k+1)], 3Phk/[2(6k+1)], P/2, … | 5 | < 0.0001 % |
| V12 | Pinned-base portal frame with a UDL on the beam | wL²/[4h(2k+3)], H·h (hogging), wL²/8 − H·h, … | 4 | < 0.0001 % |
| V13 | Pratt truss, 4 panels, loads at the bottom-chord joints | −1.5P/sinθ, 1.5Pa/h, −2Pa/h, … | 7 | < 0.0001 % |
| V14 | Warren truss (equilateral), loads at the bottom-chord joints | −2P/√3, 2P/√3, 0 (zero shear panel), … | 7 | < 0.0001 % |
| V15 | Symmetric two-bar truss | −P/(2 sinθ), PL/(2EA sin²θ), P/(2 tanθ) | 3 | < 0.0001 % |
| V16 | Compound beam with an internal hinge (member end release) | wL₂/2, 0, (wL₂/2)·L₁ (hogging), … | 5 | < 0.0001 % |
| V17 | Fixed-fixed beam with a support settlement | 6EIΔ/L², 12EIΔ/L³, 6EIΔ/L² | 3 | < 0.0001 % |
| V18 | Simply supported beam with a triangular load | wL/6, wL/3, wL²/(9√3), … | 5 | < 0.0001 % |
| V19 | Fixed-fixed beam with a triangular load | wL²/30, wL²/20, 3wL/20, … | 4 | < 0.0001 % |
| V20 | Simply supported beam with a counter-clockwise moment at midspan | M₀/L, −M₀/L, M₀/2, … | 5 | < 0.0001 % |
| V21 | Inclined simply supported rafter under gravity load | wL/2, w·L·L_h/8, −(wL/2)·sinα, … | 4 | < 0.0001 % |
| V22 | Cantilever propped by a spring | P/(k_s + 3EI/L³), P·k_s/(k_s + 3EI/L³), (P − F_s)·L (hogging) | 3 | < 0.0001 % |
| V23 | Natural frequencies of a simply supported beam (modal analysis) | π²·√(EI/mL⁴), 4π²·√(EI/mL⁴), 9π²·√(EI/mL⁴), … | 4 | 0.0260 % |
| V24 | Natural frequencies of a cantilever (modal analysis) | 1.8751²·√(EI/mL⁴), 4.6941²·√(EI/mL⁴), 2π/ω₁ | 3 | 0.0016 % |
| V25 | Influence lines for a simply supported beam | 1 − x/L, 1 − x/L, L/4, … | 6 | < 0.0001 % |
| V26 | Influence line for the central reaction of a two-span continuous beam | x(3L² − x²)/2L³, x(3L² − x²)/2L³, x(3L² − x²)/2L³, … | 6 | < 0.0001 % |

## Full results

### V01 — Cantilever with a point load at the tip

Reference: Hibbeler, Structural Analysis, beam deflection tables

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Tip deflection | PL³/3EI | -0.0222222 m | -0.0222222 m | 0.0000 % |
| Tip rotation | PL²/2EI | -0.00833333 rad | -0.00833333 rad | 0.0000 % |
| Fixed-end moment | PL (hogging) | -100.000 kN·m | -100.000 kN·m | 0.0000 % |
| Vertical reaction | P | 25.0000 kN | 25.0000 kN | 0.0000 % |
| Reaction moment | PL | 100.000 kN·m | 100.000 kN·m | 0.0000 % |

### V02 — Cantilever with a uniformly distributed load

Reference: Hibbeler, Structural Analysis, beam deflection tables

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Tip deflection | wL⁴/8EI | -0.00937891 m | -0.00937891 m | 0.0000 % |
| Tip rotation | wL³/6EI | -0.00357292 rad | -0.00357292 rad | 0.0000 % |
| Fixed-end moment | wL²/2 (hogging) | -73.5000 kN·m | -73.5000 kN·m | 0.0000 % |
| Vertical reaction | wL | 42.0000 kN | 42.0000 kN | 0.0000 % |
| Mid-length deflection | 17wL⁴/384EI | -0.00332170 m | -0.00332170 m | 0.0000 % |

### V03 — Simply supported beam with a central point load

Reference: Gere & Goodno, Mechanics of Materials, App. G

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Midspan deflection | PL³/48EI | -0.00750000 m | -0.00750000 m | 0.0000 % |
| Midspan moment | PL/4 | 60.0000 kN·m | 60.0000 kN·m | 0.0000 % |
| End rotation | PL²/16EI | -0.00375000 rad | -0.00375000 rad | 0.0000 % |
| Left reaction | P/2 | 20.0000 kN | 20.0000 kN | 0.0000 % |
| Right reaction | P/2 | 20.0000 kN | 20.0000 kN | 0.0000 % |

### V04 — Simply supported beam with a UDL (single element)

Reference: Gere & Goodno, Mechanics of Materials, App. G

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Midspan deflection | 5wL⁴/384EI | -0.0333333 m | -0.0333333 m | 0.0000 % |
| Maximum moment | wL²/8 | 120.000 kN·m | 120.000 kN·m | 0.0000 % |
| End rotation | wL³/24EI | -0.0133333 rad | -0.0133333 rad | 0.0000 % |
| Support reaction | wL/2 | 60.0000 kN | 60.0000 kN | 0.0000 % |
| End shear | wL/2 | 60.0000 kN | 60.0000 kN | 0.0000 % |

### V05 — Simply supported beam with an off-centre point load (member load)

Reference: Gere & Goodno, Mechanics of Materials, App. G

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Left reaction | Pb/L | 38.5714 kN | 38.5714 kN | 0.0000 % |
| Right reaction | Pa/L | 21.4286 kN | 21.4286 kN | 0.0000 % |
| Moment under load | Pab/L | 96.4286 kN·m | 96.4286 kN·m | 0.0000 % |
| Deflection under load | Pa²b²/3EIL | -0.0150670 m | -0.0150670 m | 0.0000 % |
| Rotation at A | Pab(L+b)/6EIL | -0.00770089 rad | -0.00770089 rad | 0.0000 % |

### V06 — Propped cantilever with a UDL

Reference: Hibbeler, Structural Analysis, ch. 10 (force method)

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Prop reaction | 3wL/8 | 37.5000 kN | 37.5000 kN | 0.0000 % |
| Fixed-end reaction | 5wL/8 | 62.5000 kN | 62.5000 kN | 0.0000 % |
| Fixed-end moment | wL²/8 (hogging) | -62.5000 kN·m | -62.5000 kN·m | 0.0000 % |
| Max sagging moment | 9wL²/128 | 35.1563 kN·m | 35.1563 kN·m | 0.0000 % |
| Position of max moment | 5L/8 from fixed end | 3.12500 m | 3.12500 m | 0.0000 % |
| Midspan deflection | wL⁴/192EI | -0.00271267 m | -0.00271267 m | 0.0000 % |

### V07 — Fixed-fixed beam with a UDL

Reference: Kassimali, Matrix Analysis of Structures, fixed-end moment tables

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| End moment | wL²/12 (hogging) | -54.0000 kN·m | -54.0000 kN·m | 0.0000 % |
| Midspan moment | wL²/24 | 27.0000 kN·m | 27.0000 kN·m | 0.0000 % |
| Midspan deflection | wL⁴/384EI | -0.00253125 m | -0.00253125 m | 0.0000 % |
| Reaction moment at A | wL²/12 | 54.0000 kN·m | 54.0000 kN·m | 0.0000 % |

### V08 — Fixed-fixed beam with a central point load

Reference: Kassimali, Matrix Analysis of Structures, fixed-end moment tables

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| End moment | PL/8 (hogging) | -50.0000 kN·m | -50.0000 kN·m | 0.0000 % |
| Midspan moment | PL/8 | 50.0000 kN·m | 50.0000 kN·m | 0.0000 % |
| Midspan deflection | PL³/192EI | -0.00217014 m | -0.00217014 m | 0.0000 % |

### V09 — Two-span continuous beam, equal spans, UDL

Reference: Hibbeler, Structural Analysis, three-moment equation

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| End reaction | 3wL/8 | 22.5000 kN | 22.5000 kN | 0.0000 % |
| Central reaction | 10wL/8 | 75.0000 kN | 75.0000 kN | 0.0000 % |
| Support moment | wL²/8 (hogging) | -45.0000 kN·m | -45.0000 kN·m | 0.0000 % |
| Max span moment | 9wL²/128 | 25.3125 kN·m | 25.3125 kN·m | 0.0000 % |
| Position of max span moment | 3L/8 | 2.25000 m | 2.25000 m | 0.0000 % |

### V10 — Three-span continuous beam, equal spans, UDL

Reference: Reynolds & Steedman, continuous-beam coefficients

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| End reaction | 0.4wL | 38.4000 kN | 38.4000 kN | 0.0000 % |
| Interior reaction | 1.1wL | 105.600 kN | 105.600 kN | 0.0000 % |
| Interior support moment | 0.1wL² (hogging) | -38.4000 kN·m | -38.4000 kN·m | 0.0000 % |
| End-span max moment | 0.08wL² | 30.7200 kN·m | 30.7200 kN·m | 0.0000 % |
| Centre-span midspan moment | 0.025wL² | 9.60000 kN·m | 9.60000 kN·m | 0.0000 % |

### V11 — Fixed-base portal frame with a lateral load

Reference: Kleinlogel, Rigid Frame Formulas (slope-deflection, axial deformation neglected)

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Base moment | Ph(3k+1)/[2(6k+1)] | 54.5455 kN·m | 54.5455 kN·m | 0.0000 % |
| Knee moment | 3Phk/[2(6k+1)] | 45.4545 kN·m | 45.4545 kN·m | 0.0000 % |
| Horizontal reaction | P/2 | -25.0000 kN | -25.0000 kN | 0.0000 % |
| Vertical reaction | 2·M_knee/L | 15.1515 kN | 15.1515 kN | 0.0000 % |
| Sway | Ph³(3k+2)/[12EIc(6k+1)] | 0.00848485 m | 0.00848485 m | 0.0000 % |

### V12 — Pinned-base portal frame with a UDL on the beam

Reference: Kleinlogel, Rigid Frame Formulas (axial deformation neglected)

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Horizontal thrust | wL²/[4h(2k+3)] | 9.30909 kN | 9.30909 kN | 0.0000 % |
| Knee moment | H·h (hogging) | -46.5455 kN·m | -46.5455 kN·m | 0.0000 % |
| Beam midspan moment | wL²/8 − H·h | 81.4545 kN·m | 81.4545 kN·m | 0.0000 % |
| Vertical reaction | wL/2 | 64.0000 kN | 64.0000 kN | 0.0000 % |

### V13 — Pratt truss, 4 panels, loads at the bottom-chord joints

Reference: Method of joints / sections and unit-load method (Hibbeler ch. 3, 8)

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| End post L0U1 | −1.5P/sinθ | -75.0000 kN | -75.0000 kN | 0.0000 % |
| Bottom chord L0L1 | 1.5Pa/h | 60.0000 kN | 60.0000 kN | 0.0000 % |
| Top chord U1U2 | −2Pa/h | -80.0000 kN | -80.0000 kN | 0.0000 % |
| Vertical L1U1 | P | 30.0000 kN | 30.0000 kN | 0.0000 % |
| Diagonal U1L2 | 0.5P/sinθ | 25.0000 kN | 25.0000 kN | 0.0000 % |
| Centre vertical L2U2 | 0 (zero-force member) | 0 kN | 0 kN | 0.0000 % |
| Midspan deflection | ΣNnL/EA | -0.00145417 m | -0.00145417 m | 0.0000 % |

### V14 — Warren truss (equilateral), loads at the bottom-chord joints

Reference: Method of joints / sections (Hibbeler ch. 3)

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| End diagonal B0T0 | −2P/√3 | -51.9615 kN | -51.9615 kN | 0.0000 % |
| Diagonal T0B1 | 2P/√3 | 51.9615 kN | 51.9615 kN | 0.0000 % |
| Diagonal B1T1 | 0 (zero shear panel) | 0 kN | 0 kN | 0.0000 % |
| Bottom chord B0B1 | P/√3 | 25.9808 kN | 25.9808 kN | 0.0000 % |
| Bottom chord B1B2 | 2P/√3 | 51.9615 kN | 51.9615 kN | 0.0000 % |
| Top chord T0T1 | −2P/√3 | -51.9615 kN | -51.9615 kN | 0.0000 % |
| Support reaction | P | 45.0000 kN | 45.0000 kN | 0.0000 % |

### V15 — Symmetric two-bar truss

Reference: Gere & Goodno, Mechanics of Materials, ch. 2

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Bar force | −P/(2 sinθ) | -62.5000 kN | -62.5000 kN | 0.0000 % |
| Apex deflection | PL/(2EA sin²θ) | -2.4414e-4 m | -2.4414e-4 m | 0.0000 % |
| Horizontal thrust | P/(2 tanθ) | 37.5000 kN | 37.5000 kN | 0.0000 % |

### V16 — Compound beam with an internal hinge (member end release)

Reference: Statics: Gerber beam, cantilever + drop-in span

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Roller reaction | wL₂/2 | 28.0000 kN | 28.0000 kN | 0.0000 % |
| Moment at the hinge | 0 | 0 kN·m | 0 kN·m | 0.0000 % |
| Fixed-end moment | (wL₂/2)·L₁ (hogging) | -84.0000 kN·m | -84.0000 kN·m | 0.0000 % |
| Hinge deflection | (wL₂/2)·L₁³/3EI | -0.0105000 m | -0.0105000 m | 0.0000 % |
| Drop-in span max moment | wL₂²/8 | 28.0000 kN·m | 28.0000 kN·m | 0.0000 % |

### V17 — Fixed-fixed beam with a support settlement

Reference: Kassimali, Matrix Analysis of Structures, slope-deflection

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| End moment | 6EIΔ/L² | 69.1200 kN·m | 69.1200 kN·m | 0.0000 % |
| End shear | 12EIΔ/L³ | 27.6480 kN | 27.6480 kN | 0.0000 % |
| Moment at B | 6EIΔ/L² | 69.1200 kN·m | 69.1200 kN·m | 0.0000 % |

### V18 — Simply supported beam with a triangular load

Reference: Gere & Goodno, Mechanics of Materials, App. G

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Reaction at the zero end | wL/6 | 30.0000 kN | 30.0000 kN | 0.0000 % |
| Reaction at the peak end | wL/3 | 60.0000 kN | 60.0000 kN | 0.0000 % |
| Maximum moment | wL²/(9√3) | 69.2820 kN·m | 69.2820 kN·m | 0.0000 % |
| Position of max moment | L/√3 | 3.46410 m | 3.46410 m | 0.0000 % |
| Midspan deflection | 5wL⁴/768EI | -0.0105469 m | -0.0105469 m | 0.0000 % |

### V19 — Fixed-fixed beam with a triangular load

Reference: Kassimali, Matrix Analysis of Structures, fixed-end moment tables

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Moment at the zero end | wL²/30 | 20.0000 kN·m | 20.0000 kN·m | 0.0000 % |
| Moment at the peak end | wL²/20 | -30.0000 kN·m | -30.0000 kN·m | 0.0000 % |
| Reaction at the zero end | 3wL/20 | 18.0000 kN | 18.0000 kN | 0.0000 % |
| Reaction at the peak end | 7wL/20 | 42.0000 kN | 42.0000 kN | 0.0000 % |

### V20 — Simply supported beam with a counter-clockwise moment at midspan

Reference: Gere & Goodno, Mechanics of Materials, App. G

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Reaction at A | M₀/L | 15.0000 kN | 15.0000 kN | 0.0000 % |
| Reaction at B | −M₀/L | -15.0000 kN | -15.0000 kN | 0.0000 % |
| Moment just left of midspan | M₀/2 | 45.0000 kN·m | 45.0000 kN·m | 0.0000 % |
| Moment just right of midspan | −M₀/2 | -45.0000 kN·m | -45.0000 kN·m | 0.0000 % |
| Rotation at A | −M₀L/24EI | -9.3750e-4 rad | -9.3750e-4 rad | 0.0000 % |

### V21 — Inclined simply supported rafter under gravity load

Reference: Statics: load per unit length of member on an inclined beam

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Vertical reaction | wL/2 | 26.0000 kN | 26.0000 kN | 0.0000 % |
| Maximum moment | w·L·L_h/8 | 39.0000 kN·m | 39.0000 kN·m | 0.0000 % |
| Axial force at the lower end | −(wL/2)·sinα | -10.0000 kN | -10.0000 kN | 0.0000 % |
| Shear at the lower end | (wL/2)·cosα | 24.0000 kN | 24.0000 kN | 0.0000 % |

### V22 — Cantilever propped by a spring

Reference: Compatibility: beam and spring in parallel

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| Tip deflection | P/(k_s + 3EI/L³) | -0.00993103 m | -0.00993103 m | 0.0000 % |
| Spring force | P·k_s/(k_s + 3EI/L³) | 24.8276 kN | 24.8276 kN | 0.0000 % |
| Fixed-end moment | (P − F_s)·L (hogging) | -44.6897 kN·m | -44.6897 kN·m | 0.0000 % |

### V23 — Natural frequencies of a simply supported beam (modal analysis)

Reference: Chopra, Dynamics of Structures, ch. 16: ω_n = (nπ)²·√(EI/mL⁴)

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| 1st circular frequency | π²·√(EI/mL⁴) | 169.482 rad/s | 169.482 rad/s | 0.0003 % |
| 2nd circular frequency | 4π²·√(EI/mL⁴) | 677.927 rad/s | 677.962 rad/s | 0.0052 % |
| 3rd circular frequency | 9π²·√(EI/mL⁴) | 1.5253e+3 rad/s | 1.5257e+3 rad/s | 0.0260 % |
| 1st frequency | ω₁/2π | 26.9739 Hz | 26.9740 Hz | 0.0003 % |

### V24 — Natural frequencies of a cantilever (modal analysis)

Reference: Chopra, Dynamics of Structures, ch. 16: ω_n = (β_n L)²·√(EI/mL⁴)

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| 1st circular frequency | 1.8751²·√(EI/mL⁴) | 135.849 rad/s | 135.849 rad/s | 0.0000 % |
| 2nd circular frequency | 4.6941²·√(EI/mL⁴) | 851.351 rad/s | 851.365 rad/s | 0.0016 % |
| 1st period | 2π/ω₁ | 0.0462512 s | 0.0462512 s | 0.0000 % |

### V25 — Influence lines for a simply supported beam

Reference: Hibbeler, Structural Analysis, ch. 6 (unit load moving across the span)

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| R_A with the load at L/4 | 1 − x/L | 0.750000 kN/kN | 0.750000 kN/kN | 0.0000 % |
| R_A with the load at 3L/4 | 1 − x/L | 0.250000 kN/kN | 0.250000 kN/kN | 0.0000 % |
| Peak of the midspan-moment line | L/4 | 2.00000 kN·m/kN | 2.00000 kN·m/kN | 0.0000 % |
| Midspan moment, load at L/4 | x/2 | 1.00000 kN·m/kN | 1.00000 kN·m/kN | 0.0000 % |
| Peak of the quarter-point moment line | 3L/16 | 1.50000 kN·m/kN | 1.50000 kN·m/kN | 0.0000 % |
| Position of that peak | L/4 | 2.00000 m | 2.00000 m | 0.0000 % |

### V26 — Influence line for the central reaction of a two-span continuous beam

Reference: Müller-Breslau / three-moment equation: R_B = x(3L² − x²)/2L³

| Quantity | Closed form | Expected | FrameForge | Error |
| --- | --- | ---: | ---: | ---: |
| R_B with the load at 0.3L | x(3L² − x²)/2L³ | 0.436500 kN/kN | 0.436500 kN/kN | 0.0000 % |
| R_B with the load at 0.5L | x(3L² − x²)/2L³ | 0.687500 kN/kN | 0.687500 kN/kN | 0.0000 % |
| R_B with the load at 0.8L | x(3L² − x²)/2L³ | 0.944000 kN/kN | 0.944000 kN/kN | 0.0000 % |
| R_B with the load over B | 1 | 1.00000 kN/kN | 1.00000 kN/kN | 0.0000 % |
| Support moment, load at 0.5L | −x(L² − x²)/4L² | -0.468750 kN·m/kN | -0.468750 kN·m/kN | 0.0000 % |
| Worst position for the support moment | L/√3 (between 0.5L and 0.6L) | 3.00000 m | 3.00000 m | 0.0000 % |
