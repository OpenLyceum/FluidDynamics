# AGENTS.md — Fluid Dynamics

Sim-specific context for AI assistants. General SceneryStack guidance: [OpenLyceum/.github/AGENTS.md](https://github.com/OpenLyceum/.github/blob/main/AGENTS.md).

## Project

Flow past an obstacle, from laminar streamlines to a Kármán vortex street to a
turbulent wake. Jos Stam's **Stable Fluids** solver runs entirely in WGSL compute
shaders on **WebGPU** — there is no CPU fallback, and where WebGPU is unavailable
the sim shows a message in place of the field.

Physics and its limits: [`doc/model.md`](doc/model.md).
Architecture and the non-obvious decisions: [`doc/implementation-notes.md`](doc/implementation-notes.md).
Read both before changing the solver or the Scenery ↔ WebGPU bridge.

## Key files

| File | Purpose |
|---|---|
| `src/FluidDynamicsColors.ts` | All `ProfileColorProperty` instances, including the two dye colours |
| `src/FluidDynamicsConstants.ts` | Every named number: layout px, grid, solver iteration counts, physics ranges in SI |
| `src/common/model/FluidModel.ts` | All flow parameters + derived Reynolds number and regime |
| `src/common/model/FlowRegime.ts` | Regime vocabulary and classification |
| `src/common/gpu/WebGPUFluidEngine.ts` | Textures, pipelines, bind groups, one frame |
| `src/common/gpu/shaders/common.wgsl` | Uniform struct + obstacle SDF + grid helpers, prepended to every shader |
| `src/common/gpu/FluidUniforms.ts` | CPU mirror of that struct — **must** stay in step with it |
| `src/common/gpu/bindLayouts.ts` | Bind group layouts as plain data, checked against the WGSL by a test |
| `src/common/gpu/solverSchedule.ts` | How many sweeps the viscous solve needs, and at what ω |
| `src/common/gpu/tracerSchedule.ts` | When the next column of tracer dots is released, and into which buffer slot |
| `src/common/gpu/shaders/tracerStep.wgsl` | Advects the tracer dots; `tracerDraw.wgsl` draws them over the field |
| `src/common/view/FluidFieldNode.ts` | The Scenery ↔ WebGPU bridge |
| `src/common/view/FluidScreenView.ts` | Layout and wiring shared by both screens |
| `src/common/view/fluidDescription.ts` | Live a11y description, shared by field and screen summaries |
| `src/common/view/ObstacleHandleKeyboard.ts` | The handles' `HotkeyData` — read by both the listeners and the help dialog |
| `src/common/view/FluidKeyboardHelpContent.ts` | Keyboard-help dialog shared by both screens |
| `src/intro/`, `src/lab/` | Thin screen wrappers; they differ only in `showFullControls` |

## Things that will bite you

**`CanvasNode` does not own a canvas.** Scenery hands `paintCanvas()` a 2D
context belonging to its own shared canvas layer. The engine owns a *detached*
canvas configured with a `"webgpu"` context, and `paintCanvas` blits it with
`drawImage` — never `putImageData`, which ignores the transform Scenery already
applied. All GPU work happens in `update()`, called from the ScreenView's
`step()`; `paintCanvas` only blits, and `update()` must end with
`invalidatePaint()`.

**The view must not call `model.step()`.** joist already steps the active
screen's model.

**Uniform layout is unvalidated by WebGPU.** If `FluidUniforms.ts` and the
`SimUniforms` struct in `common.wgsl` drift apart, every shader reads a shifted
field and it looks like a physics bug. `tests/FluidUniforms.test.ts` parses the
WGSL and pins the contract — if you add a uniform, add it in both places and the
test will tell you if you got it wrong.

**Bind group layouts are shared between kernels, and unvalidated until a device
exists.** Add a binding to a shader and you must add it to the layout in
`FluidUniforms.ts`' neighbour `bindLayouts.ts` — `tests/ShaderBindings.test.ts`
parses the WGSL and will tell you, in Vitest, what the GPU would only have told
you at startup on hardware.

**Nothing in a compute kernel may call `obstacleSDF()`.** The obstacle's signed
distance is baked into a texture by `mask.wgsl` when the body moves; kernels read
it with `isSolidAt(obstacleTex, …)`. Only `display.wgsl` still evaluates the SDF,
because it needs sub-cell accuracy for the outline. Going back to the analytic
call inside the pressure solve costs ~10⁸ transcendental-heavy evaluations a
frame at the finest grid.

**The tracer dots are never read back, and never freed.** They live in a GPU
storage buffer as `vec4(x, y, age, alive)`; a dot that leaves the channel or
touches the body is *parked* (`alive = 0`) and waits for its buffer slot's turn
to come round, which is what bounds the lifetime of one stuck at the stagnation
point without a free list. So `TRACER_BATCH_COUNT × TRACER_COLUMN_SPACING_M`
must stay larger than the channel — recycle a slot too early and a visible dot
snaps back to the inlet. The draw pass binds the buffer to the **vertex** stage
as read-only storage; writable storage is illegal there, which is why the step
and draw passes have separate layouts.

**Load shaders with `?raw`, never `fetch()`.** The `inlineSingleFile()` plugin
requires no runtime file fetches, and the PWA's `globPatterns` does not include
`.wgsl`.

**WebGPU canvas presentation does not work in headless Chromium under WSL2** —
the device is lost the moment any canvas is presented, with or without compute.
Compute and offscreen rendering work fine. `tests/fuzz/engine.spec.ts` therefore
runs the engine with `presentToCanvas: false` and reads pixels back.

**A toolbox icon's `PressListener` must be `attach: false`.** The take-out
gesture forwards the icon's live press to the tool's own drag listener
(`MeasuringTapeNode.startBaseDrag()` / `FluidRulerNode.startDrag()`), but
`PressListener` attaches itself to the pointer *before* it calls the press
callback, and no listener will press a pointer another has attached. An
attaching icon listener therefore turns the hand-off into a silent no-op: the
tool appears at the pointer, correctly positioned, and then never moves. Nothing
throws and nothing logs — `tests/fuzz/toolbox.spec.ts` exists because a test
that only checked whether the tool became visible passed the whole time.

**Spreading a `FLAT_*` bundle does not survive naming one of its keys.** The
bundles in `FluidDynamicsButtonOptions.ts` are nested objects, so
`{ ...FLAT_PLAY_PAUSE_STEP_BUTTON_OPTIONS, stepForwardButtonOptions: { listener } }`
replaces the flat appearance wholesale and leaves that one button beveled among
its neighbours. Re-spread `FLAT_BUTTON_APPEARANCE_OPTIONS` inside any nested
object you name.

**Vorticity confinement is scaled by how much of the damping is numerical.**
Removing that scaling makes low-Reynolds-number wakes shed vortices they should
not. See `shaders/vorticity.wgsl` and `doc/model.md`.

## Common components

Use `FluidDynamicsPanel` for every panel, and the `FLAT_*` option bundles from
`FluidDynamicsButtonOptions.ts` for every button — SceneryStack's defaults are
beveled and this sim is flat. Pair combo-box item labels with
`LIGHT_SURFACE_TEXT_FILL`, not `textColorProperty`.

Every colour goes through `FluidDynamicsColors.ts`, including the ones that are
the same in both profiles (the knob rim, the ruler icon). Profile-invariant is a
decision recorded there, not a reason to inline a hex.

`TimeModel` is composed into each screen model (never subclassed) and bound to
`TimeControlNode` via `isPlayingProperty`. Its `step()` ignores `dt` while
paused, so the step-forward button calls `stepOnce()` instead — routing that
button through `step()` advances the solver and not the clock.

## Accessibility

A screen-reader user cannot see the dye, so `createFluidDescriptionProperty()`
builds a live sentence naming the body, speed, Reynolds number and regime, and
the *same Property* is used as the field's `accessibleParagraph` and as both
screens' `currentDetailsContent`. Keep it that way — they must not be allowed to
disagree. `FluidScreenView` owns that Property and disposes it: it listens to
the global localized strings, so an undisposed one keeps the model alive behind
it.

That paragraph lives on the *field*, so it is not announced while focus is on a
handle. Each shaping knob therefore calls `addAccessibleResponse()` with the
value its arrow press just produced — without that, dragging the obstacle's size
or angle from the keyboard is completely silent.

**Handle keys are `HotkeyData`, declared once in `ObstacleHandleKeyboard.ts`.**
The listeners are built from them and so are the keyboard-help rows
(`KeyboardHelpSectionRow.fromHotkeyData` in `FluidKeyboardHelpContent.ts`), so a
binding cannot exist without being documented, or drift from what the dialog
claims. Add a key there, not in a bare `keydown` handler.

Every control takes its `accessibleName` from the shared `a11y.fluid` string
group, never a literal. New strings must be added to **all three** locale files;
`StringManager.ts` enforces key parity at compile time.

## Compliance carve-out

**The solver lives under `src/common/gpu/`, not `src/common/model/`.** Fleet
convention says the view never integrates physics, but there is no CPU-side fluid
state to model: velocity, pressure and dye exist only as GPU textures, and none
of it can be stepped without a `GPUDevice`. So the *parameters* are a model
(`FluidModel`, no scenery and no GPU imports, fully unit-tested) and the solver
is a view-side renderer, mirroring `Resonance`'s `WebGLParticleRenderer`.
`FluidFieldNode` is the only file that touches both.

## Testing

Fleet-standard Vitest layout under root `tests/`, plus a Playwright suite:

| Path | Purpose |
|---|---|
| `tests/FluidUniforms.test.ts` | CPU/GPU struct layout contract |
| `tests/ShaderBindings.test.ts` | WGSL `@binding` ↔ bind-group-layout contract |
| `tests/solverSchedule.test.ts` | Viscous solve sweep count and relaxation factor |
| `tests/tracerSchedule.test.ts` | Tracer release spacing, slot cycling, paused steps |
| `tests/FluidGridSpec.test.ts` | Dispatch arithmetic, square cells, uv mapping |
| `tests/FlowRegime.test.ts` | Reynolds thresholds and boundaries |
| `tests/FluidModel.test.ts` | Derived Re, reset, reachable regimes, shader codes |
| `tests/memory-leak.test.ts` | WeakRef dispose regression (both models) |
| `tests/FluidDynamicsConstants.test.ts` | Every exported constant is in the namespace registration |
| `tests/harness/engine.html` | Page that loads the real engine for the test below |
| `tests/fuzz/engine.spec.ts` | **The solver**, in a real browser, verified by pixel readback |
| `tests/fuzz/toolbox.spec.ts` | Take-out drag, drop-to-return, click-to-park — needs no WebGPU |
| `tests/fuzz/fuzz.spec.ts` | joist `?fuzz` smoke |

`engine.spec.ts` needs a WebGPU adapter and skips without one; it takes several
minutes on a software rasterizer, so it is not part of `npm test`.

## Commands

```bash
npm run lint && npm run check && npm run build && npm test
```

`npm run release` intentionally skips `npm test` in some sims — append `&& npm test` before the version bump so a release cannot ship a failing suite.

| Command | Description |
|---|---|
| `npm start` / `npm run dev` | Vite dev server |
| `npm run build` | Type-check + production build |
| `npm run build:single` | Single-file build mode |
| `npm run check` | TypeScript (`tsc --noEmit` + scripts + tests projects) |
| `npm run lint` / `npm run fix` | Biome check / auto-fix |
| `npm test` | Vitest unit tests |
| `npm run test:fuzz` | Playwright: engine integration + fuzz smoke |
| `npm run icons` | Regenerate PWA icons |

## Query parameters

| Parameter | Purpose |
|---|---|
| `highQualitySolver` | Public. Initial value of the Preferences → Simulation toggle (50 vs 30 red-black SOR pressure sweeps). |
| `gridResolution` | Public. Initial value of the Preferences → Simulation picker (`standard`, `fine`, `veryFine`, `ultraFine`). |
| `vorticity` | Public. Initial value of the Preferences → Simulation vortex-detail slider (0–40). |
| `dyeDissipation` | Public. Initial value of the Preferences → Simulation dye-fade slider (0.1–1). |
| `pressureIterations` | Development only. Overrides both the default and the preference; `0` means "use the preference". |

## PWA

After `npm run build`, the sim is installable offline via Workbox
(`dist/manifest.webmanifest`).

## Compliance carve-outs

### `package.json` overrides

JSON cannot carry comments, so the rationale for forced transitive pins lives here. Prefer
**tilde (`~`) or exact** versions — caret (`^`) lets minors drift under what is meant to be a
hard pin. Dependabot ignores these three names (see `.github/dependabot.yml`) so it does not
open PRs that fight the overrides. Revisit when SceneryStack drops or re-pins them upstream.

| Override | Pin | Why |
|---|---|---|
| `lodash` | `~4.18.1` | SceneryStack declares `~4.17.12`. Bump clears Dependabot/npm advisories patched in 4.18.x (e.g. GHSA-r5fr-rjxr-66jc, GHSA-f23m-r3pf-42rh). |
| `three` | `~0.125.2` | SceneryStack declares `^0.104.0`. Floor is 0.125.0 for GHSA-fq6p-x6j3-cmmq (ReDoS). Staying on the 0.125 line avoids a larger API jump; **0.125.x still has open CVEs** (e.g. XSS GHSA-7vvq-7r29-5vg3, fixed only in ≥0.137.0). Remove this override if/when SceneryStack stops depending on `three` or pins a patched line itself. LightPropagation keeps a higher `three` pin — do not force 0.125 there. |
| `brace-expansion` | `~5.0.9` | Transitive via `vite-plugin-pwa` / Workbox. Clears npm audit (originally GHSA-mh99-v99m-4gvg; keep ≥5.0.9 for GHSA-rgw5-rvv9-x895). |
