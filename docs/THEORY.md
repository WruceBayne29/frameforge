# FrameForge theory manual

This document derives everything the FrameForge solver does, from first principles, in the
order the code does it. It is written for a student who has met statics and basic beam theory
and wants to see how those ideas become a general computer method.

The solver lives in `src/solver` and is written from scratch: no finite-element or linear-algebra
library is used. Every formula below is implemented there and checked against textbook
problems in `tests/validation`.

Sections: 1 overview, 2 sign conventions, 3 truss element, 4 frame element, 5 transformation,
6 assembly, 7 boundary conditions, 8 member loads, 9 end releases, 10 solving, 11 diagrams and
deflections, 12 IS 800:2007 design checks, 13 stretch features, 14 limitations, 15 references.

## 1. Overview of the direct stiffness method

A structure is treated as a set of **members** (elements) joined at **nodes**. The unknowns are
the node displacements. For a linear elastic structure, forces and displacements are related by

$$ K u = F $$

where $K$ is the global stiffness matrix, $u$ the vector of nodal displacements and $F$ the
vector of nodal forces. The method is a recipe for building and solving this system:

1. **Discretise.** Split the structure into members and nodes and number the degrees of freedom
   (DOFs).
2. **Element stiffness.** For each member, write the stiffness matrix $k_l$ that relates its end
   forces to its end displacements in the member's own (local) axes.
3. **Transform.** Rotate each $k_l$ into the global axes: $k_g = T^{T} k_l T$.
4. **Assemble.** Add every $k_g$ into the global matrix $K$ at the rows and columns of the DOFs
   the member connects. Assemble the load vector $F$ the same way.
5. **Apply boundary conditions.** Separate the free DOFs from the restrained ones.
6. **Solve.** Solve the reduced system for the free displacements.
7. **Recover forces.** Compute support reactions, member end forces, and the internal force
   diagrams $N(x)$, $V(x)$, $M(x)$ along each member.

For prismatic bar and beam members the element matrices are _exact_ solutions of the governing
differential equations, so one element per member gives the exact answer of linear beam theory.
There is no mesh-refinement error.

## 2. Sign conventions and degrees of freedom

These conventions are the ones used in the code. Everything else in this document follows from
them.

### 2.1 Global axes and nodal DOFs

- Global $X$ points right, global $Y$ points up.
- Rotations and moments are positive **counter-clockwise** (about global $Z$, out of the screen).
- Every node has three DOFs, in this order:

| Local index | Symbol     | Meaning                              | Matching force |
| ----------- | ---------- | ------------------------------------ | -------------- |
| 1           | $u_x$      | translation along global $X$         | $F_x$          |
| 2           | $u_y$      | translation along global $Y$         | $F_y$          |
| 3           | $\theta_z$ | rotation, counter-clockwise positive | $M_z$          |

With one-based numbering, node $n$ owns global DOFs $3n-2$, $3n-1$ and $3n$. A structure with
$n_n$ nodes has $3 n_n$ DOFs.

### 2.2 Member local axes

A member runs from its start node $i$ to its end node $j$.

- Local $x$ runs along the member from $i$ to $j$.
- Local $y$ is $90^\circ$ counter-clockwise from local $x$.

With node coordinates $(X_i, Y_i)$ and $(X_j, Y_j)$:

$$ L = \sqrt{(X_j - X_i)^2 + (Y_j - Y_i)^2}, \qquad c = \cos\theta = \frac{X_j - X_i}{L}, \qquad s = \sin\theta = \frac{Y_j - Y_i}{L} $$

The six local end displacements and the matching end forces (forces the nodes apply **to** the
member ends) are

$$ u_l = \begin{bmatrix} u_i & v_i & \theta_i & u_j & v_j & \theta_j \end{bmatrix}^{T}, \qquad f_l = \begin{bmatrix} f_1 & f_2 & f_3 & f_4 & f_5 & f_6 \end{bmatrix}^{T} $$

where $u$ is along local $x$, $v$ along local $y$ and $\theta$ is counter-clockwise.

### 2.3 Internal forces

At a section a distance $x$ from node $i$:

- **Axial force** $N$ is positive in **tension**.
- **Shear force** $V(x)$ is the sum of all local-$y$ forces acting on the part of the member to
  the **left** of the section (between $i$ and the section).
- **Bending moment** $M$ is positive when **sagging**, that is, when it puts the $-y$ face of
  the member in tension. With this choice the curvature relation has no minus sign:

$$ EI \frac{d^2 v}{dx^2} = M $$

Let $p(x)$ be a distributed load along local $x$ and $w(x)$ a distributed load along local $y$
(both per unit length, positive in the positive axis direction). Equilibrium of a short slice
gives

$$ \frac{dN}{dx} = -p, \qquad \frac{dV}{dx} = w, \qquad \frac{dM}{dx} = V, \qquad\text{so}\qquad EI \frac{d^4 v}{dx^4} = w $$

Note that gravity on a horizontal member drawn left to right is a load in the $-y$ direction, so
$w$ is negative.

The internal forces at the two ends are tied to the member end forces by

| Quantity | At end $i$ ($x = 0$) | At end $j$ ($x = L$) |
| -------- | -------------------- | -------------------- |
| $N$      | $-f_1$               | $+f_4$               |
| $V$      | $+f_2$               | $-f_5$               |
| $M$      | $-f_3$               | $+f_6$               |

The signs differ between the ends because end forces follow the fixed local axes while internal
forces follow a deformation convention. For example, a counter-clockwise moment applied at the
left end makes the member hog, so $M(0) = -f_3$.

## 3. The 2D truss (bar) element

A truss member carries axial force only. It has one DOF per end in local axes: $u_i$ and $u_j$.

### 3.1 Local stiffness

Assume the axial displacement varies linearly between the ends:

$$ u(x) = N_1(x) u_i + N_2(x) u_j, \qquad N_1 = 1 - \frac{x}{L}, \qquad N_2 = \frac{x}{L} $$

For a prismatic bar with loads only at its ends this is exact, because $EA u'' = 0$. The strain
is constant:

$$
\varepsilon = \frac{du}{dx} = B \begin{bmatrix} u_i \\ u_j \end{bmatrix}, \qquad B = \frac{1}{L}\begin{bmatrix} -1 & 1 \end{bmatrix}
$$

Hooke's law gives the axial force $N = EA \varepsilon = \dfrac{EA}{L}(u_j - u_i)$. The force on
end $j$ is $f_j = N$ and equilibrium requires $f_i = -N$, so

$$
\begin{bmatrix} f_i \\ f_j \end{bmatrix} = \frac{EA}{L}\begin{bmatrix} 1 & -1 \\ -1 & 1 \end{bmatrix} \begin{bmatrix} u_i \\ u_j \end{bmatrix}
$$

The same matrix follows from the strain energy $U = \tfrac12 \int_0^L EA \varepsilon^2 dx$,
which gives the general formula $k = \int_0^L B^{T} EA B dx$.

### 3.2 Global stiffness

A global displacement $(u_x, u_y)$ of a node moves it along the member axis by
$u = c u_x + s u_y$. So

$$
\begin{bmatrix} u_i \\ u_j \end{bmatrix} = T_t \begin{bmatrix} u_{xi} \\ u_{yi} \\ u_{xj} \\ u_{yj} \end{bmatrix}, \qquad T_t = \begin{bmatrix} c & s & 0 & 0 \\ 0 & 0 & c & s \end{bmatrix}
$$

and $k_g = T_t^{T} k_l T_t$ (see section 5 for why) is

$$
k_g = \frac{EA}{L}
\begin{bmatrix}
c^2 & cs & -c^2 & -cs \\
cs & s^2 & -cs & -s^2 \\
-c^2 & -cs & c^2 & cs \\
-cs & -s^2 & cs & s^2
\end{bmatrix}
$$

The axial force is recovered from the elongation:

$$ N = \frac{EA}{L}\left[ c (u_{xj} - u_{xi}) + s (u_{yj} - u_{yi}) \right] $$

In FrameForge every node keeps three DOFs, so a truss member is stored as a $6 \times 6$ matrix
whose rotation rows and columns are zero. If no member gives a node any rotational stiffness (a
pure pin joint), that rotation is fixed automatically so the system stays solvable; the user
does not need to add a fake restraint.

## 4. The 2D Euler–Bernoulli frame element

A frame member carries axial force, shear and bending. In local axes the axial and bending
actions are uncoupled (small displacements), so the two can be derived separately and combined.

### 4.1 Hermite cubic shape functions

With no load between the ends, $EI v'''' = 0$, so $v(x)$ is a cubic. A cubic has four
coefficients, fixed by the four bending DOFs $d = [v_i, \theta_i, v_j, \theta_j]^{T}$:

$$ v(x) = N_1 v_i + N_2 \theta_i + N_3 v_j + N_4 \theta_j = N(x) d $$

Writing $\xi = x/L$, the Hermite cubics are

$$
\begin{aligned}
N_1 &= 1 - 3\xi^2 + 2\xi^3, &\qquad N_2 &= L\left(\xi - 2\xi^2 + \xi^3\right), \\
N_3 &= 3\xi^2 - 2\xi^3, &\qquad N_4 &= L\left(\xi^3 - \xi^2\right)
\end{aligned}
$$

Each one equals 1 for its own DOF and 0 for the other three. For example $N_2(0) = 0$,
$N_2'(0) = 1$, $N_2(L) = 0$, $N_2'(L) = 0$.

### 4.2 Curvature and the stiffness integral

The curvature is $v'' = B d$ with $B = [N_1'', N_2'', N_3'', N_4'']$. Differentiating twice with
respect to $x$ (each derivative brings a factor $1/L$):

$$
\begin{aligned}
N_1'' &= \frac{-6 + 12\xi}{L^2}, &\qquad N_2'' &= \frac{-4 + 6\xi}{L}, \\
N_3'' &= \frac{6 - 12\xi}{L^2}, &\qquad N_4'' &= \frac{-2 + 6\xi}{L}
\end{aligned}
$$

The bending strain energy is

$$ U = \frac12 \int_0^L EI (v'')^2 dx = \frac12 d^{T} \left( \int_0^L B^{T} EI B dx \right) d $$

and since $U = \tfrac12 d^{T} k d$ for a linear elastic member,

$$ k = \int_0^L B^{T} EI B dx, \qquad k_{ab} = EI L \int_0^1 N_a'' N_b'' d\xi $$

Working through the integrals for constant $EI$:

$$
\begin{aligned}
k_{11} &= \frac{EI}{L^3}\int_0^1 (-6 + 12\xi)^2 d\xi = \frac{EI}{L^3}(36 - 72 + 48) = \frac{12EI}{L^3} \\
k_{12} &= \frac{EI}{L^2}\int_0^1 (-6 + 12\xi)(-4 + 6\xi) d\xi = \frac{EI}{L^2}(24 - 42 + 24) = \frac{6EI}{L^2} \\
k_{14} &= \frac{EI}{L^2}\int_0^1 (-6 + 12\xi)(-2 + 6\xi) d\xi = \frac{EI}{L^2}(12 - 30 + 24) = \frac{6EI}{L^2} \\
k_{22} &= \frac{EI}{L}\int_0^1 (-4 + 6\xi)^2 d\xi = \frac{EI}{L}(16 - 24 + 12) = \frac{4EI}{L} \\
k_{24} &= \frac{EI}{L}\int_0^1 (-4 + 6\xi)(-2 + 6\xi) d\xi = \frac{EI}{L}(8 - 18 + 12) = \frac{2EI}{L} \\
k_{44} &= \frac{EI}{L}\int_0^1 (-2 + 6\xi)^2 d\xi = \frac{EI}{L}(4 - 12 + 12) = \frac{4EI}{L}
\end{aligned}
$$

The remaining entries follow from $N_3'' = -N_1''$ and symmetry. The beam stiffness matrix is

$$
k_b = \frac{EI}{L^3}
\begin{bmatrix}
12 & 6L & -12 & 6L \\
6L & 4L^2 & -6L & 2L^2 \\
-12 & -6L & 12 & -6L \\
6L & 2L^2 & -6L & 4L^2
\end{bmatrix}
$$

Each column is the set of end forces needed to hold a unit value of one DOF with the others
zero. Column 2, for instance, says that rotating end $i$ by one radian needs a moment $4EI/L$
there, induces a carry-over moment $2EI/L$ at the far end, and needs shears $\pm 6EI/L^2$ for
equilibrium.

### 4.3 The full 6 × 6 local matrix

Adding the axial terms of section 3.1 at DOFs 1 and 4 gives the local frame stiffness for
$u_l = [u_i, v_i, \theta_i, u_j, v_j, \theta_j]^{T}$:

$$
k_l =
\begin{bmatrix}
\dfrac{EA}{L} & 0 & 0 & -\dfrac{EA}{L} & 0 & 0 \\
0 & \dfrac{12EI}{L^3} & \dfrac{6EI}{L^2} & 0 & -\dfrac{12EI}{L^3} & \dfrac{6EI}{L^2} \\
0 & \dfrac{6EI}{L^2} & \dfrac{4EI}{L} & 0 & -\dfrac{6EI}{L^2} & \dfrac{2EI}{L} \\
-\dfrac{EA}{L} & 0 & 0 & \dfrac{EA}{L} & 0 & 0 \\
0 & -\dfrac{12EI}{L^3} & -\dfrac{6EI}{L^2} & 0 & \dfrac{12EI}{L^3} & -\dfrac{6EI}{L^2} \\
0 & \dfrac{6EI}{L^2} & \dfrac{2EI}{L} & 0 & -\dfrac{6EI}{L^2} & \dfrac{4EI}{L}
\end{bmatrix}
$$

The matrix is symmetric (Maxwell–Betti reciprocity) and singular: it has three zero eigenvalues,
one for each rigid-body motion of a free member in the plane.

## 5. Coordinate transformation

### 5.1 The transformation matrix

Members point in different directions, but nodal equilibrium must be written in one common set
of axes. The local components of a node's displacement are projections of its global
components onto the local axes:

$$
\begin{bmatrix} u \\ v \\ \theta \end{bmatrix} = R \begin{bmatrix} u_x \\ u_y \\ \theta_z \end{bmatrix}, \qquad R = \begin{bmatrix} c & s & 0 \\ -s & c & 0 \\ 0 & 0 & 1 \end{bmatrix}
$$

The rotation is unchanged because local $z$ and global $Z$ coincide. Applying $R$ at both ends:

$$
u_l = T u_g, \qquad
T = \begin{bmatrix} R & 0 \\ 0 & R \end{bmatrix} =
\begin{bmatrix}
c & s & 0 & 0 & 0 & 0 \\
-s & c & 0 & 0 & 0 & 0 \\
0 & 0 & 1 & 0 & 0 & 0 \\
0 & 0 & 0 & c & s & 0 \\
0 & 0 & 0 & -s & c & 0 \\
0 & 0 & 0 & 0 & 0 & 1
\end{bmatrix}
$$

### 5.2 Why the global stiffness is a triple product

Forces do not transform with $T$ by assumption; the rule comes from virtual work. The work done
by the end forces in any virtual displacement must be the same number whichever axes are used
to compute it:

$$ \delta u_g^{T} f_g = \delta u_l^{T} f_l = (T \delta u_g)^{T} f_l = \delta u_g^{T} T^{T} f_l $$

This holds for every $\delta u_g$, so

$$ f_g = T^{T} f_l $$

Displacements transform with $T$ and forces with $T^{T}$ in the opposite direction. This pairing
is called **contragredience**. Substituting $f_l = k_l u_l$ and $u_l = T u_g$:

$$ f_g = T^{T} k_l T u_g \qquad\Longrightarrow\qquad k_g = T^{T} k_l T $$

Because $T$ is a rotation it is orthogonal ($T^{-1} = T^{T}$), but the virtual-work argument
does not rely on that. It also holds for the non-square truss matrix $T_t$ of section 3.2.

## 6. Global assembly

### 6.1 The scatter ("code number") method

Two conditions tie the members together at each node:

- **Compatibility.** All member ends meeting at a node share that node's displacements.
- **Equilibrium.** The external force on a node equals the sum of the end forces of the members
  attached to it.

Together they say that the global stiffness is the sum of the member stiffnesses, each placed at
the global DOFs it connects. Each member has a list of six **code numbers**, the global DOF
numbers of its ends:

$$ \text{code} = \begin{bmatrix} 3i-2 & 3i-1 & 3i & 3j-2 & 3j-1 & 3j \end{bmatrix} $$

Assembly is a double loop over the element matrix that adds each entry to the global matrix:

$$ K_{pq} \leftarrow K_{pq} + k_{ab}, \qquad p = \text{code}(a), \quad q = \text{code}(b), \quad a, b = 1 \dots 6 $$

where $k_{ab}$ is an entry of the member's global matrix $k_g$.

The load vector is built the same way: nodal loads go straight in, and member loads are added as
equivalent nodal loads (section 8) through the same code numbers.

The assembled $K$ is symmetric and sparse. Before supports are applied it is singular, because
the whole structure can still move as a rigid body.

### 6.2 Worked example: a two-bar truss

Units are kN and m. Three nodes: node 1 at $(0, 0)$, node 2 at $(4, 0)$, node 3 at $(4, 3)$.
Nodes 1 and 2 are pinned supports. Member 1 runs from node 1 to node 3 and member 2 from node 2
to node 3. Both have $EA = 60000$ kN ($E = 200$ GPa, $A = 3$ cm²). Node 3 carries
$F_x = +10$ kN and $F_y = -20$ kN.

The rotations carry no stiffness in a pure truss, so only the translations are listed here.
The DOFs are numbered $(1, 2)$ at node 1, $(3, 4)$ at node 2 and $(5, 6)$ at node 3.

**Member 1** (node 1 to node 3): $L = 5$, $c = 0.8$, $s = 0.6$, $EA/L = 12000$, code numbers
$(1, 2, 5, 6)$.

$$
k_g^{(1)} =
\begin{bmatrix}
7680 & 5760 & -7680 & -5760 \\
5760 & 4320 & -5760 & -4320 \\
-7680 & -5760 & 7680 & 5760 \\
-5760 & -4320 & 5760 & 4320
\end{bmatrix}
$$

**Member 2** (node 2 to node 3): $L = 3$, $c = 0$, $s = 1$, $EA/L = 20000$, code numbers
$(3, 4, 5, 6)$. Because $c = 0$, its matrix $k_g^{(2)}$ has only four non-zero entries: $+20000$
at positions $(2,2)$ and $(4,4)$, and $-20000$ at $(2,4)$ and $(4,2)$.

**Scatter.** Entry $(3,4)$ of $k_g^{(1)}$ goes to $K_{5,6}$ because the third and fourth code
numbers of member 1 are 5 and 6. Entry $(4,4)$ of both members lands on $K_{6,6}$, which becomes
$4320 + 20000 = 24320$. The result is

$$
K =
\begin{bmatrix}
7680 & 5760 & 0 & 0 & -7680 & -5760 \\
5760 & 4320 & 0 & 0 & -5760 & -4320 \\
0 & 0 & 0 & 0 & 0 & 0 \\
0 & 0 & 0 & 20000 & 0 & -20000 \\
-7680 & -5760 & 0 & 0 & 7680 & 5760 \\
-5760 & -4320 & 0 & -20000 & 5760 & 24320
\end{bmatrix}
$$

**Solve.** DOFs 1 to 4 are restrained and 5, 6 are free, so (section 7)

$$
\begin{bmatrix} 7680 & 5760 \\ 5760 & 24320 \end{bmatrix} \begin{bmatrix} u_5 \\ u_6 \end{bmatrix} = \begin{bmatrix} 10 \\ -20 \end{bmatrix}
\qquad\Longrightarrow\qquad
\begin{bmatrix} u_5 \\ u_6 \end{bmatrix} = \begin{bmatrix} 2.3333 \\ -1.3750 \end{bmatrix} \times 10^{-3} \text{ m}
$$

**Reactions.** $R = K_{rf} u_f$ gives $R_1 = -10$, $R_2 = -7.5$, $R_3 = 0$, $R_4 = +27.5$ kN.
Check: $\sum F_x = 10 - 10 = 0$ and $\sum F_y = -20 - 7.5 + 27.5 = 0$.

**Member forces.** From the elongation formula of section 3.2:

$$ N^{(1)} = 12000 \times (0.8 \times 2.3333 - 0.6 \times 1.3750) \times 10^{-3} = +12.5 \text{ kN (tension)} $$

$$ N^{(2)} = 20000 \times (-1.3750) \times 10^{-3} = -27.5 \text{ kN (compression)} $$

These agree with the method of joints at node 3.

## 7. Boundary conditions

### 7.1 Partitioning

Reorder the DOFs into **free** ($f$) and **restrained** ($r$) sets:

$$
\begin{bmatrix} K_{ff} & K_{fr} \\ K_{rf} & K_{rr} \end{bmatrix} \begin{bmatrix} u_f \\ u_r \end{bmatrix} = \begin{bmatrix} F_f \\ F_r + R \end{bmatrix}
$$

Here $u_f$ are the unknown displacements, $u_r$ the known support displacements (zero for a
rigid support), $F$ the applied loads (nodal loads plus equivalent nodal loads from member
loads) and $R$ the unknown reactions. The first block row gives the equations to solve:

$$ K_{ff} u_f = F_f - K_{fr} u_r $$

The second block row then gives the reactions:

$$ R = K_{rf} u_f + K_{rr} u_r - F_r $$

The $-F_r$ term matters. If a loaded member ends at a support, part of its equivalent nodal load
sits on a restrained DOF and goes directly into the support. Leaving the term out gives
reactions that do not balance the applied load.

Support types are just different sets of restrained DOFs at a node: a fixed support restrains
$(u_x, u_y, \theta_z)$, a pin restrains $(u_x, u_y)$, and a roller restrains one translation.

### 7.2 Prescribed settlements

A support settlement is a non-zero entry in $u_r$. Nothing else changes: the term $-K_{fr} u_r$
moves the effect of the settlement to the right-hand side as an equivalent load, and the
reaction formula already contains $K_{rr} u_r$. In a statically determinate structure a
settlement causes displacement but no forces; in an indeterminate one it causes both.

### 7.3 Spring supports

An elastic support with stiffness $k_s$ (force per length, or moment per radian) on DOF $m$
exerts a force $-k_s u_m$ on the structure. Moving this to the left-hand side adds the spring
stiffness to the diagonal:

$$ K_{mm} \leftarrow K_{mm} + k_s $$

The DOF stays in the free set. After solving, the spring reaction is $R_m = -k_s u_m$.

## 8. Member loads

The stiffness equations only know about forces at nodes. Loads applied between nodes are
handled in two stages, and the results are superposed.

### 8.1 Consistent (work-equivalent) nodal loads

Replace the member load by nodal loads that do the same virtual work. For a transverse load
$w(x)$ and a virtual displacement $\delta v = N \delta d$:

$$ \delta W = \int_0^L w \delta v dx = \delta d^{T} \int_0^L N^{T} w dx \qquad\Longrightarrow\qquad f_{eq} = \int_0^L N^{T} w dx $$

A point load $P$ at $x = a$ gives $f_{eq} = N(a)^{T} P$, and a point moment $M_0$ at $x = a$
does work on the slope, so $f_{eq} = N'(a)^{T} M_0$. Axial loads use the linear shape functions
of section 3.1 in the same way.

**Uniform load** $w$ over the whole span. Integrating each Hermite cubic:

$$ \int_0^L N_1 dx = \frac{L}{2}, \quad \int_0^L N_2 dx = \frac{L^2}{12}, \quad \int_0^L N_3 dx = \frac{L}{2}, \quad \int_0^L N_4 dx = -\frac{L^2}{12} $$

$$ f_{eq} = \begin{bmatrix} \dfrac{wL}{2} & \dfrac{wL^2}{12} & \dfrac{wL}{2} & -\dfrac{wL^2}{12} \end{bmatrix}^{T} $$

**Point load** $P$ at distance $a$ from end $i$, with $b = L - a$. Evaluating the shape
functions at $x = a$ and factorising:

$$ f_{eq} = P \begin{bmatrix} \dfrac{b^2 (3a + b)}{L^3} & \dfrac{a b^2}{L^2} & \dfrac{a^2 (a + 3b)}{L^3} & -\dfrac{a^2 b}{L^2} \end{bmatrix}^{T} $$

For example $N_2(a) = a (1 - a/L)^2 = a b^2 / L^2$. These are the familiar fixed-end formulas.

**Point moment** $M_0$ (counter-clockwise) at distance $a$:

$$ f_{eq} = M_0 \begin{bmatrix} -\dfrac{6ab}{L^3} & \dfrac{b (b - 2a)}{L^2} & \dfrac{6ab}{L^3} & \dfrac{a (a - 2b)}{L^2} \end{bmatrix}^{T} $$

**Axial loads.** A uniform axial load $p$ gives $pL/2$ at each end; a point axial load $P_x$ at
$a$ gives $P_x b/L$ at end $i$ and $P_x a/L$ at end $j$.

### 8.2 Numerical integration

FrameForge does not store a table of fixed-end formulas. It evaluates
$\int N^{T} w dx$ directly with Gauss–Legendre quadrature over the loaded length $[x_1, x_2]$:

$$ \int_{x_1}^{x_2} g(x) dx \approx \frac{x_2 - x_1}{2} \sum_{k=1}^{n} \omega_k g(x_k), \qquad x_k = \frac{x_1 + x_2}{2} + \frac{x_2 - x_1}{2} \xi_k $$

An $n$-point rule integrates polynomials up to degree $2n - 1$ exactly. A trapezoidal load is
linear in $x$ and the shape functions are cubic, so the integrand has degree 4 and three Gauss
points ($\xi_k = 0, \pm\sqrt{3/5}$ with weights $8/9, 5/9, 5/9$) already give the exact result.
One code path therefore handles full or partial, uniform or trapezoidal loads without
approximation. Point loads and point moments need no integration.

Loads given in global directions (such as self-weight on an inclined member) are first resolved
into local $x$ and $y$ components.

### 8.3 Fixed-end forces and superposition

Think of the analysis as two load cases:

1. **Restrained case.** Clamp every node. Each loaded member is then a fixed-ended beam, and
   its end forces are the **fixed-end forces** $f_{FEF}$.
2. **Nodal case.** Remove the clamps by applying the opposite of the clamping forces to the
   nodes, and solve $K u = F$.

By Betti's reciprocal theorem the fixed-end forces of a prismatic beam are exactly the negative
of the consistent loads:

$$ f_{FEF} = -f_{eq} $$

so the nodal case is loaded with $f_{eq}$, rotated to global axes by $T^{T}$ and assembled into
$F$. The real structure is the sum of the two cases. Node displacements come entirely from the
nodal case, and the final member end forces are

$$ f = k_l u_l + f_{FEF} $$

Check with a downward uniform load of intensity $q$ on a fixed-ended beam ($w = -q$, $u_l = 0$):
$f = f_{FEF} = [qL/2, qL^2/12, qL/2, -qL^2/12]^{T}$. Both end shears are upward, and
by the table in section 2.3 the end moments are $M(0) = -f_3 = -qL^2/12$ and
$M(L) = f_6 = -qL^2/12$, hogging at both ends as expected.

## 9. Member end releases

A release (internal hinge) means the member cannot transmit a particular end force to the node,
most often the moment at one end. The member end is then free to rotate independently of the
node.

### 9.1 Static condensation

Split the member's local DOFs into those **kept** ($k$, still connected to the node) and those
**released** ($r$). The member equations, including fixed-end forces, are

$$
\begin{bmatrix} f_k \\ f_r \end{bmatrix} = \begin{bmatrix} k_{kk} & k_{kr} \\ k_{rk} & k_{rr} \end{bmatrix} \begin{bmatrix} u_k \\ u_r \end{bmatrix} + \begin{bmatrix} f_k^{F} \\ f_r^{F} \end{bmatrix}
$$

where the superscript $F$ marks the fixed-end forces of section 8.3. The released end force is
zero, $f_r = 0$, and the second row gives the released displacement in terms of the kept ones:

$$ u_r = -k_{rr}^{-1} \left( k_{rk} u_k + f_r^{F} \right) $$

Substituting into the first row leaves a relation between kept quantities only,
$f_k = k^{\ast} u_k + f^{\ast}$, with

$$ k^{\ast} = k_{kk} - k_{kr} k_{rr}^{-1} k_{rk}, \qquad f^{\ast} = f_k^{F} - k_{kr} k_{rr}^{-1} f_r^{F} $$

The condensed matrix and vector are written back into $6 \times 6$ and $6 \times 1$ arrays with
zeros in the released rows and columns. Assembly then proceeds as usual and the global system
still has three DOFs per node. After solving, the formula for $u_r$ above recovers the released
end rotation, which is needed to draw the deflected shape.

### 9.2 Example: a pin at one end

Release $\theta_j$ in the beam matrix of section 4.2. Then $k_{rr} = 4EI/L$ and, for the kept
DOFs $(v_i, \theta_i, v_j)$, $k_{kr} = [6EI/L^2, 2EI/L, -6EI/L^2]^{T}$. Typical entries:

$$
\begin{aligned}
k^{\ast}_{11} &= \frac{12EI}{L^3} - \frac{L}{4EI}\left(\frac{6EI}{L^2}\right)^2 = \frac{3EI}{L^3} \\
k^{\ast}_{12} &= \frac{6EI}{L^2} - \frac{L}{4EI}\cdot\frac{6EI}{L^2}\cdot\frac{2EI}{L} = \frac{3EI}{L^2} \\
k^{\ast}_{22} &= \frac{4EI}{L} - \frac{L}{4EI}\left(\frac{2EI}{L}\right)^2 = \frac{3EI}{L}
\end{aligned}
$$

and in full

$$
k^{\ast} = \frac{EI}{L^3}
\begin{bmatrix}
3 & 3L & -3 \\
3L & 3L^2 & -3L \\
-3 & -3L & 3
\end{bmatrix}
\qquad \text{for } (v_i, \theta_i, v_j)
$$

This is the stiffness of a propped cantilever: the familiar $3EI/L^3$, $3EI/L^2$ and $3EI/L$
terms. A pin at end $i$ gives the mirror image, with the same magnitudes on $(v_i, v_j, \theta_j)$.

The fixed-end forces are condensed too. For a downward uniform load $q$ with the pin at $j$,
$f^{F} = [qL/2, qL^2/12, qL/2, -qL^2/12]^{T}$ and

$$
f^{\ast} = \begin{bmatrix} \dfrac{qL}{2} \\ \dfrac{qL^2}{12} \\ \dfrac{qL}{2} \end{bmatrix} - \begin{bmatrix} \dfrac{3}{2L} \\ \dfrac{1}{2} \\ -\dfrac{3}{2L} \end{bmatrix} \left( -\frac{qL^2}{12} \right) = \begin{bmatrix} \dfrac{5qL}{8} \\ \dfrac{qL^2}{8} \\ \dfrac{3qL}{8} \end{bmatrix}
$$

which are the textbook propped-cantilever reactions $5qL/8$, $3qL/8$ and fixed-end moment
$qL^2/8$.

Releasing both end moments removes all bending stiffness and leaves a truss member. If every
member at a node is released there, the node's rotation has no stiffness; this is the case
handled by the automatic rotational fix mentioned in section 3.2.

## 10. Solving the equations

### 10.1 Cholesky factorisation

The strain energy of the structure is $U = \tfrac12 u_f^{T} K_{ff} u_f$. For a stable structure
every possible displacement pattern stores some strain energy, so $U$ is positive for every
non-zero $u_f$. That is the definition of a **symmetric positive definite** (SPD) matrix, and
every SPD matrix has a Cholesky factorisation

$$ K_{ff} = L L^{T} $$

with $L$ lower triangular and a positive diagonal. Column by column, for $j = 1 \dots n$:

$$ L_{jj} = \sqrt{K_{jj} - \sum_{k=1}^{j-1} L_{jk}^2}, \qquad L_{ij} = \frac{1}{L_{jj}} \left( K_{ij} - \sum_{k=1}^{j-1} L_{ik} L_{jk} \right) \quad (i \gt j) $$

The system $L L^{T} u = F$ is then solved by two triangular sweeps: forward substitution for
$L y = F$, then back substitution for $L^{T} u = y$. Cholesky needs no pivoting, costs about
half of an LU factorisation, and the factor can be reused for any number of load vectors.

For the example of section 6.2:

$$
\begin{bmatrix} 7680 & 5760 \\ 5760 & 24320 \end{bmatrix} = \begin{bmatrix} 87.636 & 0 \\ 65.727 & 141.421 \end{bmatrix} \begin{bmatrix} 87.636 & 65.727 \\ 0 & 141.421 \end{bmatrix}
$$

Forward substitution gives $y = [0.11411, -0.19445]^{T}$ and back substitution returns
$u = [2.3333, -1.3750]^{T} \times 10^{-3}$ m, as before.

### 10.2 Detecting an unstable structure

The quantity under the square root,

$$ d_j = K_{jj} - \sum_{k=1}^{j-1} L_{jk}^2 $$

is called the **pivot**. Physically it is the stiffness felt at DOF $j$ when all earlier DOFs
are free to move and all later ones are held. If the structure is a **mechanism** (not enough
supports, or too many releases), some displacement pattern stores no strain energy, $K_{ff}$ is
singular, and a pivot comes out as zero. In floating-point arithmetic it comes out as a tiny
positive or negative number instead, so the test is

$$ d_j \le \varepsilon_{tol} \cdot \max_m K_{mm} $$

When this happens the code stops rather than dividing by a near-zero number and returning
enormous, meaningless displacements. It maps the free-DOF index $j$ back to its node and
direction ($u_x$, $u_y$ or $\theta_z$) and reports that the structure is unstable and that this
node is unrestrained in this direction. The DOF named is the one where the factorisation broke
down. It is always part of the mechanism, though other DOFs may be moving with it.

Two simple examples: a beam on two rollers has nothing resisting horizontal motion, so the
pivot of a $u_x$ DOF is zero. A span with three hinges in a line (one at each end and one
inside) can fold at the middle hinge, so the pivot of that node's $u_y$ DOF is zero.

## 11. Internal force diagrams and the deflected shape

### 11.1 Forces along the member by statics

Once the end forces $f = k_l u_l + f_{FEF}$ are known, the internal forces at any section follow
from the free body of the part of the member to the left of the section. No further stiffness
calculation is needed. For distributed loads $p(x)$, $w(x)$, point loads $P_{x,k}$, $P_{y,k}$
at $x = a_k$ and point moments $M_k$ (counter-clockwise) at $x = a_k$:

$$
\begin{aligned}
N(x) &= -f_1 - \int_0^x p(t) dt - \sum_{a_k \lt x} P_{x,k} \\
V(x) &= f_2 + \int_0^x w(t) dt + \sum_{a_k \lt x} P_{y,k} \\
M(x) &= -f_3 + f_2 x + \int_0^x w(t) (x - t) dt + \sum_{a_k \lt x} P_{y,k} (x - a_k) - \sum_{a_k \lt x} M_k
\end{aligned}
$$

The signs follow section 2.3: an upward force to the left of a section causes sagging there, and
a counter-clockwise couple to the left causes hogging. Differentiating confirms $dM/dx = V$ and
$dV/dx = w$. The values at $x = L$ must equal $N = f_4$, $V = -f_5$, $M = f_6$, which is a
useful closing check on the whole calculation.

For a full-span uniform load the diagrams are a line and a parabola:

$$ V(x) = f_2 + w x, \qquad M(x) = -f_3 + f_2 x + \tfrac12 w x^2 $$

For a simply supported beam under downward load $q$ ($w = -q$, $f_2 = qL/2$, $f_3 = 0$) this
gives $M = qLx/2 - qx^2/2$, with the familiar maximum $qL^2/8$ at midspan. In general the
moment is extreme where $V = 0$ or at a point load or member end.

### 11.2 Deflected shape

The Hermite cubics describe the deflection exactly only for a member with no load on its span.
For the true shape FrameForge integrates the curvature relation $v'' = M / EI$ twice. Define

$$ g(x) = \frac{1}{EI} \int_0^x (x - t) M(t) dt $$

which is the double integral of $M/EI$ with $g(0) = 0$ and $g'(0) = 0$. The general solution is
$v = g(x) + C_1 x + C_2$. The two constants are fixed by the **chord conditions**, that is, by
making the curve pass through the known transverse displacements of the two ends, $v(0) = v_i$
and $v(L) = v_j$:

$$ v(x) = v_i + (v_j - v_i) \frac{x}{L} + g(x) - \frac{x}{L} g(L) $$

The first two terms are the straight chord between the displaced ends; the last two are the
bending deflection measured from that chord. Using the end translations rather than the end
rotations means the same formula works for members with released ends, where the member-end
rotation differs from the node rotation.

The axial displacement follows from $u' = N / EA$:

$$ u(x) = u_i + \frac{1}{EA} \int_0^x N(t) dt $$

The local pair $(u, v)$ is rotated back to global axes for plotting, and multiplied by a display
scale factor because real deflections are too small to see.

## 12. Design checks to IS 800:2007

This section summarises the limit-state checks in `src/design-codes`. It is a study aid, not a
substitute for the code itself.

**Notation.** IS 800 calls the member axis $x$, the major principal axis of the cross-section
$z$–$z$ and the minor axis $y$–$y$. This differs from the local axes of section 2. For a member
in a 2D frame with its web in the plane of the frame, the analysis moment $M$ is the major-axis
moment $M_z$ and $M_y = 0$.

Material and partial safety factors: $E = 2 \times 10^5$ MPa, $G = 0.769 \times 10^5$ MPa,
$\gamma_{m0} = 1.10$ (yielding and buckling), $\gamma_{m1} = 1.25$ (ultimate stress), and

$$ \varepsilon = \sqrt{250 / f_y} \qquad (f_y \text{ in MPa}) $$

### 12.1 Section classification (Table 2)

The class limits how much of the section's strength can be used before local buckling.

| Element                                   | Ratio     | Plastic (1)      | Compact (2)       | Semi-compact (3)  |
| ----------------------------------------- | --------- | ---------------- | ----------------- | ----------------- |
| Outstand of rolled compression flange     | $b / t_f$ | $9.4\varepsilon$ | $10.5\varepsilon$ | $15.7\varepsilon$ |
| Web in bending, neutral axis at mid-depth | $d / t_w$ | $84\varepsilon$  | $105\varepsilon$  | $126\varepsilon$  |
| Web in uniform axial compression          | $d / t_w$ | not applicable   | not applicable    | $42\varepsilon$   |

Here $b$ is half the flange width for an I-section and $d$ is the depth of the web clear of the
root fillets. The section takes the class of its worst element; anything beyond the
semi-compact limit is slender (class 4). Table 2 gives further limits for webs under combined
bending and axial force.

### 12.2 Tension (cl. 6.2)

Design strength governed by yielding of the gross section:

$$ T_{dg} = \frac{A_g f_y}{\gamma_{m0}} $$

Rupture of the net section (cl. 6.3, $T_{dn} = 0.9 A_n f_u / \gamma_{m1}$ for plates) and block
shear (cl. 6.4) depend on connection details, which a line-element model does not contain.

### 12.3 Compression (cl. 7.1.2)

Flexural buckling is checked with Perry–Robertson type curves. For effective length $KL$ and
radius of gyration $r$ about the axis considered:

$$ f_{cc} = \frac{\pi^2 E}{(KL/r)^2}, \qquad \lambda = \sqrt{\frac{f_y}{f_{cc}}} = \frac{KL}{\pi r} \sqrt{\frac{f_y}{E}} $$

$$ \phi = 0.5 \left[ 1 + \alpha (\lambda - 0.2) + \lambda^2 \right] $$

$$ f_{cd} = \frac{f_y / \gamma_{m0}}{\phi + \sqrt{\phi^2 - \lambda^2}} \le \frac{f_y}{\gamma_{m0}}, \qquad P_d = A_e f_{cd} $$

$f_{cc}$ is the Euler buckling stress and $\lambda$ the non-dimensional slenderness. The
imperfection factor $\alpha$ (Table 7) accounts for initial crookedness and residual stress:

| Buckling curve | a    | b    | c    | d    |
| -------------- | ---- | ---- | ---- | ---- |
| $\alpha$       | 0.21 | 0.34 | 0.49 | 0.76 |

The curve depends on the section and axis (Table 10). For rolled I-sections with
$t_f \le 40$ mm: curve a about $z$–$z$ and b about $y$–$y$ when $h / b_f \gt 1.2$; curve b about
$z$–$z$ and c about $y$–$y$ when $h / b_f \le 1.2$. Channels, angles and tees use curve c. The
smaller of the two axis strengths governs. Table 11 gives effective length factors, for example
$K = 1.0$ pinned–pinned, $0.65$ fixed–fixed, $0.8$ fixed–pinned and $2.0$ for a cantilever.

### 12.4 Bending (cl. 8.2)

**Laterally supported beams (cl. 8.2.1.2)**, with design shear $V \le 0.6 V_d$:

$$ M_d = \frac{\beta_b Z_p f_y}{\gamma_{m0}} \le \frac{1.2 Z_e f_y}{\gamma_{m0}} $$

with $\beta_b = 1.0$ for plastic and compact sections and $\beta_b = Z_e / Z_p$ for semi-compact
sections. $Z_p$ and $Z_e$ are the plastic and elastic section moduli. The upper limit is
$1.5 Z_e f_y / \gamma_{m0}$ for cantilevers. When $V \gt 0.6 V_d$ the moment capacity is reduced
(cl. 9.2.2):

$$ M_{dv} = M_d - \beta (M_d - M_{fd}) \le \frac{1.2 Z_e f_y}{\gamma_{m0}}, \qquad \beta = \left( \frac{2V}{V_d} - 1 \right)^2 $$

where $M_{fd}$ is the plastic design strength of the section without its shear area.

**Laterally unsupported beams (cl. 8.2.2).** Lateral–torsional buckling (LTB) reduces the
design bending stress:

$$ M_d = \beta_b Z_p f_{bd}, \qquad f_{bd} = \frac{\chi_{LT} f_y}{\gamma_{m0}} $$

$$ \chi_{LT} = \frac{1}{\phi_{LT} + \sqrt{\phi_{LT}^2 - \lambda_{LT}^2}} \le 1.0, \qquad \phi_{LT} = 0.5 \left[ 1 + \alpha_{LT} (\lambda_{LT} - 0.2) + \lambda_{LT}^2 \right] $$

$$ \lambda_{LT} = \sqrt{\frac{\beta_b Z_p f_y}{M_{cr}}} \le \sqrt{\frac{1.2 Z_e f_y}{M_{cr}}} $$

with $\alpha_{LT} = 0.21$ for rolled and $0.49$ for welded sections. No LTB reduction is needed
when $\lambda_{LT} \le 0.4$. The elastic critical moment for a doubly symmetric section with
effective length $L_{LT}$ (cl. 8.2.2.1) is

$$ M_{cr} = \sqrt{ \frac{\pi^2 E I_y}{L_{LT}^2} \left( G I_t + \frac{\pi^2 E I_w}{L_{LT}^2} \right) } $$

where $I_y$ is the minor-axis second moment of area, $I_t$ the torsion constant and $I_w$ the
warping constant ($I_w = I_y h_f^2 / 4$ for a doubly symmetric I-section, $h_f$ being the
distance between flange centroids). The code also gives a simplified form for such sections:

$$ M_{cr} = \frac{\pi^2 E I_y h_f}{2 L_{LT}^2} \sqrt{ 1 + \frac{1}{20} \left( \frac{L_{LT} / r_y}{h_f / t_f} \right)^2 } $$

### 12.5 Shear (cl. 8.4)

$$ V_d = \frac{V_n}{\gamma_{m0}}, \qquad V_n = V_p = \frac{A_v f_{yw}}{\sqrt{3}} $$

The shear area for major-axis bending of an I-section or channel is $A_v = h t_w$ for
hot-rolled sections and $d t_w$ for welded ones. This plastic shear strength applies when the
web is stocky, $d / t_w \le 67\varepsilon$; more slender webs need a shear buckling check
(cl. 8.4.2).

### 12.6 Combined axial force and bending (cl. 9.3)

**Section strength (cl. 9.3.1.1).** For plastic and compact sections:

$$ \left( \frac{M_y}{M_{ndy}} \right)^{\alpha_1} + \left( \frac{M_z}{M_{ndz}} \right)^{\alpha_2} \le 1.0 $$

where $M_{ndy}$, $M_{ndz}$ are the bending strengths reduced for axial force (cl. 9.3.1.2) and
$\alpha_1$, $\alpha_2$ come from Table 17 (for I-sections and channels, $\alpha_1 = 5n \ge 1$
and $\alpha_2 = 2$ with $n = N / N_d$). The code permits the conservative linear form, which is
also the rule for semi-compact sections:

$$ \frac{N}{N_d} + \frac{M_y}{M_{dy}} + \frac{M_z}{M_{dz}} \le 1.0, \qquad N_d = \frac{A_g f_y}{\gamma_{m0}} $$

**Overall member strength in bending and axial compression (cl. 9.3.2.2).** Both of the
following must hold:

$$ \frac{P}{P_{dy}} + K_y \frac{C_{my} M_y}{M_{dy}} + K_{LT} \frac{M_z}{M_{dz}} \le 1.0 $$

$$ \frac{P}{P_{dz}} + 0.6 K_y \frac{C_{my} M_y}{M_{dy}} + K_z \frac{C_{mz} M_z}{M_{dz}} \le 1.0 $$

with the interaction factors

$$
\begin{aligned}
K_y &= 1 + (\lambda_y - 0.2) n_y \le 1 + 0.8 n_y \\
K_z &= 1 + (\lambda_z - 0.2) n_z \le 1 + 0.8 n_z \\
K_{LT} &= 1 - \frac{0.1 \lambda_{LT} n_y}{C_{mLT} - 0.25} \ge 1 - \frac{0.1 n_y}{C_{mLT} - 0.25}
\end{aligned}
$$

Here $P_{dy}$, $P_{dz}$ are the compression strengths of section 12.3 about each axis,
$n_y = P / P_{dy}$, $n_z = P / P_{dz}$, $\lambda_y$ and $\lambda_z$ are the non-dimensional
slendernesses, $M_{dz}$ includes LTB (section 12.4), and $C_{my}$, $C_{mz}$, $C_{mLT}$ are the
equivalent uniform moment factors of Table 18. For a moment diagram varying linearly between
end moments $M$ and $\psi M$ ($-1 \le \psi \le 1$), $C_m = 0.6 + 0.4\psi \ge 0.4$; for sway
buckling modes $C_m = 0.9$.

In a 2D frame $M_y = 0$ and the two checks reduce to

$$ \frac{P}{P_{dy}} + K_{LT} \frac{M_z}{M_{dz}} \le 1.0, \qquad \frac{P}{P_{dz}} + K_z \frac{C_{mz} M_z}{M_{dz}} \le 1.0 $$

For bending with axial tension (cl. 9.3.2.1) the tension relieves the compression flange, and
the check is $M_{eff} = M - \psi T Z_{ec} / A \le M_d$.

The **utilisation ratio** shown for a member is the largest demand-to-capacity ratio over all
the checks; a value above 1.0 means the member fails.

## 13. Stretch features

### 13.1 Influence lines

An influence line for a response $R$ (a reaction, or the shear or moment at a fixed section)
plots the value of $R$ against the position of a moving unit load.

**Unit-load method.** Place a unit load at a series of positions along the load path, solve
$K u = F$ for each, and record $R$. Only the right-hand side changes, so $K_{ff}$ is factorised
once and each position costs only a forward and a back substitution.

**Müller-Breslau principle.** The influence line for $R$ has the same shape as the deflection of
the structure when the restraint that carries $R$ is removed and a unit displacement (or unit
relative rotation or slip, for moment or shear) is imposed in its place. The proof is Betti's
theorem applied to the released structure. In system A the unit load acts at $x$ together with
$R$ at the release; in system B the unit displacement is imposed and the structure deflects by
$y(x)$. The forces of A do work $R \cdot 1 - 1 \cdot y(x)$ on the displacements of B (with $y$
measured opposite to the load), and the forces of B do no work on A because A has no
displacement at the release. Hence

$$ R = y(x) $$

For statically determinate structures the released structure is a mechanism, so influence lines
are made of straight segments; for indeterminate structures they are curved.

### 13.2 Modal analysis

For free vibration the inertia forces $-M \ddot{u}$ join the elastic forces: $M \ddot{u} + K u = 0$.
Trying $u = \phi \sin \omega t$ gives the **generalised eigenproblem**

$$ K \phi = \omega^2 M \phi $$

Each solution is a natural circular frequency $\omega$ (rad/s, with $f = \omega / 2\pi$ in Hz)
and its mode shape $\phi$.

The **consistent mass matrix** uses the same shape functions as the stiffness. From the kinetic
energy $\tfrac12 \int \rho A \dot{v}^2 dx$ with $v = N d$:

$$ m = \int_0^L \rho A N^{T} N dx $$

For the bending DOFs $(v_i, \theta_i, v_j, \theta_j)$ of a beam of density $\rho$ this is

$$
m_b = \frac{\rho A L}{420}
\begin{bmatrix}
156 & 22L & 54 & -13L \\
22L & 4L^2 & 13L & -3L^2 \\
54 & 13L & 156 & -22L \\
-13L & -3L^2 & -22L & 4L^2
\end{bmatrix}
$$

and for the axial DOFs $(u_i, u_j)$, using the linear shape functions,

$$
m_a = \frac{\rho A L}{6} \begin{bmatrix} 2 & 1 \\ 1 & 2 \end{bmatrix}
$$

The element mass matrix is transformed and assembled exactly like the stiffness
($m_g = T^{T} m_l T$). One standard route to the solution reuses the Cholesky factor
$K_{ff} = L L^{T}$ of section 10 to turn the generalised problem into a standard symmetric one,

$$ \left( L^{-1} M_{ff} L^{-T} \right) y = \frac{1}{\omega^2} y, \qquad \phi = L^{-T} y $$

whose largest eigenvalues are the lowest frequencies. Unlike the static solution, a modal
solution is approximate with one element per member, because the true vibration shape is not a
cubic; splitting members into several elements improves the higher modes. A good test case is
the simply supported beam, whose exact frequencies are

$$ \omega_n = (n\pi)^2 \sqrt{\frac{EI}{\rho A L^4}}, \qquad n = 1, 2, 3, \dots $$

## 14. Assumptions and limitations

- **Linear elastic material.** Stress is proportional to strain; no yielding, cracking or
  plastic hinges. The design checks compare elastic analysis forces with code capacities.
- **Small displacements.** Equilibrium is written on the undeformed geometry, so results scale
  linearly with load and superposition holds.
- **No second-order effects.** P-Δ and P-δ effects, geometric stiffness and elastic buckling
  loads are not computed. Slender sway frames need a second-order analysis or amplified
  moments, as IS 800 requires.
- **Euler–Bernoulli beams.** Plane sections remain plane and normal to the axis; shear
  deformation is neglected. This is accurate for span-to-depth ratios above about 10 and
  underestimates deflection for deep, short members.
- **Prismatic, straight members.** $E$, $A$ and $I$ are constant along each member. Tapered or
  curved members must be approximated by several short straight ones.
- **2D only.** Loads and displacements lie in the $X$–$Y$ plane. There is no torsion, biaxial
  bending or out-of-plane behaviour in the analysis. Lateral–torsional buckling enters only
  through the design check, which needs an unbraced length for each member.
- **Idealised joints and supports.** Joints are perfectly rigid or perfectly pinned (plus
  linear springs at supports). Joint size, connection flexibility and member offsets are
  ignored.
- **Static loading**, apart from the free-vibration analysis of section 13.2. No damping or
  time-history response.
- **Design checks are a summary.** They cover the common clauses for rolled sections listed in
  section 12 and do not replace an engineer's reading of IS 800:2007.

FrameForge is an educational tool. Do not use it as the only basis for the design of a real
structure.

## 15. References

1. W. McGuire, R. H. Gallagher and R. D. Ziemian, _Matrix Structural Analysis_, 2nd ed., Wiley,
   2000.
2. A. Kassimali, _Matrix Analysis of Structures_, 2nd ed., Cengage Learning, 2012.
3. R. C. Hibbeler, _Structural Analysis_, 10th ed., Pearson, 2018.
4. W. Weaver Jr. and J. M. Gere, _Matrix Analysis of Framed Structures_, 3rd ed., Van Nostrand
   Reinhold, 1990.
5. IS 800:2007, _General Construction in Steel — Code of Practice_ (Third Revision), Bureau of
   Indian Standards, New Delhi.
6. SP 6(1):1964, _Handbook for Structural Engineers — Structural Steel Sections_, Bureau of
   Indian Standards, New Delhi.
7. N. Subramanian, _Design of Steel Structures_, Oxford University Press, 2008.
