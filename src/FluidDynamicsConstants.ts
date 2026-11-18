/**
 * FluidDynamicsConstants.ts
 *
 * Central repository for every named numeric constant used across the
 * simulation. Bare numbers that carry semantic meaning (sizes, margins,
 * physics defaults, ranges) belong here rather than inline in model or view
 * code, so they are named, documented, and changed in one place.
 *
 * Conventions
 * ───────────
 *  - Physics / model values use SI units (metres, seconds, kilograms, …);
 *    note the unit in a comment on each value.
 *  - Layout / chrome values are in screen pixels.
 *  - Colour strings live in FluidDynamicsColors.ts, not here.
 *  - Computed expressions (e.g. `2 * Math.PI`) may stay inline.
 */

import { Bounds2, Dimension2, Range, Vector2 } from "scenerystack/dot";
import { TimeSpeed } from "scenerystack/scenery-phet";
import FluidDynamicsNamespace from "./FluidDynamicsNamespace.js";

// ── Layout / chrome (screen pixels) ───────────────────────────────────────────

/** Margin between the screen edge and edge-anchored controls (e.g. Reset All). */
export const SCREEN_VIEW_MARGIN = 20;

/** Corner radius shared by control panels and dialogs. */
export const PANEL_CORNER_RADIUS = 6;

/**
 * The fluid field's rectangle in the 1024 × 618 ScreenView coordinate space.
 * Left-aligned and 2:1, leaving a control column on the right. The solver grid
 * has the same aspect ratio so the dye is never anisotropically stretched.
 */
export const FIELD_VIEW_BOUNDS = new Bounds2(20, 70, 720, 420);

/** Width of the control column to the right of the field, in screen pixels. */
export const CONTROL_PANEL_WIDTH = 264;

/** Font size for control labels and their value readouts. */
export const CONTROL_LABEL_FONT_SIZE = 14;

/** Font size for the "Simulation" heading in Preferences. */
export const PREFERENCES_HEADING_FONT_SIZE = 18;

/** Font size for the Reynolds-number readout below the field. */
export const READOUT_FONT_SIZE = 17;

// ── Sliders ───────────────────────────────────────────────────────────────────

/** Height of a slider track, in screen pixels. */
export const SLIDER_TRACK_HEIGHT_PX = 4;

/** Combined left and right inset of a panel slider's track within the panel, in screen pixels. */
export const SLIDER_TRACK_INSET_PX = 48;

/** Track length of a slider in the Preferences dialog, in screen pixels. */
export const PREFERENCE_SLIDER_TRACK_LENGTH_PX = 220;

/** Slider thumb size, in screen pixels. */
export const SLIDER_THUMB_SIZE = new Dimension2(14, 26);

/**
 * How far a slider thumb's touch area extends past the thumb itself, in screen
 * pixels. The thumb is drawn narrow so the sliders stack compactly beside a
 * 350 px field; a finger needs roughly 44 px of target, which is what this
 * dilation buys without widening the visible control.
 */
export const SLIDER_THUMB_TOUCH_DILATION_X_PX = 12;
export const SLIDER_THUMB_TOUCH_DILATION_Y_PX = 6;

/** Title font size in the "WebGPU is not available" panel. */
export const WEBGPU_TITLE_FONT_SIZE = 20;

/** Body font size in the "WebGPU is not available" panel. */
export const WEBGPU_MESSAGE_FONT_SIZE = 15;

/** Wrap width for the "WebGPU is not available" message. */
export const WEBGPU_MESSAGE_MAX_WIDTH = 460;

// ── Fluid domain (SI units) ───────────────────────────────────────────────────

/** Width of the simulated channel, in metres. Matches FIELD_VIEW_BOUNDS' 2:1 aspect. */
export const CHANNEL_WIDTH_M = 2;

/** Height of the simulated channel, in metres. */
export const CHANNEL_HEIGHT_M = 1;

// ── Solver grid ───────────────────────────────────────────────────────────────

/** Default solver grid, in cells. 2:1 to match the channel, so cells stay square. */
export const GRID_WIDTH_DEFAULT = 256;
export const GRID_HEIGHT_DEFAULT = 128;

/** Higher-resolution grid, selectable on the Lab screen. */
export const GRID_WIDTH_FINE = 512;
export const GRID_HEIGHT_FINE = 256;

/** Higher still — four times the cell count of fine. */
export const GRID_WIDTH_VERY_FINE = 1024;
export const GRID_HEIGHT_VERY_FINE = 512;

/** Highest-resolution grid, selectable on the Lab screen. Four times the cell count of very fine. */
export const GRID_WIDTH_ULTRA_FINE = 2048;
export const GRID_HEIGHT_ULTRA_FINE = 1024;

/**
 * Size of the canvas the solver renders into, in device pixels.
 *
 * Matches the ultra-fine grid's linear resolution: the display pass samples the
 * dye texture with a linear filter, so upscaling coarser grids costs one texture
 * fetch per pixel and removes the blockiness that a grid-sized canvas would show
 * when Scenery scales it up to the field's on-screen size.
 */
export const DISPLAY_CANVAS_WIDTH = 2048;
export const DISPLAY_CANVAS_HEIGHT = 1024;

/**
 * Compute shader workgroup edge, in invocations. 8 × 8 = 64 invocations keeps
 * occupancy high on every tier of GPU without approaching the 256-invocation
 * per-workgroup limit that the WebGPU baseline guarantees.
 */
export const WORKGROUP_SIZE = 8;

/**
 * Red-black SOR sweeps for the pressure Poisson solve. Below ~20 the velocity
 * field retains visible divergence (dye compresses and thins); above ~40 the
 * cost is real and the improvement is not visible.
 */
export const PRESSURE_ITERATIONS_DEFAULT = 30;

/** Iterations with the "higher solver accuracy" preference enabled. */
export const PRESSURE_ITERATIONS_HIGH = 50;

export const PRESSURE_ITERATIONS_RANGE = new Range(1, 200);

/**
 * Ceiling on the red-black SOR iterations spent on the implicit viscous solve.
 * Each one is a red dispatch and a black dispatch.
 *
 * The count itself is derived per step from α = νΔt/h² (see
 * `common/gpu/solverSchedule.ts`); this only bounds the stiffest corner of the
 * parameter space — the finest grid at the top of the viscosity slider — where
 * the required count runs into the hundreds and the flow is creeping anyway.
 */
export const DIFFUSION_SWEEPS_MAX = 12;

/**
 * Error the viscous solve is iterated down to, as a fraction of the error its
 * initial guess starts with. 10⁻³ is far below the point where a difference is
 * visible in the dye, and across the great majority of the parameter space it is
 * what makes the *displayed* viscosity the one the fluid actually feels.
 *
 * It is a target, not a guarantee: DIFFUSION_SWEEPS_MAX caps the iteration
 * count, and in the stiffest corner — the ultra-fine grid at the top of the
 * viscosity slider, α ≈ 1.7 × 10³, ω ≈ 1.966 — twelve sweeps leave roughly two
 * thirds of the error rather than a thousandth of it. There the fluid is still
 * somewhat less viscous than the readout claims, which biases the effective
 * Reynolds number upward. That corner is creeping flow with nothing to see, so
 * the cap is the right trade; it is not a corner where the tolerance holds.
 */
export const DIFFUSION_RESIDUAL_TOLERANCE = 1e-3;

/**
 * Below this diffusion coefficient α = νΔt/h², the implicit diffusion sweep is
 * indistinguishable from the identity (its update is O(α)) and the iteration
 * loop is skipped, keeping only the single seeding sweep.
 *
 * In practice the viscosity floor (3×10⁻⁴ m²/s) keeps α ≈ 0.08 at the standard
 * grid during normal play, so this guard almost never triggers while running.
 * It exists for the paused / near-zero-dt path, where α collapses to zero and
 * the iterations would otherwise do nothing at all.
 */
export const DIFFUSION_SKIP_ALPHA = 1e-3;

// ── Time stepping ─────────────────────────────────────────────────────────────

/**
 * Largest physics step taken in one substep, in seconds. A tab that was
 * backgrounded reports a huge dt; without a clamp the semi-Lagrangian backtrace
 * would jump most of the channel in a single step and the wake would blow away.
 */
export const MAX_PHYSICS_DT = 1 / 60;

/** Upper bound on substeps per frame, so a long stall cannot lock up the GPU. */
export const MAX_SUBSTEPS_PER_FRAME = 3;

/**
 * Simulation time the step-forward button advances, in seconds — one frame at
 * 60 fps. Numerically equal to MAX_PHYSICS_DT but a separate constant, because
 * it answers a different question: MAX_PHYSICS_DT is what the solver's
 * stability allows, this is what one press of the button should mean.
 */
export const STEP_FORWARD_DT = 1 / 60;

/** Selectable playback speeds in radio-group display order → simulation seconds per wall-clock second. */
export const TIME_SPEED_MULTIPLIERS: ReadonlyMap<TimeSpeed, number> = new Map([
  [TimeSpeed.SLOW, 0.25],
  [TimeSpeed.NORMAL, 1],
  [TimeSpeed.FAST, 2],
]);

// ── Flow parameters (SI units) ────────────────────────────────────────────────

/** Inflow speed at the left boundary, in m/s. */
export const FLOW_SPEED_RANGE = new Range(0.05, 3);
export const FLOW_SPEED_DEFAULT = 0.6;

/**
 * Time constant, in seconds, of the exponential ramp the inflow boundary
 * follows when the speed slider moves.
 *
 * The inflow is a Dirichlet condition, and an incompressible projection answers
 * a step change instantly and globally: the pressure solve tilts the whole
 * channel to reconcile the new inlet flux with the momentum the fluid already
 * has, and when that transient reaches the p = 0 outflow it reflects and drives
 * the flow there into reverse — the whole column sloshes backward at up to
 * several times the *old* speed. Real channel flow cannot change its momentum
 * in one frame either, so the boundary is given the same inertia: the solver
 * approaches the slider's value exponentially, reaching 95 % of any change in
 * ~1.8 s. Readouts (Reynolds number, regime) still track the slider directly.
 */
export const FLOW_SPEED_RESPONSE_TIME = 0.6;

/**
 * Kinematic viscosity ν, in m²/s. The range brackets the interesting Reynolds
 * numbers for the default obstacle: at U = 1 m/s and D = 0.15 m, ν = 3e-4 gives
 * Re = 500 and ν = 1e-1 gives Re = 1.5. Combined with the speed range, the whole
 * span from creeping flow to a turbulent wake is reachable.
 *
 * The floor is 3e-4 rather than lower for a numerical reason: pressure lives on
 * the same grid points as velocity, and that collocated arrangement admits a
 * checkerboard pressure mode which nothing damps once the physical viscosity
 * gets small enough. Below roughly 3e-4 it shows up as speckle on the obstacle's
 * surface. Removing it properly would mean a staggered (MAC) grid.
 */
export const VISCOSITY_RANGE = new Range(3e-4, 1e-1);
export const VISCOSITY_DEFAULT = 1e-3;

/**
 * Obstacle diameter D, in metres — the length scale in Re = U·D/ν.
 *
 * The top of the range is sized for the airfoil, which needs the headroom
 * most: its chord equals D and its thickness is only 12 % of that, so at any
 * slider setting the wing is the visually smallest of the three bodies. At
 * D = 0.8 the chord spans 40 % of the 2 m channel, while the cylinder and
 * plate at the same setting span 80 % of its height, leaving Venturi gaps at
 * the walls.
 */
export const OBSTACLE_DIAMETER_RANGE = new Range(0.05, 0.8);
export const OBSTACLE_DIAMETER_DEFAULT = 0.15;

/**
 * Angle of attack of the plate and the airfoil, in degrees — the angle between
 * the body's chord and the oncoming flow. Positive tilts the leading edge up.
 *
 * The range spans fully streamlined (0° is the plate lying along the flow) to
 * fully broadside (±90°), which is where the plate sheds at the lowest speed of
 * the three bodies. The airfoil stalls a little past ±15°, but the slider keeps
 * going: a wing broadside to the flow is its own kind of bluff body.
 *
 * The default matches the 0.14 rad the airfoil previously carried as a fixed
 * constant in the shader: a small deliberate tilt, so its wake is asymmetric
 * like a real wing's, and not a value the learner has to find to see anything.
 */
export const ANGLE_OF_ATTACK_RANGE = new Range(-90, 90);
export const ANGLE_OF_ATTACK_DEFAULT = 8;

/**
 * Obstacle centre, in metres from the channel's lower-left corner. Placed a
 * quarter of the way downstream so there is inflow to develop upstream of it
 * and three quarters of the channel for the wake to form in.
 */
export const OBSTACLE_CENTER_DEFAULT = new Vector2(0.5, 0.5);

/**
 * Where the obstacle's centre may be when the body is small, in metres — the
 * loosest case; obstacleDragBounds() tightens this region as the body grows.
 *
 * Clear of the inflow strip on the left (a body overlapping it would fight the
 * boundary condition that forces the velocity there), clear of the outflow on
 * the right, and clear of both walls so there is always room for a wake.
 * @internal Exported for unit tests; not part of the application API.
 */
export const OBSTACLE_DRAG_BOUNDS_M = new Bounds2(0.25, 0.25, 1.2, 0.75);

/**
 * Closest the obstacle's edge may come to a wall, the inflow or the outflow,
 * in metres. Not arbitrary: the static drag bounds above were sized for bodies
 * up to 0.35 m, and 0.25 − 0.35/2 = 0.075 — so every size the original slider
 * allowed keeps exactly the region it always had, and only larger bodies feel
 * the tightening.
 */
const OBSTACLE_CLEARANCE_M = 0.075;

/**
 * The region the obstacle's centre may occupy for a body of the given
 * diameter: the static bounds above, shrunk on each side by the body's radius
 * plus OBSTACLE_CLEARANCE_M, so the edge itself stays clear of the walls and
 * both flow boundaries.
 *
 * Non-empty for every diameter in OBSTACLE_DIAMETER_RANGE — the largest body
 * pins near mid-height with a gap at each wall. A unit test pins both that and
 * the sizes the original slider allowed seeing no change.
 */
export function obstacleDragBounds(diameter: number): Bounds2 {
  const edge = diameter / 2 + OBSTACLE_CLEARANCE_M;
  return new Bounds2(
    Math.max(OBSTACLE_DRAG_BOUNDS_M.minX, edge),
    Math.max(OBSTACLE_DRAG_BOUNDS_M.minY, edge),
    Math.min(OBSTACLE_DRAG_BOUNDS_M.maxX, CHANNEL_WIDTH_M - edge),
    Math.min(OBSTACLE_DRAG_BOUNDS_M.maxY, CHANNEL_HEIGHT_M - edge),
  );
}

/** How fast a held arrow key moves the obstacle, in metres per second. */
export const OBSTACLE_KEYBOARD_SPEED_MPS = 0.4;

/**
 * Largest focal half-separation the ellipse may carry, as a fraction of its
 * semi-major axis a = D/2. At the cap the minor axis is still b ≈ 0.31·a, so
 * the slimmest ellipse the learner can pull remains something to see and grab.
 */
export const OBSTACLE_FOCAL_MAX_FRACTION = 0.95;

/**
 * Maximum airfoil thickness as a fraction of chord. The lower end is not zero:
 * a vanished foil is the plate's job (its own shape), and a hairline body has
 * no surface left to hang the thickness handle on. 0.12 keeps the NACA 0012
 * the shader previously carried as a constant.
 */
export const AIRFOIL_THICKNESS_RANGE = new Range(0.04, 0.3);
export const AIRFOIL_THICKNESS_DEFAULT = 0.12;

/**
 * Where the NACA thickness distribution peaks, as a fraction of chord from the
 * leading edge. The thickness handle sits on the thickest point of the upper
 * surface, so dragging it is dragging the body's own maximum.
 */
export const AIRFOIL_MAX_THICKNESS_STATION = 0.3;

// ── Handle knobs ──────────────────────────────────────────────────────────────

/** View radius of the visible dot on a handle knob, in screen pixels. */
export const KNOB_DOT_RADIUS_PX = 6;

/**
 * View radius of the invisible hit/focus circle around that dot, in screen
 * pixels. Bounded by how close two knobs get: the ellipse's foci coincide at
 * zero eccentricity, and the airfoil's thickness knob rides near the leading
 * edge on a slim section, so a larger mouse target would start stealing presses
 * from its neighbour.
 */
export const KNOB_HIT_RADIUS_PX = 14;

/**
 * How far a knob's *touch* area extends past that hit circle, in screen pixels.
 * Touch needs a bigger target than the mouse and tolerates the overlap, because
 * a finger cannot aim at a 12 px dot in the first place.
 */
export const KNOB_TOUCH_DILATION_PX = 8;

// ── Handle keyboard steps ─────────────────────────────────────────────────────
// One press of an arrow key on a handle moves its quantity by this much; Shift
// divides by HANDLE_KEYBOARD_STEP_FACTOR for the fine adjustments.

/** How much one press of ↑/↓ on the size handle changes D, in metres. */
export const SIZE_KEYBOARD_STEP_M = 0.01;

/** How much one press of ←/→ on a handle rotates the body, in degrees. */
export const ANGLE_KEYBOARD_STEP_DEG = 1;

/** How much one press of ↑/↓ on a focus handle moves the focus, in metres. */
export const FOCAL_KEYBOARD_STEP_M = 0.005;

/** How much one press of ↑/↓ on the thickness handle changes the fraction. */
export const THICKNESS_KEYBOARD_STEP = 0.01;

/** Shift-press fineness divisor shared by every handle. */
export const HANDLE_KEYBOARD_STEP_FACTOR = 5;

/**
 * Vorticity-confinement strength, dimensionless.
 *
 * Semi-Lagrangian advection is stable but dissipative: it damps exactly the
 * small-scale vorticity that makes a vortex street legible. Confinement adds a
 * force along the vorticity gradient to restore it. This is a visual-fidelity
 * correction, not a term in the Navier–Stokes equations — see doc/model.md.
 */
export const VORTICITY_RANGE = new Range(0, 40);
export const VORTICITY_DEFAULT = 18;

/**
 * Radius of the impulse a pointer drag applies, in metres. Comparable to the
 * default obstacle so a drag is a meaningful disturbance rather than a pinprick.
 */
export const POINTER_RADIUS_M = 0.08;

/**
 * Fraction of dye remaining after one second.
 *
 * The range runs the full span from "dye never fades" to "dye obviously fades",
 * because a control the learner cannot see working is not a control. Dye
 * crosses the channel in under a second at the fastest inflow speeds and more
 * than ten at the slowest, so a narrow range near 1 — the original 0.9 to 1 —
 * changed what reached the far wall by only a few percent, and even
 * pointer-painted dye advected away long before a 10 %-per-second fade could
 * act on it.
 *
 * The default stays at 0.99: the inflow bands are the main visualization, and
 * they should survive to the far wall unless the learner deliberately asks for
 * faster fading by moving the slider down.
 */
export const DYE_DISSIPATION_RANGE = new Range(0.1, 1);
export const DYE_DISSIPATION_DEFAULT = 0.99;

// ── Tracer dots ───────────────────────────────────────────────────────────────
//
// A rake of neutrally buoyant dots released at the inlet, carried by the flow
// and retired when they leave the channel — the numerical version of dropping
// leaves on a stream, and close kin to the hydrogen-bubble timelines of a real
// flow-visualization lab. They show what dye cannot: where the fluid stagnates,
// how much faster it goes round the body than through the wake, and which way
// the recirculation bubble turns.
//
// The particles live in a GPU storage buffer; see common/gpu/shaders/tracerStep.wgsl.

/**
 * Dots in one released column, spread evenly across the channel height with a
 * lane's worth of clearance from each wall (lane i sits at (i+1)/(N+1) of the
 * height). Twenty-one puts a dot every ~4.5 cm, fine enough that the column
 * reads as a line being deformed rather than as scattered points.
 */
export const TRACER_LANE_COUNT = 21;

/**
 * Columns the buffer holds. Slots are reused in order, so this is also how many
 * columns may be in flight at once: at TRACER_COLUMN_SPACING_M apart they span
 * 2.8 m, comfortably more than the 2 m channel, so a column's slot is not
 * recycled until well after that column has left — including the stragglers
 * that get caught in the wake and take far longer than the free stream to
 * cross. Halve the spacing and this must double to hold that span.
 */
export const TRACER_BATCH_COUNT = 5;

/** Particles in the buffer. One dot per lane per column. */
export const TRACER_TOTAL_COUNT = TRACER_LANE_COUNT * TRACER_BATCH_COUNT;

/**
 * Distance the free stream travels between one released column and the next, in
 * metres.
 *
 * Spacing the releases by distance rather than by time is what keeps the
 * columns evenly spaced *in the channel* at every flow speed — which is the
 * whole point of the picture. A fixed time interval would bunch them up at the
 * bottom of the speed slider and string them out at the top.
 *
 * At 0.56 m three or four columns are in the channel at once. Closer than this
 * and the columns read as a wall of dots that hides the field behind them;
 * further apart and there are too few of them to compare one against the next.
 */
export const TRACER_COLUMN_SPACING_M = 0.56;

/** Dot radius, in metres. ~5.6 px across once the field is drawn at its on-screen size. */
export const TRACER_RADIUS_M = 0.008;

/**
 * Where a released dot starts, in metres from the left wall. Clear of the
 * two-cell dye injection strip, so a dot is in freely advecting fluid from its
 * first step rather than sitting in the Dirichlet boundary.
 */
export const TRACER_INLET_X_M = 0.02;

/**
 * How close to the right wall a dot may get before it is retired, in metres.
 * A dot is parked rather than deleted — its slot is simply invisible until the
 * release cycle comes back round to it.
 */
export const TRACER_EXIT_MARGIN_M = 0.01;

/** Seconds a freshly released dot takes to fade up to full opacity, so it does not pop into view. */
export const TRACER_FADE_IN_SECONDS = 0.15;

/** Invocations per workgroup in the tracer advection kernel. One dimension: the buffer is a flat array. */
export const TRACER_WORKGROUP_SIZE = 64;

// ── Measurement tools (tape and ruler) ────────────────────────────────────────

/**
 * Where the measuring tape's base and tip sit when it is first taken out or
 * Reset All runs, in metres from the channel's lower-left corner. The default
 * span (≈ 0.67 m across the lower half of the channel) is long enough that the
 * readout is obviously live from the first drag, and clear of the default
 * obstacle at (0.5, 0.5) so the tape never spawns underneath it.
 */
export const TAPE_BASE_DEFAULT = new Vector2(0.5, 0.35);
export const TAPE_TIP_DEFAULT = new Vector2(1.1, 0.55);

/**
 * How far the tip sits from the base when the tape is dragged out, in metres.
 * Shorter than the default span above, because the take-out drag carries the
 * whole tape and a long tail would sweep across the controls on the way out.
 */
export const TAPE_TAKEOUT_SPAN_M = new Vector2(0.55, 0.3);

/**
 * Where the ruler's centre sits when it is first taken out or Reset All runs,
 * in metres. Near the top of the channel: the interesting lengths to measure —
 * the body and its wake — live in and below the middle, so the ruler starts
 * parked out of their way.
 */
export const RULER_POSITION_DEFAULT = new Vector2(0.5, 0.78);

/** Length of the ruler, in metres. One metre spans half the channel — enough to measure the full channel height. */
export const RULER_LENGTH_M = 1;

/** Distance between labelled ticks, in metres. 0.1 m = 35 px at the field's scale, wide enough for two-digit labels. */
export const RULER_MAJOR_TICK_M = 0.1;

/** Minor ticks per major tick. Five puts a minor tick every 2 cm. */
export const RULER_MINOR_TICKS_PER_MAJOR = 5;

/** Ruler body height, in screen pixels. */
export const RULER_HEIGHT_PX = 50;

/** Space between the ruler's ends and its first and last tick, in screen pixels. */
export const RULER_INSETS_PX = 10;

/** How fast a held arrow key moves the ruler, in metres per second. Matches the obstacle's keyboard speed. */
export const RULER_KEYBOARD_SPEED_MPS = 0.4;

/**
 * Closest a tool's grab point may come to the edge of the screen, in metres.
 * Keeps the tape's crosshairs and the ruler's centre reachable rather than
 * pinned under the window edge.
 */
export const TOOL_DRAG_MARGIN_M = 0.06;

/**
 * Extra slack around the toolbox panel, in screen pixels, within which ending
 * a tool drag still counts as putting the tool back.
 */
export const TOOLBOX_RETURN_TOLERANCE_PX = 10;

/**
 * Where the tape's base lands relative to the pointer that took it out, in
 * screen pixels (positive y is down). The base image's lower-right corner sits
 * at the base point, so a small offset down and to the right leaves the pointer
 * inside the tape's body. Small is the point: the drag that follows a take-out
 * keeps whatever offset the take-out established, so a large one leaves the
 * tape floating a hand's width from the cursor for the whole gesture.
 */
export const TAPE_TAKEOUT_OFFSET_PX = new Vector2(12, 12);

/**
 * Where the pointer grabs the ruler when it is taken out, as a fraction of the
 * ruler's width and height measured from its top-left corner. A quarter in from
 * the left end and a quarter up from the bottom edge is on the ruler's body but
 * far enough along it that the ruler does not spawn centred on the toolbox.
 */
export const RULER_TAKEOUT_GRAB_FRACTION = new Vector2(0.25, 0.75);

/**
 * How far a take-out press must travel before it counts as a drag rather than a
 * click, in screen pixels. A press that never travels that far is a click, and
 * a click leaves the tool at its default position out in the channel instead of
 * draped over the toolbox it was just pulled from.
 */
export const TOOL_TAKEOUT_CLICK_SLOP_PX = 6;

/** Horizontal gap between the toolbox's icons, in screen pixels. */
export const TOOLBOX_ICON_SPACING = 12;

/**
 * How far a toolbox icon's touch area extends past the icon, in screen pixels.
 * The icons are drawn small so the panel stays out of the way of the channel;
 * the dilation gives a finger a target without enlarging the panel. Half the
 * icon spacing, so two dilated icons meet rather than overlap.
 */
export const TOOLBOX_ICON_TOUCH_DILATION_PX = 6;

/** Size of the toolbox's hand-drawn ruler icon, in screen pixels. */
export const RULER_ICON_WIDTH_PX = 52;
export const RULER_ICON_HEIGHT_PX = 26;

/** Ticks drawn along each edge of the ruler icon, and their pitch and inset, in screen pixels. */
export const RULER_ICON_TICK_COUNT = 6;
export const RULER_ICON_TICK_SPACING_PX = 8;
export const RULER_ICON_TICK_INSET_PX = 6;
export const RULER_ICON_TICK_LENGTH_PX = 9;

// ── Scale bar ─────────────────────────────────────────────────────────────────

/**
 * Length the scale bar under the field spans, in metres. 0.1 m matches the
 * ruler's labelled ticks and renders 35 px at the field's scale — long enough
 * to read as a scale, short enough to sit quietly at the end of the readout
 * row.
 */
export const SCALE_BAR_LENGTH_M = 0.1;

/** Height of the scale bar's end ticks, in screen pixels. */
export const SCALE_BAR_TICK_HEIGHT_PX = 8;

/** Stroke width of the scale bar and its ticks, in screen pixels. */
export const SCALE_BAR_STROKE_WIDTH_PX = 2;

/** Gap between the scale bar's last tick and its label, in screen pixels. */
export const SCALE_BAR_LABEL_GAP_PX = 6;

// ── Flow-regime thresholds (Reynolds number, dimensionless) ───────────────────
// Classical transition values for flow past a circular cylinder. See
// FlowRegime.ts for how they are applied and doc/model.md for their limits.

/** Below this the flow creeps around the obstacle with no separation. */
export const RE_SEPARATION = 5;

/** Onset of periodic vortex shedding — the Kármán street (a Hopf bifurcation). */
export const RE_SHEDDING_ONSET = 47;

/** Above this the shed vortices lose coherence and the wake reads as turbulent. */
export const RE_TURBULENT_ONSET = 200;

// ── Namespace registration ────────────────────────────────────────────────────
// Exposes every constant at phet.fluidDynamics.FluidDynamicsConstants for
// console debugging. This object must list every export above; a test in
// tests/FluidDynamicsConstants.test.ts compares the two so a constant added
// later cannot be quietly left out, which is how eleven of them went missing
// when the shaping handles landed.

FluidDynamicsNamespace.register("FluidDynamicsConstants", {
  TIME_SPEED_MULTIPLIERS,
  SCREEN_VIEW_MARGIN,
  PANEL_CORNER_RADIUS,
  FIELD_VIEW_BOUNDS,
  CONTROL_PANEL_WIDTH,
  CONTROL_LABEL_FONT_SIZE,
  PREFERENCES_HEADING_FONT_SIZE,
  READOUT_FONT_SIZE,
  SLIDER_TRACK_HEIGHT_PX,
  SLIDER_TRACK_INSET_PX,
  PREFERENCE_SLIDER_TRACK_LENGTH_PX,
  SLIDER_THUMB_SIZE,
  SLIDER_THUMB_TOUCH_DILATION_X_PX,
  SLIDER_THUMB_TOUCH_DILATION_Y_PX,
  WEBGPU_TITLE_FONT_SIZE,
  WEBGPU_MESSAGE_FONT_SIZE,
  WEBGPU_MESSAGE_MAX_WIDTH,
  CHANNEL_WIDTH_M,
  CHANNEL_HEIGHT_M,
  GRID_WIDTH_DEFAULT,
  GRID_HEIGHT_DEFAULT,
  GRID_WIDTH_FINE,
  GRID_HEIGHT_FINE,
  GRID_WIDTH_VERY_FINE,
  GRID_HEIGHT_VERY_FINE,
  GRID_WIDTH_ULTRA_FINE,
  GRID_HEIGHT_ULTRA_FINE,
  DISPLAY_CANVAS_WIDTH,
  DISPLAY_CANVAS_HEIGHT,
  WORKGROUP_SIZE,
  PRESSURE_ITERATIONS_DEFAULT,
  PRESSURE_ITERATIONS_HIGH,
  PRESSURE_ITERATIONS_RANGE,
  DIFFUSION_SWEEPS_MAX,
  DIFFUSION_RESIDUAL_TOLERANCE,
  DIFFUSION_SKIP_ALPHA,
  MAX_PHYSICS_DT,
  MAX_SUBSTEPS_PER_FRAME,
  STEP_FORWARD_DT,
  FLOW_SPEED_RANGE,
  FLOW_SPEED_DEFAULT,
  FLOW_SPEED_RESPONSE_TIME,
  VISCOSITY_RANGE,
  VISCOSITY_DEFAULT,
  OBSTACLE_DIAMETER_RANGE,
  OBSTACLE_DIAMETER_DEFAULT,
  ANGLE_OF_ATTACK_RANGE,
  ANGLE_OF_ATTACK_DEFAULT,
  OBSTACLE_CENTER_DEFAULT,
  OBSTACLE_DRAG_BOUNDS_M,
  obstacleDragBounds,
  OBSTACLE_KEYBOARD_SPEED_MPS,
  OBSTACLE_FOCAL_MAX_FRACTION,
  AIRFOIL_THICKNESS_RANGE,
  AIRFOIL_THICKNESS_DEFAULT,
  AIRFOIL_MAX_THICKNESS_STATION,
  KNOB_DOT_RADIUS_PX,
  KNOB_HIT_RADIUS_PX,
  KNOB_TOUCH_DILATION_PX,
  SIZE_KEYBOARD_STEP_M,
  ANGLE_KEYBOARD_STEP_DEG,
  FOCAL_KEYBOARD_STEP_M,
  THICKNESS_KEYBOARD_STEP,
  HANDLE_KEYBOARD_STEP_FACTOR,
  VORTICITY_RANGE,
  VORTICITY_DEFAULT,
  POINTER_RADIUS_M,
  DYE_DISSIPATION_RANGE,
  DYE_DISSIPATION_DEFAULT,
  TRACER_LANE_COUNT,
  TRACER_BATCH_COUNT,
  TRACER_TOTAL_COUNT,
  TRACER_COLUMN_SPACING_M,
  TRACER_RADIUS_M,
  TRACER_INLET_X_M,
  TRACER_EXIT_MARGIN_M,
  TRACER_FADE_IN_SECONDS,
  TRACER_WORKGROUP_SIZE,
  TAPE_BASE_DEFAULT,
  TAPE_TIP_DEFAULT,
  TAPE_TAKEOUT_SPAN_M,
  RULER_POSITION_DEFAULT,
  RULER_LENGTH_M,
  RULER_MAJOR_TICK_M,
  RULER_MINOR_TICKS_PER_MAJOR,
  RULER_HEIGHT_PX,
  RULER_INSETS_PX,
  RULER_KEYBOARD_SPEED_MPS,
  TOOL_DRAG_MARGIN_M,
  TOOLBOX_RETURN_TOLERANCE_PX,
  TAPE_TAKEOUT_OFFSET_PX,
  RULER_TAKEOUT_GRAB_FRACTION,
  TOOL_TAKEOUT_CLICK_SLOP_PX,
  TOOLBOX_ICON_SPACING,
  TOOLBOX_ICON_TOUCH_DILATION_PX,
  RULER_ICON_WIDTH_PX,
  RULER_ICON_HEIGHT_PX,
  RULER_ICON_TICK_COUNT,
  RULER_ICON_TICK_SPACING_PX,
  RULER_ICON_TICK_INSET_PX,
  RULER_ICON_TICK_LENGTH_PX,
  SCALE_BAR_LENGTH_M,
  SCALE_BAR_TICK_HEIGHT_PX,
  SCALE_BAR_STROKE_WIDTH_PX,
  SCALE_BAR_LABEL_GAP_PX,
  RE_SEPARATION,
  RE_SHEDDING_ONSET,
  RE_TURBULENT_ONSET,
});
