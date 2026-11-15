/**
 * solverSchedule.ts
 *
 * How hard the iterative solves have to work this step.
 *
 * Both the viscous diffusion solve and the pressure solve are stationary
 * iterations, and both have a well-known optimal over-relaxation factor. Rather
 * than pinning a sweep count and a relaxation factor to whatever looked right at
 * one grid resolution, these functions derive them from the problem the solver
 * has actually been handed.
 *
 * ── Why this matters for the diffusion solve ──────────────────────────────────
 * The implicit viscous solve is (I − νΔt∇²)u = u₀, whose stiffness is the single
 * number α = νΔt/h². A plain Jacobi sweep reduces the error by at most
 * ρ_J = 4α/(1 + 4α) per sweep, and α grows with the *square* of the resolution:
 * at ν = 10⁻³ m²/s and Δt = 1/60 s it is 0.27 on the 256 × 128 grid but 17 on the
 * 2048 × 1024 one. Twelve Jacobi sweeps leave 0.8 % of the error at the first and
 * 84 % of it at the second — so at the fine resolutions the fluid was quietly
 * less viscous than the learner asked for, in the direction that inflates the
 * effective Reynolds number.
 *
 * Red-black SOR with the optimal factor for that α converges at ω − 1 per sweep
 * instead, which is 0.08 and 0.71 for the same two cases. The sweep count then
 * follows from the accuracy actually wanted, so the cheap end of the range gets
 * cheaper and the stiff end gets correct.
 *
 * No GPU or scenery dependency: this is arithmetic, and it is unit-tested.
 */

import {
  DIFFUSION_RESIDUAL_TOLERANCE,
  DIFFUSION_SKIP_ALPHA,
  DIFFUSION_SWEEPS_MAX,
} from "../../FluidDynamicsConstants.js";

/**
 * α = νΔt/h², the stiffness of the implicit viscous solve.
 *
 * Zero when the sim is paused (Δt = 0), which is the case the skip guard below
 * exists for.
 */
export function diffusionAlpha(viscosity: number, dt: number, cellSize: number): number {
  return (viscosity * dt) / (cellSize * cellSize);
}

/**
 * Optimal SOR factor for the diffusion system, for a given α.
 *
 * The Jacobi iteration matrix of (1 + 4α)x_c − αΣx_n = f has spectral radius
 * ρ_J = 4α/(1 + 4α), and Young's formula gives ω = 2/(1 + √(1 − ρ_J²)). Both
 * radicals simplify: 1 − ρ_J² = (1 + 8α)/(1 + 4α)², so
 *
 *   ω = 2(1 + 4α) / (1 + 4α + √(1 + 8α))
 *
 * which needs one square root and no trigonometry. **The same closed form is
 * evaluated in shaders/diffuse.wgsl** — the two must agree, because the sweep
 * count below is chosen for the rate this ω produces.
 *
 * ω → 1 as α → 0 (the system becomes the identity and Gauss–Seidel is already
 * exact) and → 2 as α → ∞, staying inside the convergent range at every α.
 * @internal Exported for unit tests; not part of the application API.
 */
export function diffusionOmega(alpha: number): number {
  const diagonal = 1 + 4 * alpha;
  return (2 * diagonal) / (diagonal + Math.sqrt(1 + 8 * alpha));
}

/**
 * Error remaining after one red-black SOR iteration (one red sweep plus one
 * black sweep) of the diffusion solve. This is ω − 1, the asymptotic rate of SOR
 * at its optimal factor.
 * @internal Exported for unit tests; not part of the application API.
 */
export function diffusionConvergenceRate(alpha: number): number {
  return diffusionOmega(alpha) - 1;
}

/**
 * Red-black SOR iterations to run on the viscous solve this step — each one is
 * a red dispatch and a black dispatch.
 *
 * Chosen as the fewest that drive the error below DIFFUSION_RESIDUAL_TOLERANCE,
 * capped so that the stiffest corner of the parameter space (the finest grid at
 * the top of the viscosity slider) cannot turn into an unbounded dispatch count.
 *
 * Returns 0 below DIFFUSION_SKIP_ALPHA, where every sweep is the identity to
 * within float precision and only the seeding dispatch is needed.
 */
export function diffusionSweeps(alpha: number): number {
  if (!(alpha >= DIFFUSION_SKIP_ALPHA)) {
    return 0;
  }
  const rate = diffusionConvergenceRate(alpha);
  if (rate <= 0) {
    return 1;
  }
  const exact = Math.log(DIFFUSION_RESIDUAL_TOLERANCE) / Math.log(rate);
  return Math.min(DIFFUSION_SWEEPS_MAX, Math.max(1, Math.ceil(exact)));
}
