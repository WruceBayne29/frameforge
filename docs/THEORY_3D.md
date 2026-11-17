# FrameForge 3D theory manual

This document describes what the 3D solver in `src/solver3d` actually does: the degrees of
freedom and sign conventions, the four element formulations, the loads, the assembly, and the
sparse direct solver. It assumes the 2D manual ([THEORY.md](THEORY.md)), which derives the
direct stiffness method, Hermite shape functions, consistent nodal loads and static condensation
from first principles; those derivations are not repeated here.

The solver is unit-agnostic (any consistent units) and has no dependencies. Every element module
returns a stiffness matrix and an equivalent nodal load vector in global axes (`contract.ts`);
the assembler (`analyze.ts`) knows nothing about the formulations. The results are checked
against 20 reference problems in [VALIDATION_3D.md](../VALIDATION_3D.md) and by the unit tests
next to each module.

Sections: 1 axes and degrees of freedom, 2 truss and beam elements, 3 plate (flat shell)
element, 4 solid (hexahedron) element, 5 assembly and supports, 6 sparse solver and mechanisms,
7 limitations, 8 references.

## 1. Axes and degrees of freedom

Global axes are right-handed with **Y up** (X and Z horizontal), so the 2D solver's XY plane is
the $z = 0$ plane of the 3D one. Every node has six degrees of freedom, in this order:

$$ d = [\,u_x,\ u_y,\ u_z,\ \theta_x,\ \theta_y,\ \theta_z\,] $$

with the matching forces $[F_x, F_y, F_z, M_x, M_y, M_z]$. Rotations and moments are vectors
and follow the right-hand rule. Elements use the DOFs they need:

| Element | Nodes | DOFs used per node | Element DOFs |
| --- | ---: | --- | ---: |
| Truss | 2 | $u_x, u_y, u_z$ | 6 |
| Beam | 2 | all six | 12 |
| Plate | 4 | all six | 24 |
| Solid | 8 | $u_x, u_y, u_z$ | 24 |

A DOF that no element, spring or support gives any stiffness (a rotation at a joint where only
truss bars or solids meet) is left out of the equations (section 5.3).

## 2. Truss and beam elements (`line.ts`, `lineLoads.ts`)

### 2.1 Member local axes

Local $x$ runs from node $i$ to node $j$: $e_x = (X_j - X_i)/L$. With roll angle $\beta = 0$:

- **Member not vertical** — local $z$ is horizontal and local $y$ points "web up":
  $$ e_{z0} = \frac{e_x \times \hat Y}{\lVert e_x \times \hat Y \rVert}, \qquad e_{y0} = e_{z0} \times e_x , $$
  so $e_{y0}$ always has a positive global-Y component. A member along $+X$ has local axes equal
  to the global axes; a horizontal member along $+Z$ has $e_y = \hat Y$, $e_z = -\hat X$.
- **Member vertical** (horizontal projection of $e_x$ below $10^{-9}$) — local $z$ is global Z:
  $e_{y0} = \hat Z \times e_x / \lVert\cdot\rVert$, $e_{z0} = e_x \times e_{y0}$. A column
  drawn upwards therefore has $e_y = -\hat X$, $e_z = \hat Z$.

The roll angle then turns $y$ and $z$ about $x$ (right-hand rule):

$$ e_y = \cos\beta\, e_{y0} + \sin\beta\, e_{z0}, \qquad e_z = \cos\beta\, e_{z0} - \sin\beta\, e_{y0} . $$

$I_z$ is the second moment of area for bending in the local $x$–$y$ plane (the strong axis of an
I-section with the web along $y$) and $I_y$ for bending in the $x$–$z$ plane.

### 2.2 Local stiffness

Local DOFs are $[u, v, w, \theta_x, \theta_y, \theta_z]_i$ followed by the same six at $j$. The
beam is the Euler–Bernoulli space-frame element: four uncoupled actions, each the exact solution
of its differential equation for a prismatic member.

**Axial** ($u_i, u_j$) and **torsion** ($\theta_{xi}, \theta_{xj}$, uniform St Venant torsion,
no warping):

$$ \frac{EA}{L}\begin{bmatrix} 1 & -1 \\ -1 & 1 \end{bmatrix}, \qquad
   \frac{GJ}{L}\begin{bmatrix} 1 & -1 \\ -1 & 1 \end{bmatrix} $$

**Bending in the $x$–$y$ plane** ($v_i, \theta_{zi}, v_j, \theta_{zj}$, with
$\theta_z = dv/dx$) — identical to the 2D frame element:

$$
\frac{EI_z}{L^3}
\begin{bmatrix}
12 & 6L & -12 & 6L \\
6L & 4L^2 & -6L & 2L^2 \\
-12 & -6L & 12 & -6L \\
6L & 2L^2 & -6L & 4L^2
\end{bmatrix}
$$

**Bending in the $x$–$z$ plane** ($w_i, \theta_{yi}, w_j, \theta_{yj}$). A positive rotation
about $y$ turns $+x$ towards $-z$, so $\theta_y = -dw/dx$ and every term that couples a
translation with a rotation changes sign:

$$
\frac{EI_y}{L^3}
\begin{bmatrix}
12 & -6L & -12 & -6L \\
-6L & 4L^2 & 6L & 2L^2 \\
-12 & 6L & 12 & 6L \\
-6L & 2L^2 & 6L & 4L^2
\end{bmatrix}
$$

The four blocks are placed at local indices $\{0, 6\}$, $\{3, 9\}$, $\{1, 5, 7, 11\}$ and
$\{2, 4, 8, 10\}$ of the $12 \times 12$ matrix $k_l$; all other coefficients are zero. A truss
member keeps only the axial block and uses the three translations per node.

Bending in the $x$–$z$ plane is the mirror image of the $x$–$y$ case: in the right-handed frame
$(x, y' = z, z' = -y)$ it is ordinary $x$–$y$ bending with $v' = w$, $\theta_z' = -\theta_y$,
$F_y' = F_z$ and $M_z' = -M_y$. Every sign difference between the two planes, in the stiffness,
the loads and the recovered forces, comes from this mapping.

### 2.3 Transformation to global axes

With $R$ the $3 \times 3$ matrix whose rows are $e_x, e_y, e_z$ (global components), local and
global displacements of one node are related by $u_l = R\,u_g$ for the translations and the
rotations alike, so

$$ T = \operatorname{diag}(R, R, R, R), \qquad k_g = T^{T} k_l\, T, \qquad f_g = T^{T} f_l . $$

For a truss the rotational rows and columns are zero and are dropped, leaving a $6 \times 6$
matrix in $[u_x, u_y, u_z]_i, [u_x, u_y, u_z]_j$.

### 2.4 End releases

Any of the six local end forces $f_x, f_y, f_z, m_x, m_y, m_z$ may be released at either end
(beams only). The released DOFs $r$ are condensed out of the element before transformation,
exactly as in 2D:

$$ k^{\ast} = k_{kk} - k_{kr}\,k_{rr}^{-1}\,k_{rk}, \qquad
   f^{\ast} = f_k - k_{kr}\,k_{rr}^{-1}\,f_r . $$

The code eliminates one released DOF at a time (Gaussian elimination on the $12 \times 12$
matrix), which gives the same result and leaves the released rows and columns exactly zero, so
the global DOF count stays at six per node. If a pivot $k_{rr}$ has already vanished because the
releases let the member move as a rigid body in that mode (torsion released at both ends, for
example), the DOF is simply removed; if the member carries load in that mode the analysis stops
with an error naming the member.

### 2.5 Member loads

Loads are first resolved into local components: a load along a global axis with intensity $q$
per unit length of member becomes $q\,(\hat g \cdot e_x,\ \hat g \cdot e_y,\ \hat g \cdot e_z)$.
Supported loads are uniform or linearly varying distributed loads over $[a, b]$, concentrated
forces and concentrated moments at distance $a$ from node $i$, and self-weight
$\rho A\,g$ per unit length.

Work-equivalent nodal loads $f_l = \int_0^L N^{T} w\,dx$ use Hermite cubics for transverse forces
(their derivatives for concentrated moments about $y$ or $z$) and linear functions for axial
force and torque. The integrals are evaluated with 3-point Gauss quadrature between load
discontinuities, which is exact for these loads. For a uniform load $w_y$, $w_z$ over the whole
member:

$$ F_{y,i} = F_{y,j} = \frac{w_y L}{2}, \quad M_{z,i} = -M_{z,j} = \frac{w_y L^2}{12}; \qquad
   F_{z,i} = F_{z,j} = \frac{w_z L}{2}, \quad M_{y,i} = -M_{y,j} = -\frac{w_z L^2}{12}. $$

A truss bar uses linear functions throughout: transverse loads go to the joints as simple-beam
reactions, a transverse moment $M$ becomes the couple $\mp M/L$, and a torque about the bar's
own axis cannot be carried (it is dropped with a warning).

### 2.6 Recovering forces and the deflected shape

Member end forces, the forces exerted by the joints on the member in local axes, are

$$ f_e = k^{\ast}_l\,u_l - f^{\ast}_l , $$

and released components come out exactly zero. Internal forces at a section $x$ follow from the
free body of the part between node $i$ and the section, with these conventions
(`Station3D`):

- $N$ — axial force, tension positive: $N(x) = -F_{x,i} - \int_0^x w_x\,ds$.
- $V_y$, $V_z$ — the sum of the local-$y$ / local-$z$ forces on the $i$-side part.
- $T$ — the local-$x$ moment the $j$-side part exerts on the $i$-side part.
- $M_z$ such that $E I_z v'' = M_z$ and $M_y$ such that $E I_y w'' = M_y$, so that
  $dM_z/dx = V_y$ and $dM_y/dx = V_z$, and a beam in the XY plane gives the same $V$ and $M$ as
  the 2D solver. At node $i$: $M_z(0) = -M_{z,i}$ and $M_y(0) = +M_{y,i}$.

Stations are placed at equal divisions, at both sides of every concentrated load and at the
points of zero shear in each plane, so the extremes are captured exactly. The member's own
deflected shape is obtained by integrating $N/EA$, $T/GJ$, $M_z/EI_z$ and $M_y/EI_y$ (3-point
Gauss between stations, exact for these polynomials); the two integration constants in each
plane come from end conditions that are not released.

## 3. Plate element: 4-node flat shell (`plate.ts`)

The plate is a flat quadrilateral shell with six DOFs per node, built in its own local axes from
three uncoupled parts — membrane, bending (with transverse shear) and drilling — and rotated to
global axes node by node.

### 3.1 Local axes and geometry

For nodes $X_1 \ldots X_4$ listed counter-clockwise when seen from the $+z$ side, with diagonals
$d_1 = X_3 - X_1$ and $d_2 = X_4 - X_2$:

$$ e_z = \frac{d_1 \times d_2}{\lVert d_1 \times d_2 \rVert}, \qquad
   e_x \parallel (d_1 - d_2) \text{ made normal to } e_z, \qquad e_y = e_z \times e_x . $$

$(d_1 - d_2)/2$ is the vector from the midpoint of edge 4–1 to the midpoint of edge 2–3, so
$e_x$ runs "across" the element from that edge to the opposite one. The mean plane passes
through the centroid of the nodes, normal to $e_z$; the element is formulated on the nodes
projected onto it, with local coordinates $(x_i, y_i)$ and projected area $\tfrac12\lVert d_1
\times d_2\rVert$. The warp measure is the largest out-of-plane node distance divided by
$\sqrt{A}$; above 0.01 a warning is issued. The Jacobian of the bilinear map must be positive at
the four corners (it varies linearly), which rejects re-entrant, collinear and bow-tie shapes.

Bilinear shape functions $N_i = \tfrac14(1 + \xi_i\xi)(1 + \eta_i\eta)$ interpolate the
geometry and every displacement field; all integrals use $2 \times 2$ Gauss quadrature.

### 3.2 Membrane: QM6 incompatible modes

The in-plane displacements are enriched with two bubble functions per component whose
amplitudes $a_1 \ldots a_4$ are internal to the element:

$$ u = \sum N_i u_i + (1 - \xi^2) a_1 + (1 - \eta^2) a_2, \qquad
   v = \sum N_i v_i + (1 - \xi^2) a_3 + (1 - \eta^2) a_4 . $$

They supply the quadratic terms in-plane bending needs and remove the shear locking of the
plain bilinear element. In the modified form of Taylor, Beresford and Wilson (QM6), the
derivatives of the extra functions are taken with the Jacobian at the element centre $J_0$ and
scaled by $\det J_0 / \det J$:

$$ \begin{bmatrix} \partial P/\partial x \\ \partial P/\partial y \end{bmatrix}
   = \frac{\det J_0}{\det J}\, J_0^{-1}
   \begin{bmatrix} \partial P/\partial \xi \\ \partial P/\partial \eta \end{bmatrix}. $$

Then $\int \partial P / \partial x\,dA = \det J_0\,J_0^{-1} \int \partial P/\partial\xi\,d\xi\,
d\eta = 0$ for any element shape, so a constant stress does no work on the extra modes and the
element passes the membrane patch test when distorted. With strains
$\varepsilon_m = [\varepsilon_x, \varepsilon_y, \gamma_{xy}]^T = B_c u + B_a a$ and

$$ D_m = \frac{E t}{1 - \nu^2}\begin{bmatrix} 1 & \nu & 0 \\ \nu & 1 & 0 \\ 0 & 0 & \tfrac{1-\nu}{2} \end{bmatrix}, $$

the element equations are condensed (no load acts on $a$):

$$ a = -K_{aa}^{-1} K_{ac}\,u, \qquad k_m = K_{cc} - K_{ca} K_{aa}^{-1} K_{ac} . $$

The $4 \times 8$ recovery matrix $-K_{aa}^{-1}K_{ac}$ is kept for the stresses.

### 3.3 Bending: Mindlin–Reissner plate with MITC4 shear

The nodal rotations $\theta_x, \theta_y$ are components of the rotation vector. A material line
normal to the mid-surface moves in-plane by $\theta \times (z\,e_z) = (z\theta_y, -z\theta_x)$,
which defines the section rotations $\beta_x = \theta_y$, $\beta_y = -\theta_x$. Curvatures
(strain $= z\,\kappa$) and transverse shear strains are

$$ \kappa = \begin{bmatrix} \partial\beta_x/\partial x \\ \partial\beta_y/\partial y \\
   \partial\beta_x/\partial y + \partial\beta_y/\partial x \end{bmatrix}
   = \begin{bmatrix} \partial\theta_y/\partial x \\ -\partial\theta_x/\partial y \\
   \partial\theta_y/\partial y - \partial\theta_x/\partial x \end{bmatrix}, \qquad
   \gamma_{xz} = \frac{\partial w}{\partial x} + \theta_y, \quad
   \gamma_{yz} = \frac{\partial w}{\partial y} - \theta_x . $$

In the thin (Kirchhoff) limit $\gamma = 0$, so $\theta_x = \partial w/\partial y$,
$\theta_y = -\partial w/\partial x$ and $\kappa_x = -\partial^2 w/\partial x^2$.

Interpolating $w$, $\theta_x$, $\theta_y$ with the same bilinear functions makes the shear
strains lock in thin plates. MITC4 (Bathe and Dvorkin) replaces them by an assumed field. The
covariant shear strains of the displacement interpolation,

$$ \gamma_{\xi z} = \frac{\partial w}{\partial \xi} + \beta_x \frac{\partial x}{\partial \xi}
   + \beta_y \frac{\partial y}{\partial \xi}, \qquad
   \gamma_{\eta z} = \frac{\partial w}{\partial \eta} + \beta_x \frac{\partial x}{\partial \eta}
   + \beta_y \frac{\partial y}{\partial \eta}, $$

are sampled at the edge midpoints A $(0, 1)$, C $(0, -1)$ for $\gamma_{\xi z}$ and B $(1, 0)$,
D $(-1, 0)$ for $\gamma_{\eta z}$, interpolated as

$$ \tilde\gamma_{\xi z} = \tfrac12(1 + \eta)\,\gamma_{\xi z}^{A} + \tfrac12(1 - \eta)\,\gamma_{\xi z}^{C},
   \qquad
   \tilde\gamma_{\eta z} = \tfrac12(1 + \xi)\,\gamma_{\eta z}^{B} + \tfrac12(1 - \xi)\,\gamma_{\eta z}^{D}, $$

and transformed to Cartesian components with
$[\gamma_{xz}, \gamma_{yz}]^T = J^{-1}[\tilde\gamma_{\xi z}, \tilde\gamma_{\eta z}]^T$. The
section matrices are

$$ D_b = \frac{E t^3}{12(1 - \nu^2)}\begin{bmatrix} 1 & \nu & 0 \\ \nu & 1 & 0 \\ 0 & 0 & \tfrac{1-\nu}{2} \end{bmatrix},
   \qquad D_s = \kappa\,G\,t\,I_2, \quad \kappa = \tfrac56 , $$

and $k_b = \int (B_b^T D_b B_b + B_s^T D_s B_s)\,dA$ over $[w, \theta_x, \theta_y]$ at the four
nodes. The element passes the bending patch test on distorted meshes and shows no shear locking
down to $a/t = 1000$ (unit tests in `plate.test.ts`).

### 3.4 Drilling rotation

A flat shell has no natural stiffness for $\theta_z$, which makes coplanar assemblies singular.
A penalty ties the nodal drilling rotations to the in-plane continuum rotation of the compatible
displacements:

$$ \Pi_d = \tfrac12\,\gamma\,G\,t \int_A (\theta_z - \omega)^2\,dA, \qquad
   \omega = \tfrac12\left(\frac{\partial v}{\partial x} - \frac{\partial u}{\partial y}\right),
   \qquad \gamma = 10^{-3} . $$

The term is invariant under rigid-body motion, so the element has exactly six zero-energy
modes, and it is small enough not to stiffen the membrane noticeably.

### 3.5 Element matrix in global axes

The membrane ($u, v$), bending ($w, \theta_x, \theta_y$) and drilling ($u, v, \theta_z$) parts
are scattered into a $24 \times 24$ local matrix (they are uncoupled in local axes) and rotated
with $T = \operatorname{diag}(R, \ldots, R)$ (eight blocks, translations and rotations of four
nodes), $R$ having rows $e_x, e_y, e_z$: $k_g = T^T k_l T$. Membrane–bending coupling in a
curved shell arises only from the different orientations of neighbouring facets, which is the
classical flat-facet approximation.

### 3.6 Loads

A uniform pressure $p$ along the plate normal or a global axis, and self-weight
$\rho\,t\,g$, are distributed with $f_i = \int N_i\,p\,dA$ (exact with $2 \times 2$ Gauss). A
point force at natural coordinates $(\xi, \eta)$ goes to the nodes as $N_i(\xi, \eta)\,P$.
Element loads produce nodal forces only (no nodal moments).

### 3.7 Stress resultants and sign conventions

At each Gauss point the membrane forces, moments and shear forces per unit width are

$$ [N_x, N_y, N_{xy}] = D_m\,\varepsilon_m, \qquad [M_x, M_y, M_{xy}] = D_b\,\kappa, \qquad
   [Q_x, Q_y] = D_s\,\gamma , $$

with $N = \int \sigma\,dz$, $M = \int \sigma z\,dz$ and $Q = \int \tau\,dz$ in the plate's local
axes. Positive $M_x$ puts the top ($+z$) surface in tension along local $x$: a plate sagging
under a pressure along $-z$ has $M_x < 0$. Values at the four corners are extrapolated
bilinearly from the Gauss points (which sit at $\pm 1/\sqrt3$, so a corner is at $\pm\sqrt3$ in
their own coordinates); the centre value is evaluated directly. Surface stresses are

$$ \sigma_{top/bottom} = \frac{N}{t} \pm \frac{6M}{t^2}, $$

with principal stresses $\sigma_{1,2}$ and the plane-stress von Mises value
$\sqrt{\sigma_1^2 - \sigma_1\sigma_2 + \sigma_2^2}$ at each surface. Results are element values
and are not averaged between elements; the contour plots average the corner values at a node for
display.

## 4. Solid element: 8-node hexahedron (`solid.ts`)

### 4.1 Geometry and compatible part

Nodes 1–4 form one face, ordered so that their right-hand normal points to the opposite face
5–8 (node 5 above node 1, and so on). Natural coordinates $(\xi, \eta, \zeta) \in [-1, 1]^3$
with trilinear shape functions

$$ N_i = \tfrac18 (1 + \xi_i\xi)(1 + \eta_i\eta)(1 + \zeta_i\zeta) . $$

The Jacobian determinant must be positive at the centre, the eight Gauss points and the eight
corners, otherwise the element is rejected as inverted or too distorted. Strains are ordered
$[\varepsilon_{xx}, \varepsilon_{yy}, \varepsilon_{zz}, \gamma_{xy}, \gamma_{yz},
\gamma_{zx}]$ with engineering shear strains, and the isotropic material matrix is

$$ D = \begin{bmatrix} \lambda + 2\mu & \lambda & \lambda & & & \\
\lambda & \lambda + 2\mu & \lambda & & & \\ \lambda & \lambda & \lambda + 2\mu & & & \\
& & & \mu & & \\ & & & & \mu & \\ & & & & & \mu \end{bmatrix}, \qquad
\lambda = \frac{E\nu}{(1+\nu)(1-2\nu)}, \quad \mu = \frac{E}{2(1+\nu)} . $$

### 4.2 Incompatible modes

The plain trilinear brick locks in bending (parasitic shear). Each displacement component gets
the three extra functions $M_k = 1 - \xi_k^2$ ($\xi_1 = \xi$, $\xi_2 = \eta$, $\xi_3 = \zeta$)
with element-internal amplitudes, nine in all (Wilson, Taylor, Doherty and Ghaboussi). In the
modified form of Taylor, Beresford and Wilson their derivatives use the centre Jacobian,

$$ \frac{\partial M_k}{\partial x} = \frac{\det J_0}{\det J}\, J_0^{-1}\,
   \frac{\partial M_k}{\partial \xi}, \qquad
   \frac{\partial M_k}{\partial \xi} = -2\,\xi_k\,e_k , $$

so that $\int \partial M_k/\partial x\,dV = 0$ for any element shape and the element passes the
patch test when distorted. With $\varepsilon = B u + G \alpha$ and $2 \times 2 \times 2$ Gauss
quadrature,

$$ \begin{bmatrix} K_{uu} & K_{u\alpha} \\ K_{\alpha u} & K_{\alpha\alpha} \end{bmatrix}
   \begin{bmatrix} u \\ \alpha \end{bmatrix} = \begin{bmatrix} f \\ 0 \end{bmatrix}
   \ \Rightarrow\
   \alpha = -K_{\alpha\alpha}^{-1} K_{\alpha u}\,u, \qquad
   k = K_{uu} - K_{u\alpha} K_{\alpha\alpha}^{-1} K_{\alpha u} . $$

The element is built directly in global axes; with rectangular (parallelepiped) elements it
reproduces pure bending exactly, one element through the depth. Because the
extra modes carry no load, a stress that varies inside an element in the direction of a load
gradient (self-weight, a moment gradient) is represented by its element mean in that direction.

### 4.3 Loads

A uniform load on a face (pressure along the inward normal, or a traction along a global axis)
is integrated with $2 \times 2$ Gauss points on the bilinear face, using
$n\,dA = (\partial x/\partial s \times \partial x/\partial t)\,ds\,dt$ with the faces ordered so
that this normal points out of the solid; this is exact for flat faces and consistent for warped
ones. Self-weight $\rho g$ is integrated over the volume with $2 \times 2 \times 2$ Gauss. Both
become consistent nodal forces of the compatible shape functions.

### 4.4 Stress recovery

Stresses $\sigma = D(Bu + G\alpha)$ are evaluated at the eight Gauss points and extrapolated
trilinearly to the eight nodes (a corner sits at $\pm\sqrt3$ in the Gauss points' own natural
coordinates) and to the centre, which is the mean of the eight Gauss values. Principal stresses
come from the eigenvalues of the $3 \times 3$ tensor and von Mises from
$\sqrt{\tfrac12[(\sigma_1-\sigma_2)^2 + (\sigma_2-\sigma_3)^2 + (\sigma_3-\sigma_1)^2]}$.
Solid stresses are in global axes and are element values, not averaged between elements.

## 5. Assembly and supports (`analyze.ts`)

### 5.1 Assembly

Each element returns $k_g$ and $f_g$ in its own DOF order; the assembler maps them to global DOF
numbers (code-number method) and adds them into the global matrix $K$ and the load vector
$F = F_{nodal} + \sum f_g$. Only the upper triangle inside the skyline profile is stored
(section 6).

### 5.2 Supports, settlements and springs

Restrained DOFs $r$ may have prescribed values $u_r$ (settlements); springs add their stiffness
to the diagonal of otherwise free DOFs. The free displacements solve

$$ K_{ff}\,u_f = F_f - K_{fr}\,u_r , $$

and the reactions are recovered element by element as the nodal forces the elements need,
$r = \sum (k_g u_e - f_g)$, minus the applied nodal load, at restrained DOFs; a spring reaction
is $-k\,u$. The result reports $\sum$ loads $+$ reactions (forces, and moments about the origin)
as an equilibrium check.

### 5.3 Inactive degrees of freedom

A DOF whose diagonal is below $10^{-12}$ times the largest diagonal of its kind (translation or
rotation) and that is not restrained has no stiffness at all. It is removed from the equations.
A loaded translation of that kind (a truss bar loaded across its axis with nothing else at the
node) is an error; a moment at such a joint is ignored with a warning, as is a load on a node
that no element uses.

## 6. Sparse solver and mechanisms (`sparse.ts`)

### 6.1 Equation numbering

The node graph (two nodes are adjacent when an element connects them) is numbered by **reverse
Cuthill–McKee**: breadth-first from a pseudo-peripheral node of each connected component
(George–Liu search started at a minimum-degree node), neighbours visited in order of increasing
degree, ties broken by index, and the sequence reversed. The free active DOFs are then numbered
node by node in that order. This keeps the non-zeros near the diagonal.

### 6.2 Skyline $LDL^T$ factorisation

Column $j$ of the upper triangle is stored from its first non-zero row $m_j$ down to the
diagonal. Elimination creates fill only inside this profile, so the factor needs no extra
memory. The matrix is factorised as $K = U^T D\,U$ with $U$ unit upper triangular, column by
column (active-column scheme):

$$ g_{ij} = a_{ij} - \sum_{k = \max(m_i, m_j)}^{i-1} u_{ki}\,g_{kj}, \qquad
   u_{ij} = \frac{g_{ij}}{d_i}, \qquad
   d_j = a_{jj} - \sum_{i=m_j}^{j-1} u_{ij}\,g_{ij} , $$

followed by forward substitution, division by $D$ and back substitution. No square roots are
taken, so the sign of every pivot is available. A 30 × 30 plate mesh (5,580 equations) is
assembled, solved and post-processed in about half a second.

### 6.3 Mechanisms

A pivot $d_j \le 10^{-10}\,|a_{jj}|$ (or not finite) means $K_{ff}$ is singular at equation $j$:
a mechanism. Instead of stopping, the factorisation treats that DOF as restrained (it deletes
row and column $j$ and sets $u_j = 0$) and continues. After the solve, the force needed to hold
each such DOF is the residual $r_j = (\sum k_g u_e - f_g)_j - F_j$:

- $|r_j| \le 10^{-6}$ times the load scale: the loads do not excite the mechanism (a beam on two
  pins that could spin about its own axis, a node whose only stiffness is a released member
  end). The DOF stays held and a warning names the node and direction.
- otherwise: the structure is unstable under these loads, and the analysis stops with an error
  naming the node and direction ("mechanism detected at node N4, translation along Z").

This keeps the common modelling shortcuts working while never returning a solution that violates
equilibrium.

## 7. Limitations

- Linear elastic, small displacements; no P-Δ, buckling, cracking or yielding.
- Beams are Euler–Bernoulli (no shear deformation) with uniform torsion (no warping); the
  shear centre coincides with the centroid.
- Plates are flat facets. A warped quadrilateral is analysed on its projection onto the mean
  plane, without rigid-link corrections, and loads are integrated over the projected area. Plate
  loads give nodal forces only.
- Solid and plate stresses are element values; there is no stress smoothing or error estimate.
- The UI computes the torsion constant of rolled sections as $\sum b t^3/3$, ignoring fillets.
- One load case per analysis.

## 8. References

1. Bathe, K.-J. and Dvorkin, E. N. (1985). A four-node plate bending element based on
   Mindlin/Reissner plate theory and a mixed interpolation. *Int. J. Numer. Meth. Engng* 21,
   367–383.
2. Dvorkin, E. N. and Bathe, K.-J. (1984). A continuum mechanics based four-node shell element
   for general nonlinear analysis. *Engineering Computations* 1, 77–88.
3. Wilson, E. L., Taylor, R. L., Doherty, W. P. and Ghaboussi, J. (1973). Incompatible
   displacement models. In *Numerical and Computer Methods in Structural Mechanics*, Academic
   Press, 43–57.
4. Taylor, R. L., Beresford, P. J. and Wilson, E. L. (1976). A non-conforming element for
   stress analysis. *Int. J. Numer. Meth. Engng* 10, 1211–1219.
5. Allman, D. J. (1984). A compatible triangular element including vertex rotations for plane
   elasticity analysis. *Computers & Structures* 19, 1–8 (drilling rotations).
6. Hughes, T. J. R. and Brezzi, F. (1989). On drilling degrees of freedom. *Comput. Methods
   Appl. Mech. Engrg* 72, 105–121.
7. Cook, R. D., Malkus, D. S., Plesha, M. E. and Witt, R. J. (2002). *Concepts and Applications
   of Finite Element Analysis*, 4th ed. Wiley.
8. Bathe, K.-J. (2014). *Finite Element Procedures*, 2nd ed.
9. Przemieniecki, J. S. (1968). *Theory of Matrix Structural Analysis*. McGraw-Hill (space
   frame element).
10. McGuire, W., Gallagher, R. H. and Ziemian, R. D. (2000). *Matrix Structural Analysis*, 2nd
    ed. Wiley (local axes, releases).
11. George, A. and Liu, J. W. H. (1981). *Computer Solution of Large Sparse Positive Definite
    Systems*. Prentice-Hall (reverse Cuthill–McKee, envelope / skyline storage).
12. MacNeal, R. H. and Harder, R. L. (1985). A proposed standard set of problems to test finite
    element accuracy. *Finite Elements in Analysis and Design* 1, 3–20.
13. Timoshenko, S. P. and Woinowsky-Krieger, S. (1959). *Theory of Plates and Shells*, 2nd ed.
    McGraw-Hill.
