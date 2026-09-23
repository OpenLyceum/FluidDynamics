# Fluid Dynamics — Implementation Notes

Companion to [`model.md`](model.md), which covers the physics. This file covers
how the code is arranged and the non-obvious decisions in it.

## Architecture

```
src/
  main.ts                        Sim + screens + preferences
  FluidDynamicsColors.ts         ProfileColorProperty instances (incl. the two dye colours)
  FluidDynamicsConstants.ts      every named number: layout, grid, solver, physics ranges
  FluidDynamicsNamespace.ts

  common/
    model/
      FluidModel.ts              all flow parameters + derived Re and regime
      FlowRegime.ts              regime vocabulary and classification
      ObstacleShape.ts           as-const union + shader codes
      ObstacleGeometry.ts        pure handle math: angle wrap, focal cap, NACA mirror
      VisualizationMode.ts       as-const union + shader codes
    gpu/
      webgpuSupport.ts           adapter/device acquisition, device-loss reporting
      FluidGridSpec.ts           grid geometry and dispatch arithmetic
      FluidUniforms.ts           CPU mirror of the WGSL uniform struct
      bindLayouts.ts             bind group layouts as plain, testable data
      solverSchedule.ts          how many sweeps the viscous solve needs, and at what ω
      WebGPUFluidEngine.ts       textures, pipelines, bind groups, one frame
      shaders/*.wgsl             the solver
    view/
      FluidScreenView.ts         layout and wiring shared by both screens
      FluidFieldNode.ts          the Scenery ↔ WebGPU bridge
      FluidControlPanel.ts       sliders and pickers; option-selected control set
      FlowReadoutNode.ts         Reynolds number and regime
      FluidScaleBarNode.ts       the fixed |—–—| 0.1 m scale bar on the readout row
      ObstacleHandleNode.ts      invisible drag/keyboard handle over the body
      ObstacleSizeAngleHandleNode.ts, ObstacleFociHandleNode.ts,
      ObstacleThicknessHandleNode.ts
                                  visible knobs: size+tilt, ellipse foci, foil thickness
      FluidRulerNode.ts          draggable 1-metre ruler (drag + keyboard + PDOM)
      ToolboxPanel.ts            toolbox the tape and ruler come from and return to
      WebGPUUnavailableNode.ts   the fallback message
      fluidDescription.ts        live a11y description shared by field and summary
    TimeModel.ts, FluidDynamicsPanel.ts, FluidDynamicsButtonOptions.ts,
    FluidDynamicsScreenIcons.ts

  intro/, lab/                   screen packages; each is a thin wrapper
  preferences/                   query parameters + Preferences → Simulation
  i18n/                          StringManager + en/fr/es
```

## Where the solver lives, and why it is not in the model

Fleet convention is *"the view never integrates physics; the model never imports
scenery."* This sim keeps the second half exactly and bends the first, which is a
deliberate carve-out (also recorded in `AGENTS.md`).

The reason is that there is no CPU-side fluid state to put in a model. Velocity,
pressure, dye and vorticity exist only as GPU textures; there is no array to
mirror and no step function that could run without a `GPUDevice`. So:

- **`common/model/`** holds the *parameters* — the quantities a learner sets, plus
  the Reynolds number and regime derived from them. No scenery imports, no GPU
  imports, fully unit-testable.
- **`common/gpu/`** holds the solver. It imports nothing from scenery.
- **`common/view/FluidFieldNode.ts`** is the only file that touches both.

This mirrors `Resonance/src/chladni-patterns/view/renderers/WebGLParticleRenderer.ts`,
where a GPU renderer also lives under `view/`.

## The Scenery ↔ WebGPU bridge

Scenery has no WebGPU node, and `CanvasNode` is not one either — it does not own
a canvas. Scenery hands `paintCanvas()` a `CanvasRenderingContext2D` belonging to
its own shared canvas layer, already transformed into the node's local frame.
There is nothing there to call `getContext("webgpu")` on.

So the engine owns a **detached** `HTMLCanvasElement`, never added to the
document, and configures *that* with a `"webgpu"` context. Each frame:

```
IntroScreenView.step(dt) → FluidFieldNode.update(dt)
    → engine.step(dt, values)        one encoder: one compute pass, one render pass
    → this.invalidatePaint()

later, inside Display.updateDisplay():
    FluidFieldNode.paintCanvas(ctx) → ctx.drawImage(gpuCanvas, …)
```

Three rules that are easy to get wrong:

- **`drawImage`, never `putImageData`.** `putImageData` ignores the canvas
  transformation matrix Scenery has already applied, so the field would land at
  the wrong place and scale. (Same trap documented in VariableStarPhotometry's
  `StarFieldNode`.)
- **`paintCanvas` only blits.** It runs inside `Display.updateDisplay()`, where
  mutating a Node is unsafe. All GPU work happens in `update()`.
- **`invalidatePaint()` every frame.** Scenery does not re-invoke `paintCanvas` on
  its own schedule.

The view's `step()` deliberately does **not** call `model.step()`: joist already
steps the active screen's model, and doing it here too runs the clock twice as
fast.

### Presentation goes through an offscreen target

The display pass renders into an offscreen texture, which is then copied to the
canvas with `copyTextureToTexture`. The extra copy buys two things: the finished
frame can be read back with `readDisplayPixels()` for testing, and presentation
becomes a single command that can be skipped where it is unsupported.

**Known environment limitation.** Headless Chromium under WSL2 loses the GPU
device the instant *any* WebGPU canvas is presented — a bare three-vertex render
into a canvas context is enough, with no compute involved. Compute passes and
offscreen rendering work correctly there. The sim's behaviour in such an
environment is to show its "WebGPU is not available — the graphics device was
lost" message, which is the honest outcome. The engine integration test runs with
`presentToCanvas: false` and checks the solver by reading pixels back instead.

## Ping-pong and bind groups

A shader cannot read and write the same texture, so velocity, dye and pressure
each exist twice and swap after every write. Bind groups reference concrete
texture views, so **every parity combination a frame can reach is built once at
construction** — allocating bind groups inside the frame loop is the classic way
to make a WebGPU renderer allocate sixty times a second.

Velocity and dye advection are both MacCormack predictor–correctors, so each
keeps a scratch texture (`advectTemp`, `dyeTemp`) for the predictor's φ_A: the
backward trace writes it, the corrector reads it and writes the limited result
into the next field. Each is one allocation reused for the life of the grid.

The `advect` layout has a fifth binding, `priorTex`, that the velocity kernels do
not strictly need: for velocity the field being carried and the field doing the
carrying are the same texture, so φⁿ and the trace velocity come from the same
binding. For the dye they are different textures, and rather than give the dye
its own layout the velocity bind groups simply point bindings 2 and 5 at the same
view.

The pressure and viscous solves are both red-black SOR. Each sweep reads one
texture and writes the other; the cells of the opposite colour are copied through
verbatim, so a red sweep followed by a black sweep ping-pongs back to the
original texture with the whole grid updated — which means an even number of
dispatches always lands back on the parity it started from. The viscous solve
adds a `seed` entry point, a plain Jacobi sweep that fills the first iterate from
the advected source; it is both the initial guess and the guarantee that every
cell has been written before a red sweep starts reading neighbours.

## The obstacle field is baked, not evaluated

`obstacleSDF()` costs a handful of transcendentals for the airfoil, and the
solver asks "is this cell solid?" up to five times per cell in nearly every one
of the ~50 dispatches a frame contains — the pressure solve alone accounts for
most of them. At 2048 × 1024 that was on the order of 10⁸ SDF evaluations per
frame for an answer that changes only when the learner drags the body.

So `mask.wgsl` writes the signed distance into an r32float texture, and every
compute kernel reads it through the `isSolidAt` helper in `common.wgsl`. It is
re-baked when the obstacle's shape, size, position, tilt, eccentricity or foil
thickness changes, and when the grid is rebuilt — `WebGPUFluidEngine.markMask`
does the comparison, and the dispatch is the first thing in the compute pass so
everything downstream sees it. Within a compute pass each dispatch is its own
usage scope, so writing the texture in one dispatch and sampling it in the next
is legal.

Two things to keep in mind. A freshly created texture reads as all zeros, which
the solver would take for a body filling the whole channel — hence `isMaskStale`
starts true and `createFields` sets it again. And the display pass deliberately
does *not* use the mask: it samples between cells and needs the analytic
function's sub-cell accuracy for the body's outline.

## The obstacle is shaped by handles, not sliders

Size, angle of attack, the ellipse's eccentricity and the foil's thickness are
direct-manipulation quantities: each is a knob on the body whose polar or normal
offset *is* the model value, written straight into the same Properties the
solver reads. No slider duplicates them, because a second interface to the same
number invites the picture and the number to disagree.

- `ObstacleSizeAngleHandleNode` — one knob on the leading edge. Distance from
  the body's centre sets the diameter; the direction sets the angle of attack
  (folded into ±90° by the chord's 180° symmetry, so dragging over the top
  keeps going). On the disk the tilt is inert, so the same knob is the Intro
  screen's radius handle.
- `ObstacleFociHandleNode` — two mirrored knobs on the ellipse's foci. Their
  separation is the focal half-distance c (zero collapses the body to the disk
  it started as); their line is the major axis, which *is* the angle of attack.
  Shrinking the body re-clamps c in `FluidModel`, exactly as it re-clamps the
  centre's drag bounds.
- `ObstacleThicknessHandleNode` — a knob riding the foil's thickest point,
  dragged along the chord's normal. Its placement uses the same NACA polynomial
  as the shader (`ObstacleGeometry.ts` mirrors it in TypeScript), so the knob
  always sits exactly on the surface being stretched.

Touching the body itself still translates it — that is `ObstacleHandleNode`,
the transparent hit circle, which the knobs sit above so their small targets
win the hit test. Every knob is focusable, with arrow keys mapped to its
quantities (Shift for fine steps) so nothing is pointer-only. Handle visibility
is shape-driven and linked only *after* the nodes join the scene graph, for the
same PDOM reason as the toolbox tools.

## The bind layout contract

WebGPU checks a shader's resources against its pipeline layout, but only for
resources the entry point statically uses, only at pipeline-creation time, and
only on a device — which in this sim means "the field turns into the
WebGPU-unavailable message, on hardware, with one line in the console". Since
several kernels share a layout, adding a binding to one and forgetting the layout
is easy to do and indirect to diagnose.

So the layouts are plain data in `bindLayouts.ts`, and `tests/ShaderBindings.test.ts`
parses every `@group(0) @binding(n)` out of the WGSL and checks it against the
layout that shader's pipelines are built with — index, kind, storage format, and
for the tracer buffer the storage access mode, since a `read_write` declaration
against a read-only entry is a pipeline error and a vertex stage may not have a
writable one at all. The check is one-directional (shader ⊆ layout) because a
shared layout may legitimately carry entries a given kernel does not use.

Texture formats are chosen around filtering: velocity and dye are `rgba16float`
because semi-Lagrangian advection wants hardware bilinear interpolation and
`rgba16float` is both filterable and storage-capable in core WebGPU. `rg32float`
would fit velocity exactly but is not filterable without an optional feature.
Pressure, divergence and curl are `r32float`, declared `unfilterable-float`, and
read only with `textureLoad`.

## The uniform layout contract

WebGPU validates buffer sizes but not struct layouts. If the offsets in
`FluidUniforms.ts` drift from the `SimUniforms` declaration in `common.wgsl`,
every shader silently reads a shifted field and the failure looks like a physics
bug. `tests/FluidUniforms.test.ts` parses the WGSL struct and asserts that its
member order matches the offset table, that alignment rules are satisfied, and
that the members exactly fill the 144-byte buffer.

## Shaders are loaded with `?raw`

`import src from "./shaders/advect.wgsl?raw"`, never `fetch()`. Two reasons, both
already baked into `vite.config.ts`: the `inlineSingleFile()` plugin's
correctness note requires the bundle to have no runtime fetches of local files,
and the PWA's `workbox.globPatterns` does not include `.wgsl`, so a fetched
shader would break offline. `?raw` inlines the shader into the JS bundle at build
time and satisfies both. WGSL has no `#include`, so `common.wgsl` — the uniform
struct plus the obstacle geometry and grid helpers — is concatenated ahead of
every shader in TypeScript.

## Accessibility

A screen-reader user cannot see the dye, so `common/view/fluidDescription.ts`
builds a live sentence naming the body, the speed, the Reynolds number and the
regime. The same Property is used as the fluid field's `accessibleParagraph` and
as both screens' `currentDetailsContent`, so the field and the summary can never
disagree.

That Property is created by each screen view and owned by `FluidScreenView`,
which disposes it. It matters more than the usual view Property: it derives from
the *global* localized string Properties as well as the model's, so an
undisposed one stays reachable from a page-lifetime singleton and keeps the
whole model alive behind it.

Every control carries an `accessibleName` from the shared `a11y.fluid` string
group. The obstacle handle is a transparent — not invisible — `Circle`: an
invisible Node is removed from the parallel DOM and can be neither focused nor
hit-tested.

**The live paragraph is on the field, so it says nothing while focus is on a
handle.** The shaping knobs are the sim's primary direct-manipulation controls
and the body they shape is painted by the display shader, so a keyboard user
gets no feedback at all unless each knob reports its own change. Every arrow
press therefore ends in `addAccessibleResponse()` with the value it produced —
diameter, angle of attack, focal separation, or thickness as a percentage of
chord.

**The handles' keys are `HotkeyData`, not a `keydown` branch.** Every binding is
declared once in `common/view/ObstacleHandleKeyboard.ts` and read twice: by
`createArrowKeyListener()` to build the `KeyboardListener`, and by
`FluidKeyboardHelpContent.ts` via `KeyboardHelpSectionRow.fromHotkeyData` to
build the dialog rows, icons included. A binding therefore cannot exist without
being documented, or drift from what the dialog claims, and the keys land in
SceneryStack's hotkey registry where they are checked against the global
shortcuts. Shift is spelled out as its own key string (`shift+arrowUp`, …)
because a listener registered for `arrowUp` alone does not fire while a modifier
is down.

The keyboard-help dialog itself is one shared class with two flags, mirroring
`FluidControlPanel`: the Intro screen's cylinder has no chord to tilt, no foci
and no thickness, and its panel has no combo box, so both optional groups are
off there.

**When WebGPU is unavailable the handles are hidden**, not merely inert. There
is no body on screen to grab, and leaving them visible would give a keyboard
user four focusable controls naming an obstacle that is not there.

**Touch targets are dilated, mouse targets are not.** The knobs' 14 px hit
circles are bounded by how close two knobs get — the ellipse's foci coincide at
zero eccentricity — so enlarging them for the mouse would start stealing presses
from a neighbour. `touchArea` is dilated past that instead, on the knobs, the
slider thumbs and the toolbox icons, since a finger cannot aim at a 12 px dot in
the first place.

`WebGPUUnavailableNode` sets `tagName: "div"` for a load-bearing reason: Scenery
only creates a paragraph sibling when the paragraph content is non-empty, and the
message is empty until a failure reason arrives. Without a primary sibling to
fall back on, `getPlaceableSibling()` asserts and the sim fails to launch.

## Tracer dots

The dye shows what the flow *does*; the dots show *where a parcel of fluid
goes*. They are the only thing on screen with an identity that persists between
frames, which is what lets a learner follow one dot round the body, watch it
stall at the nose, or see it caught in the recirculation bubble and carried
backwards. Independent of the visualization picker rather than a fifth value of
it: they are informative over all four fields.

Everything about them stays on the GPU. `TRACER_TOTAL_COUNT` particles live in a
storage buffer as `vec4(x, y, age, alive)` — position in metres, age in seconds,
a 0/1 flag — advected by `tracerStep.wgsl` and drawn by `tracerDraw.wgsl`.
Nothing is ever read back: a readback would stall the pipeline every frame, and
no CPU-side code needs to know where a dot is.

Three decisions are worth keeping:

**Release is clocked by distance, not time.** `tracerSchedule.ts` accumulates
`inflowSpeed × dt` and fires a column every `TRACER_COLUMN_SPACING_M`, so the
columns stay evenly spaced *in the channel* across the whole speed slider. A
fixed time interval bunches them into a crowd at 0.05 m/s and strings them into
a scatter at 3 m/s, and the even spacing is exactly what makes one column's
deformation legible against its neighbours. The clock is the engine's, not the
view's — like `inflowRamp`, it is arithmetic with a unit test.

**Nothing is allocated, compacted or freed.** A dot that leaves the channel, hits
a wall or touches the body is *parked*: `alive` goes to zero and it waits,
invisible, for its slot's turn to come round again. That is what bounds the
lifetime of a dot trapped at the stagnation point without a free list, and it is
why `TRACER_BATCH_COUNT × TRACER_COLUMN_SPACING_M` must exceed the channel
width — a slot recycled too early yanks a visible dot back to the inlet. A
zeroed buffer is a full set of parked dots, so a freshly created one needs no
initialization pass, the same trick `reset()` plays with the field textures.

**Retirement on contact with the body is load-bearing.** Velocity inside a solid
cell is zero, so a dot that got in would stall there in plain sight, on top of a
body it is supposed to be flowing past. `tracerStep.wgsl` therefore tests the
baked obstacle mask after each advection step, which also covers the learner
dragging the body over a dot.

The draw is one extra `setPipeline` and `draw(6, N)` at the end of the display
pass, with alpha blending so the antialiased rim of a dot melts into the field.
Parked dots are still drawn — nothing on the CPU knows which those are — and
collapse to a point outside clip space in the vertex shader. The particle
buffer is bound to the vertex stage as **read-only** storage: writable storage
is not allowed there, which is why the step and draw passes cannot share a bind
group layout.

`tracersVisible` is not a uniform. It gates the dispatch and the draw on the
CPU, and switching it on clears the buffer, so the channel fills from the inlet
rather than resuming a pattern frozen mid-flight.

## Measurement tools

`ToolboxPanel` owns the measuring tape and the ruler, but the nodes it creates
are **not its children** — FluidScreenView adds them as siblings near the top of
the z-order, so a ruler dragged across the control panel floats above it. The
panel keeps only the two icons.

The interaction is the classic toolbox contract. Pressing an icon when its tool
is hidden takes the tool out at the pointer and forwards the still-active press
to the tool's own drag listener (`MeasuringTapeNode.startBaseDrag()` /
`FluidRulerNode.startDrag()`), so the press becomes a drag of the real tool.
Pressing the icon while the tool is out puts it back — that press *is* the
keyboard story, since a screen-reader activation arrives as a synthetic press.
Ending a tool drag over the panel also puts it back. A one-shot flag per tool
swallows the return test of the drag that took it out, which always ends over
the toolbox.

**The icons' `PressListener`s must be `attach: false`.** A `PressListener`
attaches itself to the pointer *before* it calls the press callback, and
`PressListener.canPress()` refuses a pointer another listener has attached — so
an attaching icon listener makes `startBaseDrag()`/`startDrag()` no-ops and the
tool is simply placed, never dragged. Nothing throws, nothing logs; the sim just
feels broken. Both hand-off calls now report whether the tool took the press,
and the panel falls back to placing the tool at its default position if it did
not.

Two consequences of forwarding shape the rest: the drag keeps the offset the
take-out established (so the take-out offsets are small, and the tool comes out
under the hand), and the take-out drag necessarily ends over the toolbox (so the
one-shot flag above exists). That flag doubles as a click-versus-drag test — a
press that never travels `TOOL_TAKEOUT_CLICK_SLOP_PX` parks the tool at its
default position out in the channel rather than leaving it draped over the
toolbox. Only the tape's *base* can put the tape away: the tip is how a learner
reaches out to what they are measuring, and things worth measuring can sit over
the toolbox.

Tool state lives in `FluidModel` (visibility + positions in metres), so Reset
All empties the toolbox with no view-side reset code. The ruler's length and
tick spacing are computed from the shared `modelViewTransform`, so its scale
cannot drift from the channel's.

The `FluidScaleBarNode` under the field follows the same rule for the same
reason: its pixel length is `modelToViewDeltaX(SCALE_BAR_LENGTH_M)`, never a
hard-coded width. It is not pickable and carries no parallel-DOM content —
like the Reynolds readout beside it, it is static visual text, and the ruler
is the interactive way to measure.

## Disposal

`FluidModel.dispose()` is guarded by an `isDisposed` flag. A plain `Property`
tolerates a second `dispose()`, but `DerivedProperty` nulls its dependency list on
the first and throws on the second — and the fleet's memory-leak suite requires
idempotence.

`FluidScreenView.dispose()` does **not** call `super.dispose()`: joist's
`ScreenView` is intentionally non-disposable and its `setPDOMOrder` override
throws during ParallelDOM teardown. It drains a `disposers` array instead — and
that array is where the fluid-description Property is released, even though the
subclasses construct it (they have no `dispose()` of their own).

`FluidDynamicsPreferencesNode` goes the other way and declares
`isDisposable: false`. `PreferencesModel` calls `createContent()` once and the
dialog lives as long as the sim, so nothing it builds is ever torn down; saying
so makes a stray `dispose()` assert instead of silently leaving the preference
sliders' `DerivedProperty`s listening.

`FluidModel`'s `attach*()` methods run any previous detach closure before
linking, so calling one twice cannot strand a listener on a preference Property
that outlives the model.

## Testing

| Path | What it covers |
|---|---|
| `tests/FluidUniforms.test.ts` | the CPU/GPU struct layout contract |
| `tests/ShaderBindings.test.ts` | the WGSL/bind-group-layout contract |
| `tests/solverSchedule.test.ts` | the viscous solve's sweep count and relaxation factor |
| `tests/tracerSchedule.test.ts` | the tracer release clock: spacing, slot cycling, paused steps |
| `tests/FluidGridSpec.test.ts` | dispatch arithmetic, square cells, uv mapping |
| `tests/FlowRegime.test.ts` | Reynolds thresholds and their boundaries |
| `tests/FluidModel.test.ts` | derived Re, reset, reachable regimes, shader codes |
| `tests/ObstacleGeometry.test.ts` | handle math: angle wrap, focal cap, NACA mirror |
| `tests/memory-leak.test.ts` | WeakRef dispose regression for both models |
| `tests/FluidDynamicsConstants.test.ts` | the namespace registration lists every exported constant |
| `tests/fuzz/engine.spec.ts` | **the solver itself**, in a real browser |
| `tests/fuzz/toolbox.spec.ts` | take-out drag, drop-to-return, click-to-park |
| `tests/fuzz/fuzz.spec.ts` | joist `?fuzz` and `?fuzzBoard` smoke, both with `&ea` |

`fuzz.spec.ts` runs the keyboard fuzz as well as the pointer fuzz, and that is
not redundant: `?fuzzBoard` is what exercises the parallel DOM, where a CSP
blocking Scenery's inline `onclick` handlers surfaces as a console error on
every button activation. The pointer fuzz never touches those elements, so it
passed the whole time that was broken.

`FluidDynamicsConstants.test.ts` parses the source rather than importing it: the
registered object is not reachable from the module's exports, so comparing it
against the file's `export const`s means reading both out of the text.

`tests/fuzz/engine.spec.ts` is the interesting one. The fluid state is
unreachable from Vitest, so it drives the real engine through
`tests/harness/engine.html` (transpiled on the fly by the Vite dev server), runs
real compute passes, and reads frames back. It checks that dye is carried
downstream, that every obstacle shape blocks the flow, that removing the obstacle
leaves the channel uniform, that reset clears the field, that every visualization
mode renders — and that the wake is steady below the shedding threshold and
unsteady above it, which is the simulation's central claim.

It is also the only place the tracer dots can be checked at all, since they exist
solely as GPU state: two cases confirm that columns are released at the inlet and
carried out of the far end, and that no dot is ever left stalled inside the body.
Both find the dots by counting near-white pixels, which nothing else on screen
produces. The harness leaves `tracersVisible` off by default so the dots do not
perturb the brightness assertions the dye tests make.

It needs a WebGPU adapter (`playwright.config.ts` passes
`--enable-unsafe-webgpu --enable-features=Vulkan`) and skips without one.
