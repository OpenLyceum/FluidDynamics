# Fluid Dynamics — Model

## Overview

An incompressible viscous fluid flows left to right through a two-dimensional
channel past a fixed body. The simulation exists to make one thing visible: as
the Reynolds number rises, the wake behind the body changes character — from
smooth attached flow, to a steady pair of recirculation bubbles, to a periodic
Kármán vortex street, to a wake that has lost coherence altogether.

The learner controls the flow speed (Intro) or the speed, viscosity and body
(Lab). What actually decides the wake's character is the single dimensionless
group those combine into, which is why it is displayed next to the flow.

## Quantities and units

| Symbol | Quantity | Unit | Range |
|---|---|---|---|
| **u** | velocity field | m/s | — |
| *p* | pressure (divided by density) | m²/s | — |
| ω | vorticity, ∂v/∂x − ∂u/∂y | 1/s | — |
| *U* | inflow speed | m/s | 0.05 – 3 |
| ν | kinematic viscosity | m²/s | 3×10⁻⁴ – 10⁻¹ |
| *D* | obstacle diameter | m | 0.05 – 0.8 |
| *L* × *H* | channel size | m | 2 × 1 |
| *h* | grid cell size | m | 1/128 (standard), 1/256 (fine), 1/512 (very fine), 1/1024 (ultra fine) |
| Re | Reynolds number, *UD*/ν | — | ≈0.08 – 8000 |

Density is not a separate quantity: it is constant, and dividing the momentum
equation through by it leaves the kinematic viscosity and a pressure in m²/s.
Nothing in the simulation depends on the fluid's actual density.

## Governing equations

The incompressible Navier–Stokes equations:

```
∂u/∂t + (u·∇)u = −∇p + ν∇²u + f
∇·u = 0
```

and a passive tracer (the dye) carried by the flow without affecting it:

```
∂c/∂t + (u·∇)c = −κc
```

## Solution method

Jos Stam's *Stable Fluids* operator splitting, one pass per term, all in WGSL
compute shaders. Each frame advances the velocity field through:

1. **Advection** — (u·∇)u, by semi-Lagrangian backtrace with bilinear
   interpolation, followed by a MacCormack predictor–corrector that cancels most
   of the backtrace's numerical diffusion. A bound-preserving limiter keeps the
   corrected value inside the original departure stencil's range, so the step is
   unconditionally stable at any timestep and no more dissipative than the scheme it replaces.
   The backtrace is a midpoint (RK2) step: an Euler trace follows the velocity at
   the arrival point for the whole step and so cuts the corner on curved paths,
   which in a vortex means the vortex slowly drifts toward its own centre.
2. **Diffusion** — ν∇²u, solved implicitly: (I − νΔt∇²)u = u₀, by red-black SOR.
   Implicit because the explicit stability limit Δt < h²/4ν is far below one
   frame at the high-viscosity end of the range. The number of sweeps and the
   over-relaxation factor are both derived from the solve's stiffness
   α = νΔt/h² rather than fixed — see below. The loop is skipped when α collapses
   to zero (the paused path), where every sweep is the identity and only the
   seeding dispatch is needed.
3. **Vorticity confinement** — a correction, not a physical term. See below.
4. **Forcing and boundaries** — inflow, outflow, walls, and the learner's
   pointer.
5. **Projection** — ∇·u is computed, ∇²p = ∇·u is solved by red-black successive
   over-relaxation (30 alternating red/black sweeps, 50 with the higher-accuracy
   preference), and ∇p is subtracted. By the Helmholtz–Hodge decomposition this
   leaves the divergence-free part of the field, which is what incompressibility
   means. Red-black ordering runs Gauss–Seidel in parallel, and over-relaxation
   (ω = 1.7) squares the per-sweep error reduction, so the same dispatch budget
   leaves far less residual divergence than the Jacobi solve it replaced.

Where the obstacle is, is not recomputed per stencil: the body's signed distance
is baked into a grid-sized texture whenever it moves, because the analytic SDF
was being evaluated tens of millions of times a frame for an answer that changes
only when the learner drags the body.

The dye is then injected at the inflow and advected by the finished velocity
field, through the same MacCormack predictor–corrector, since the tracer's own
numerical diffusion is what the learner actually sees.

The optional tracer dots are the Lagrangian counterpart of that Eulerian dye:
massless, neutrally buoyant marker particles carried by the same finished
velocity field, integrated with a midpoint (RK2) step for the same reason the
backtrace uses one. They have no effect on the flow. Being particles rather than
a field, they suffer none of advection's numerical diffusion — a dot stays a dot
however far it travels — but they inherit every error in the velocity field that
carries them, and a dot that reaches the body is removed rather than allowed to
creep along a surface where the discrete no-slip condition has already brought
the velocity to zero.

### How hard the iterative solves are made to work

Both the viscous solve and the pressure solve are stationary iterations stopped
short of convergence, and neither is a place where a fixed sweep count is the
right answer at every setting.

**The viscous solve is scheduled from its stiffness.** α = νΔt/h² grows with the
square of the resolution: at ν = 10⁻³ m²/s and Δt = 1/60 s it is 0.27 on the
256 × 128 grid and 17 on the 2048 × 1024 one. Jacobi reduces the error by at most
4α/(1 + 4α) per sweep — 0.52 at the first, 0.986 at the second — so twelve fixed
Jacobi sweeps solved the coarse grid to ten significant figures and left roughly
85 % of the error on the fine one. The fine grids were quietly *less* viscous
than the slider said, which pushes the effective Reynolds number the wrong way
exactly where a learner has gone looking for more accuracy.

Red-black SOR at the optimal factor for that α — ω = 2(1 + 4α)/(1 + 4α + √(1+8α)),
Young's formula written without trigonometry — converges at ω − 1 per sweep
instead: 0.08 and 0.71 for the same two cases. The sweep count is then whatever
reaches a relative error of 10⁻³, capped at twelve iterations. Measured against a
converged reference on a representative source field, the relative error after
the scheduled sweeps is:

| α | old: 12 Jacobi sweeps | new: scheduled red-black SOR | dispatches |
|---|---|---|---|
| 0.08 | 1×10⁻¹⁰ | 1×10⁻⁵ | 12 → 5 |
| 0.27 | 3×10⁻⁶ | 1×10⁻⁴ | 12 → 7 |
| 1 | 2×10⁻³ | 4×10⁻⁴ | 12 → 11 |
| 5 | 7×10⁻² | 1×10⁻³ | 12 → 23 |
| 17.5 | 3×10⁻¹ | 2×10⁻² | 12 → 25 |
| 27.3 | 6×10⁻¹ | 4×10⁻² | 12 → 25 |

The cheap end gives up accuracy nobody could see for less than half the work;
the stiff end costs twice the dispatches and is one to two orders of magnitude
closer to the viscosity it claims.

**The pressure solve's ω is not the textbook value, and that is deliberate.**
Young's formula puts the optimum at 1.962 on the standard grid, rising toward 2
as the grid is refined, and simulation confirms that value wins in the regime
the formula assumes: a fixed right-hand side, iterated many times over. This
solve is not in that regime. It is warm-started, given a fixed budget of thirty
sweeps, and handed a right-hand side that has moved by the next frame, so it
spends its life smoothing new error rather than converging old error — and
over-relaxation near 2 is a poor smoother. Simulated across the grid sizes and
sweep budgets the sim offers, the residual left at the end of a frame is flat
between ω = 1.7 and 1.8 and climbs steeply above 1.85. It stays at 1.7.

### Grid

Cell-centred and collocated — velocity, pressure, dye and vorticity all live at
the same points. 256 × 128 cells over the 2 m × 1 m channel by default, 512 × 256
on the Lab screen's fine setting, 1024 × 512 on very fine, and 2048 × 1024 on ultra
fine. Cells are square at every resolution.

### Boundary conditions

| Boundary | Condition |
|---|---|
| Inflow (left) | **u** = (*U*(t), small perturbation), where *U*(t) ramps toward the slider |
| Outflow (right) | ∂**u**/∂x = 0 with *u*ₓ ≥ 0 (no re-entry), *p* = 0 |
| Top and bottom walls | free slip: *v* = 0, *u* unconstrained |
| Obstacle surface | no slip: **u** = 0; ∂p/∂n = 0 |

The Neumann pressure condition on the obstacle is what makes the body solid. Left
out, the projection pushes fluid straight through it and no wake forms at all.

**Why the inflow ramps.** The inflow is a Dirichlet condition and the projection
is incompressible, which together make a step change of speed singularly
unphysical: the pressure solve answers globally and instantly, and the transient
reflects off the *p* = 0 outflow hard enough to drive the whole column backward
at up to several times the *old* speed (measured at −2.2 m/s for a bare channel
dropping from 3 m/s to 0.3). The solver therefore approaches the slider's value
exponentially with time constant `FLOW_SPEED_RESPONSE_TIME`, which is the
inertia a real channel's inlet has; readouts still track the slider directly.
While the inflow is settling, the pressure solve is run at its high sweep count,
because an under-converged projection is what over-drains the channel's momentum
through the outflow and rings it into reverse. The outflow strip, in turn, never
copies a backward axial velocity into the channel: the *p* = 0 condition models
a reservoir at reference pressure, and a reservoir does not push back. Together
these hold the worst reversal of the same 3 → 0.3 drop to −0.08 m/s (bare
channel) and −0.34 m/s (with a shedding wake), where shed vortices crossing the
outflow plane legitimately carry patches of backward flow.

## Simplifications and assumptions

**Two dimensions.** Real turbulence is three-dimensional: vortex stretching, the
mechanism that drives the energy cascade to small scales, does not exist in 2D.
What the high-Reynolds-number end of this simulation shows is a 2D wake that has
lost coherence, which looks turbulent and is not. The laminar and vortex-shedding
regimes, which are genuinely two-dimensional phenomena, are faithful.

**The displayed Reynolds number is nominal.** Re = *UD*/ν is computed from the
values the learner set. The *effective* Reynolds number is lower, because
advection is itself dissipative — even with the MacCormack corrector a residual
dissipation of order *h*|**u**|/2 remains, though an order of magnitude smaller
than plain semi-Lagrangian would leave. At the default grid it is still
comparable to the physical viscosity in the middle of its range. The error that
used to push in the *other* direction — an under-converged viscous solve making
the fluid thinner than the slider says — is what the scheduled diffusion sweeps
above remove. The regime
boundaries in `FlowRegime.ts` are the classical values for a circular cylinder
(Re ≈ 5, 47 and 200), and the solver was tuned to reproduce the matching
*behaviour* at those nominal numbers rather than the labels being moved to fit
the solver.

**Vorticity confinement is not physics.** Advection still damps the smallest
resolved eddies within a few steps — exactly the scale of the vortices being
shed, and the MacCormack corrector reduces but does not eliminate that damping.
Confinement (Fedkiw, Stam & Jensen 2001) adds a force along the gradient of |ω|
that pushes rotation back toward its concentrations, restoring what the numerics
removed. It adds energy to the flow, so it is a visual-fidelity knob, not a term
in Navier–Stokes.

Its strength is scaled by *h*|**u**|/2 ÷ (*h*|**u**|/2 + ν), the fraction of the
total damping that is numerical. This matters: at full strength it destabilises
wakes that should be steady, and a cylinder at Re ≈ 15 sheds vortices it has no
business shedding. With the scaling, the low-Reynolds-number end shows the
attached symmetric wake it should.

**The inflow is slightly perturbed.** Flow past a cylinder is symmetric about the
centreline, and so is the grid; a perfectly symmetric initial condition stays
symmetric forever and never sheds, at any Reynolds number. Real flow escapes this
because no laboratory inflow is perfectly uniform. The same is done here, with a
transverse perturbation of 0.4% of the inflow speed — enough to seed the
instability, far too small to see in the flow it produces.

**Pressure is collocated with velocity.** This admits a checkerboard pressure mode
that nothing damps once the viscosity is small enough; it appears as speckle on
the obstacle's surface. The viscosity slider's floor (3×10⁻⁴ m²/s) is set to keep
it out of the picture. A staggered (MAC) grid would remove it properly.

**The pressure solve does not fully converge.** Red-black SOR with ω = 1.7 and a
warm start from the previous frame's pressure drives the residual down fast, but
thirty sweeps still leave some residual divergence. It is far below what is
visible in the dye, which is the standard the simulation is held to.

## References

- Stam, J. (1999). *Stable Fluids.* SIGGRAPH '99, 121–128.
- Selle, A., Fedkiw, R., Kim, B., Liu, Y. & Rossignac, J. (2008). *An
  Unconditionally Stable MacCormack Method.* Journal of Scientific Computing 35,
  350–371. (The velocity advection corrector.)
- Fedkiw, R., Stam, J. & Jensen, H. W. (2001). *Visual Simulation of Smoke.*
  SIGGRAPH '01, 15–22. (Vorticity confinement.)
- Williamson, C. H. K. (1996). *Vortex dynamics in the cylinder wake.*
  Annual Review of Fluid Mechanics 28, 477–539. (Transition Reynolds numbers.)
- Harris, M. (2004). *Fast Fluid Dynamics Simulation on the GPU.* GPU Gems,
  chapter 38.
