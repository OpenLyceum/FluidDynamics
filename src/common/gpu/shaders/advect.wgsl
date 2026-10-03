// advect.wgsl — semi-Lagrangian transport with a MacCormack corrector.
//
// Step 1 of Stam's Stable Fluids: instead of pushing quantities forward (which
// goes unstable above a CFL of 1), trace each cell's position *backwards* along
// the velocity field and take whatever was there. Unconditionally stable at any
// timestep, at the cost of being diffusive.
//
// Two things are done about that cost, and both apply to the velocity field and
// to the dye:
//
//  1. The trace itself is a midpoint (RK2) step rather than a single Euler step.
//     An Euler trace follows the velocity at the arrival point for the whole
//     step, which cuts the corner on every curved path — and a vortex is nothing
//     but curved paths. Sampling the velocity once more at the halfway point
//     makes the trace second order in Δt for the cost of one extra fetch, and
//     the vortices of the Kármán street stop drifting toward their own centres.
//
//  2. The plain backward trace behaves like an extra viscosity of order h·|u|/2
//     — enough to smear the shear layer off the obstacle and wash the dye bands
//     out well before they reach the far end of the channel. So both fields are
//     advected with a MacCormack predictor–corrector (Selle, Fedkiw, Lanson,
//     Molemaker & Bridson, 2008): the predictor's backward step is corrected by
//     an anti-diffusive term built from a forward step, cancelling most of the
//     numerical diffusion. A bound-preserving limiter clamps the result to the
//     predictor's local range, so the correction cannot create new extrema —
//     which for the dye also means it can neither go negative nor invent a
//     colour that was not already in the neighbourhood.
//
// The bilinear filtering in textureSampleLevel is what makes the trace second
// order in space; it is also why the velocity and dye textures are rgba16float
// (filterable) rather than rg32float (not, without an optional feature).
//
// ── Bindings ──────────────────────────────────────────────────────────────────
// velocityTex   the field the trace follows — always a velocity field
// sourceTex     the field being carried: φⁿ in a predictor, φ_A in a corrector
// priorTex      φⁿ again, in a corrector; unused by the predictors
// outTex        the result
//
// Velocity advection binds velocityTex and priorTex to the same texture, since
// the field being carried is the one doing the carrying. Dye advection does not.

@group(0) @binding(0) var<uniform> u : SimUniforms;
@group(0) @binding(1) var linearSampler : sampler;
@group(0) @binding(2) var velocityTex : texture_2d<f32>;
@group(0) @binding(3) var sourceTex : texture_2d<f32>;
@group(0) @binding(4) var outTex : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var priorTex : texture_2d<f32>;
@group(0) @binding(6) var obstacleTex : texture_2d<f32>;

// Velocity is in m/s and uv is dimensionless, so a displacement in metres has to
// be divided by the domain size to become a displacement in uv.
fn traceOffset() -> vec2<f32> {
  return vec2<f32>(u.dt, u.dt) / u.domainSize;
}

fn traceVelocity(uv: vec2<f32>) -> vec2<f32> {
  return textureSampleLevel(velocityTex, linearSampler, uv, 0.0).xy;
}

// Where the fluid now at `uv` came from one timestep ago, by the midpoint rule.
fn backtrace(uv: vec2<f32>) -> vec2<f32> {
  let offset = traceOffset();
  let midpoint = uv - 0.5 * traceVelocity(uv) * offset;
  return uv - traceVelocity(midpoint) * offset;
}

// The same step taken forwards, which is what makes the MacCormack error
// estimate below an estimate of the *backward* step's error.
fn forwardTrace(uv: vec2<f32>) -> vec2<f32> {
  let offset = traceOffset();
  let midpoint = uv + 0.5 * traceVelocity(uv) * offset;
  return uv + traceVelocity(midpoint) * offset;
}

fn isSolidHere(cell: vec2<u32>) -> bool {
  return isSolidAt(obstacleTex, vec2<i32>(cell), u);
}

// ── Predictors ────────────────────────────────────────────────────────────────

@compute @workgroup_size(8, 8)
fn advectVelocity(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.xy;
  if (!inGrid(cell, u)) {
    return;
  }

  // No-slip: the body does not move, so neither does the fluid inside it.
  // Enforced here as well as in the dedicated pass, so the backtrace never
  // picks up a stale velocity from inside the obstacle.
  if (isSolidHere(cell)) {
    textureStore(outTex, cell, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  let source = textureSampleLevel(sourceTex, linearSampler, backtrace(cellToUV(cell, u)), 0.0);
  textureStore(outTex, cell, vec4<f32>(source.xy, 0.0, 1.0));
}

@compute @workgroup_size(8, 8)
fn advectDye(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.xy;
  if (!inGrid(cell, u)) {
    return;
  }

  // Dye inside the body would be visible through the obstacle overlay's edges.
  if (isSolidHere(cell)) {
    textureStore(outTex, cell, vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }

  // No dissipation here: the corrector applies it once, to the finished value.
  let source = textureSampleLevel(sourceTex, linearSampler, backtrace(cellToUV(cell, u)), 0.0);
  textureStore(outTex, cell, source);
}

// ── MacCormack corrector ──────────────────────────────────────────────────────
//
//   φ_A   = backward advect of φⁿ                       (the predictor, above)
//   φ_D   = forward sample of φ_A at x + u·dt            (the reverse trace)
//   φ_raw = φ_A + ½(φⁿ(x) − φ_D)                         (anti-diffusive blend)
//   φ     = clamp φ_raw to [min, max] of φⁿ around the departure point
//
// The clamp is what makes the scheme unconditionally stable: without it the
// anti-diffusive term can overshoot and, over many steps, blow up. With it the
// corrected value never leaves the range of the original departure stencil, so the
// whole step is no less stable than plain semi-Lagrangian.

fn maccormack(cell: vec2<u32>) -> vec4<f32> {
  let uv = cellToUV(cell, u);

  let phiN = textureLoad(priorTex, vec2<i32>(cell), 0);
  let phiA = textureSampleLevel(sourceTex, linearSampler, uv, 0.0);
  let phiD = textureSampleLevel(sourceTex, linearSampler, forwardTrace(uv), 0.0);

  let raw = phiA + 0.5 * (phiN - phiD);

  // Bound the corrected value to the range of φⁿ over the four texels whose
  // bilinear interpolation produced the predictor's value at the departure
  // point. A value outside this range is an overshoot the limiter removes.
  //
  // The −0.5 is the half-texel offset between a uv coordinate and the texel
  // *centres* the hardware interpolates between: without it the four cells
  // sampled here are the wrong ones whenever the departure point falls in the
  // far half of its cell, and the limiter bounds the correction against a
  // neighbourhood the predictor never looked at.
  let base = clampCell(vec2<i32>(floor(backtrace(uv) * u.gridSize - vec2<f32>(0.5, 0.5))), u);
  // sourceTex holds φ_A, which has already moved. Bounding against it at the
  // departure point transports the stencil twice when the trace spans cells.
  let p00 = textureLoad(priorTex, clampCell(base + vec2<i32>(0, 0), u), 0);
  let p10 = textureLoad(priorTex, clampCell(base + vec2<i32>(1, 0), u), 0);
  let p01 = textureLoad(priorTex, clampCell(base + vec2<i32>(0, 1), u), 0);
  let p11 = textureLoad(priorTex, clampCell(base + vec2<i32>(1, 1), u), 0);

  return clamp(raw, min(min(p00, p10), min(p01, p11)), max(max(p00, p10), max(p01, p11)));
}

@compute @workgroup_size(8, 8)
fn advectVelocityCorrect(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.xy;
  if (!inGrid(cell, u)) {
    return;
  }

  // No-slip is enforced by the predictor too; repeated here so a correction can
  // never put velocity back inside the body.
  if (isSolidHere(cell)) {
    textureStore(outTex, cell, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  textureStore(outTex, cell, vec4<f32>(maccormack(cell).xy, 0.0, 1.0));
}

@compute @workgroup_size(8, 8)
fn advectDyeCorrect(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.xy;
  if (!inGrid(cell, u)) {
    return;
  }

  if (isSolidHere(cell)) {
    textureStore(outTex, cell, vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }

  // dyeDissipation is the fraction remaining after one second, so the per-step
  // factor is that raised to dt — framerate-independent fading. Applied once,
  // here, so the predictor's output is a clean φ_A for the corrector to bound
  // against rather than a field that has already faded by a different amount.
  let decay = pow(u.dyeDissipation, u.dt);
  textureStore(outTex, cell, maccormack(cell) * decay);
}
