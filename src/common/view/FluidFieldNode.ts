/**
 * FluidFieldNode.ts
 *
 * The bridge between Scenery and WebGPU.
 *
 * ── Why this is not "a CanvasNode with a webgpu context" ──────────────────────
 * Scenery's CanvasNode does not own a canvas. It is handed a
 * CanvasRenderingContext2D belonging to Scenery's own shared canvas layer,
 * already transformed into this node's local frame, and asked to paint into it —
 * there is nothing to call getContext("webgpu") on.
 *
 * So the engine owns a *detached* canvas, never added to the document, and
 * configures that one with a "webgpu" context. Each frame it renders the fluid
 * into it, and paintCanvas blits the result with drawImage. In Chrome that blit
 * stays on the GPU.
 *
 * drawImage rather than putImageData is not a preference: putImageData ignores
 * the canvas transformation matrix that Scenery has already applied, so the
 * field would render at the wrong place and scale. (Same trap documented in
 * VariableStarPhotometry's StarFieldNode.)
 *
 * ── Frame ordering ────────────────────────────────────────────────────────────
 * paintCanvas runs inside Display.updateDisplay() and must not mutate the scene
 * graph, so all GPU work happens in update(), called from the ScreenView's
 * step(). update() ends with invalidatePaint(), because Scenery will not
 * re-invoke paintCanvas on its own schedule.
 */

import { Property, type TReadOnlyProperty } from "scenerystack/axon";
import { Bounds2, Vector2 } from "scenerystack/dot";
import { type EmptySelfOptions, optionize } from "scenerystack/phet-core";
import { ModelViewTransform2 } from "scenerystack/phetcommon";
import { CanvasNode, type CanvasNodeOptions, type Color, DragListener } from "scenerystack/scenery";
import type { TimeSpeed } from "scenerystack/scenery-phet";
import FluidDynamicsColors from "../../FluidDynamicsColors.js";
import {
  CHANNEL_HEIGHT_M,
  CHANNEL_WIDTH_M,
  MAX_PHYSICS_DT,
  MAX_SUBSTEPS_PER_FRAME,
  POINTER_RADIUS_M,
} from "../../FluidDynamicsConstants.js";
import { StringManager } from "../../i18n/StringManager.js";
import { FluidGridSpec } from "../gpu/FluidGridSpec.js";
import { WebGPUFluidEngine } from "../gpu/WebGPUFluidEngine.js";
import { acquireFluidDevice, deviceLostEmitter, type GpuUnavailableReason } from "../gpu/webgpuSupport.js";
import type { FluidModel } from "../model/FluidModel.js";
import { obstacleShapeCode } from "../model/ObstacleShape.js";
import { visualizationModeCode } from "../model/VisualizationMode.js";
import { timeSpeedMultiplier } from "../TimeModel.js";

/**
 * The speed colour ramp saturates at this multiple of the inflow speed, but never
 * below MIN_VELOCITY_SCALE (m/s), so it stays readable across the speed slider.
 */
const VELOCITY_SCALE_FACTOR = 2;
const MIN_VELOCITY_SCALE = 0.2;

export type FluidFieldNodeOptions = CanvasNodeOptions;

export class FluidFieldNode extends CanvasNode {
  /** Why the field cannot be shown, or null while it can (or might still be). */
  public readonly gpuUnavailableReasonProperty: TReadOnlyProperty<GpuUnavailableReason | null>;

  /** Model metres ↔ view pixels. Model y is up; view y is down. */
  public readonly modelViewTransform: ModelViewTransform2;

  private readonly model: FluidModel;
  private readonly isPlayingProperty: TReadOnlyProperty<boolean>;
  private readonly timeSpeedProperty: TReadOnlyProperty<TimeSpeed>;
  private readonly reasonProperty: Property<GpuUnavailableReason | null>;
  private readonly gpuCanvas: HTMLCanvasElement;
  private readonly fieldBounds: Bounds2;
  private readonly disposers: (() => void)[] = [];

  private engine: WebGPUFluidEngine | null = null;

  /** Pointer state, consumed and cleared by the next solver step. */
  private pointerPosition: Vector2 | null = null;
  private pointerDelta = Vector2.ZERO;

  /** Elapsed solver time, in seconds. Drives the inflow perturbation. */
  private elapsedTime = 0;

  private isFieldDisposed = false;

  public constructor(
    model: FluidModel,
    isPlayingProperty: TReadOnlyProperty<boolean>,
    timeSpeedProperty: TReadOnlyProperty<TimeSpeed>,
    fieldBounds: Bounds2,
    providedOptions?: FluidFieldNodeOptions,
  ) {
    const a11y = StringManager.getInstance().getFluidA11yStrings();
    const options = optionize<FluidFieldNodeOptions, EmptySelfOptions, CanvasNodeOptions>()(
      {
        canvasBounds: fieldBounds,
        // A screen-reader user cannot see the dye, so the field carries a heading,
        // a hint about the pointer interaction, and (supplied by the caller) a
        // live paragraph describing what the flow is currently doing. It is not
        // focusable: dragging the fluid has no keyboard equivalent, and a tab
        // stop that does nothing is worse than none. The description is read in
        // the play area like any other text.
        tagName: "div",
        accessibleHeading: a11y.fieldNameStringProperty,
        accessibleHelpText: a11y.fieldHelpTextStringProperty,
      },
      providedOptions,
    );
    super(options);

    this.model = model;
    this.isPlayingProperty = isPlayingProperty;
    this.timeSpeedProperty = timeSpeedProperty;
    this.fieldBounds = fieldBounds;

    // Model space is the channel in metres with the origin at its lower-left
    // corner and y increasing upward, which is how the shaders think about it.
    this.modelViewTransform = ModelViewTransform2.createRectangleInvertedYMapping(
      new Bounds2(0, 0, CHANNEL_WIDTH_M, CHANNEL_HEIGHT_M),
      fieldBounds,
    );

    this.reasonProperty = new Property<GpuUnavailableReason | null>(null);
    this.gpuUnavailableReasonProperty = this.reasonProperty;

    // Never added to the document: it exists only as a render target that
    // drawImage can read from.
    this.gpuCanvas = document.createElement("canvas");

    this.startDevice();
    this.addPointerForcing();

    // Grid resolution is the one parameter that cannot be a uniform — it changes
    // how much memory the fields need — so it rebuilds the engine's textures.
    const resolutionListener = (): void => {
      this.engine?.setGrid(FluidGridSpec.forResolution(model.gridResolutionProperty.value));
    };
    model.gridResolutionProperty.lazyLink(resolutionListener);
    this.disposers.push(() => model.gridResolutionProperty.unlink(resolutionListener));

    const deviceLostListener = (): void => {
      this.reasonProperty.value = "deviceLost";
      // Disposed, not merely dropped: the engine's uncaptured-error handler is
      // registered on the device, which outlives it, so letting go of the
      // reference here would leak the engine rather than release it. Destroying
      // resources on a lost device is explicitly a no-op, so this is safe.
      this.engine?.dispose();
      this.engine = null;
    };
    deviceLostEmitter.addListener(deviceLostListener);
    this.disposers.push(() => deviceLostEmitter.removeListener(deviceLostListener));
  }

  /**
   * Advances the solver and schedules a repaint. Called from the ScreenView's
   * step — never from the model, which has no access to a device.
   */
  public update(dt: number): void {
    const engine = this.engine;
    if (engine === null || !engine.isRunning) {
      return;
    }

    if (this.isPlayingProperty.value) {
      // Playback speed scales dt before substepping, so slow motion runs the
      // same stable solver with smaller steps and fast runs more of them.
      this.advanceSolver(dt * timeSpeedMultiplier(this.timeSpeedProperty.value));
    } else {
      // Paused: still re-render, so switching visualization mode or dragging the
      // obstacle updates the picture instead of freezing on a stale frame.
      engine.step(0, this.stepValues());
      // Consume the pointer delta, as the playing branch does after its first
      // substep. The impulse is skipped at dt = 0 (forces.wgsl), but a delta
      // left over from a drag made while paused would otherwise fire as a
      // phantom push on the first frame after resuming.
      this.pointerDelta = Vector2.ZERO;
    }

    this.invalidatePaint();
  }

  /**
   * Advances the solver by exactly one step regardless of the play state, for
   * the time control's step-forward button.
   */
  public stepOnce(dt: number): void {
    // Substeps like update(), so a fast-speed step is not silently clamped back
    // to a single MAX_PHYSICS_DT step.
    this.advanceSolver(dt * timeSpeedMultiplier(this.timeSpeedProperty.value));
    this.invalidatePaint();
  }

  /**
   * Runs the solver over dt seconds of simulation time. A backgrounded tab
   * reports a dt of many seconds; substepping keeps each solver step within its
   * stable displacement, and the cap keeps a long stall from turning into a
   * hundred dispatches in one frame.
   */
  private advanceSolver(dt: number): void {
    const engine = this.engine;
    if (engine === null || !engine.isRunning) {
      return;
    }

    const substeps = Math.min(Math.ceil(dt / MAX_PHYSICS_DT), MAX_SUBSTEPS_PER_FRAME);
    const substepDt = Math.min(dt / substeps, MAX_PHYSICS_DT);

    for (let i = 0; i < substeps; i++) {
      this.elapsedTime += substepDt;
      engine.step(substepDt, this.stepValues());
      // The pointer impulse is a per-frame event, not a sustained force: it
      // must not be applied once per substep or a fast drag would inject
      // several times the momentum the learner actually supplied.
      this.pointerDelta = Vector2.ZERO;
    }
  }

  /**
   * Blits the solver's output. Must not do anything else: Scenery calls this
   * from inside Display.updateDisplay(), where mutating a Node is unsafe.
   */
  public override paintCanvas(context: CanvasRenderingContext2D): void {
    if (this.engine === null) {
      return;
    }
    context.drawImage(
      this.gpuCanvas,
      this.fieldBounds.minX,
      this.fieldBounds.minY,
      this.fieldBounds.width,
      this.fieldBounds.height,
    );
  }

  /** True where a pointer press should be treated as forcing the fluid. */
  public override containsPointSelf(point: Vector2): boolean {
    return this.fieldBounds.containsPoint(point);
  }

  public reset(): void {
    this.elapsedTime = 0;
    this.pointerPosition = null;
    this.pointerDelta = Vector2.ZERO;
    this.engine?.reset();
    this.invalidatePaint();
  }

  public override dispose(): void {
    if (this.isFieldDisposed) {
      return;
    }
    this.isFieldDisposed = true;

    for (const disposer of this.disposers.splice(0)) {
      disposer();
    }
    this.engine?.dispose();
    this.engine = null;
    this.reasonProperty.dispose();

    super.dispose();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * Requests a device and builds the engine. Scenery construction is
   * synchronous and device acquisition is not, so the node starts out painting
   * nothing and begins rendering once this resolves.
   */
  private startDevice(): void {
    acquireFluidDevice().then((acquisition) => {
      // The screen may have been disposed while the request was in flight.
      if (this.isFieldDisposed) {
        return;
      }
      if (!acquisition.available) {
        this.reasonProperty.value = acquisition.reason;
        return;
      }
      try {
        this.engine = new WebGPUFluidEngine(
          this.gpuCanvas,
          acquisition.device,
          FluidGridSpec.forResolution(this.model.gridResolutionProperty.value),
          () => {
            this.reasonProperty.value = "noDevice";
          },
        );
      } catch {
        // The engine's constructor reports through onFailure() before it
        // throws, so the learner already has the "not available" message and
        // reasonProperty is already set. Catching keeps the throw from
        // escaping as an unhandled promise rejection, which is noise rather
        // than information.
      }
    });
  }

  /** Snapshot of the model, converted into the units the shaders expect. */
  private stepValues(): Parameters<WebGPUFluidEngine["step"]>[1] {
    const model = this.model;
    const centre = model.obstacleCenterProperty.value;
    const pointer = this.pointerPosition;

    return {
      dyeColorA: toColorTuple(FluidDynamicsColors.dyeColorAProperty.value),
      dyeColorB: toColorTuple(FluidDynamicsColors.dyeColorBProperty.value),
      obstacleCenterX: centre.x,
      obstacleCenterY: centre.y,
      pointerX: pointer === null ? 0 : pointer.x,
      pointerY: pointer === null ? 0 : pointer.y,
      pointerDeltaX: this.pointerDelta.x,
      pointerDeltaY: this.pointerDelta.y,
      viscosity: model.kinematicViscosityProperty.value,
      vorticity: model.vorticityProperty.value,
      dyeDissipation: model.dyeDissipationProperty.value,
      inflowSpeed: model.flowSpeedProperty.value,
      obstacleRadius: model.obstacleRadius,
      obstacleShape: obstacleShapeCode(model.obstacleShapeProperty.value),
      obstacleAngle: model.obstacleAngle,
      obstacleFocalRadius: model.obstacleFocalRadiusProperty.value,
      airfoilThickness: model.airfoilThicknessProperty.value,
      visualization: visualizationModeCode(model.visualizationModeProperty.value),
      tracersVisible: model.tracersVisibleProperty.value,
      pointerActive: pointer !== null && !this.pointerDelta.equals(Vector2.ZERO),
      pointerRadius: POINTER_RADIUS_M,
      // The colour ramps saturate at a small multiple of the inflow speed, so
      // they stay informative across the whole speed slider instead of washing
      // out at the top or reading as black at the bottom.
      velocityScale: Math.max(model.flowSpeedProperty.value * VELOCITY_SCALE_FACTOR, MIN_VELOCITY_SCALE),
      time: this.elapsedTime,
      pressureIterations: model.pressureIterationsProperty.value,
    };
  }

  /**
   * Dragging in the field pushes the fluid and paints dye, the classic Stable
   * Fluids interaction. Positions are converted to model metres so the impulse
   * is independent of how large the field is drawn.
   */
  private addPointerForcing(): void {
    const listener = new DragListener({
      targetNode: this,
      drag: (event) => {
        const viewPoint = this.globalToLocalPoint(event.pointer.point);
        const modelPoint = this.modelViewTransform.viewToModelPosition(viewPoint);
        if (this.pointerPosition !== null) {
          this.pointerDelta = modelPoint.minus(this.pointerPosition);
        }
        this.pointerPosition = modelPoint;
      },
      end: () => {
        this.pointerPosition = null;
        this.pointerDelta = Vector2.ZERO;
      },
    });
    this.addInputListener(listener);
    this.disposers.push(() => {
      this.removeInputListener(listener);
      listener.dispose();
    });
  }
}

/** A themed color as the [r, g, b, a] tuple in 0..1 that the shaders expect. */
function toColorTuple(color: Color): [number, number, number, number] {
  return [color.red / 255, color.green / 255, color.blue / 255, color.alpha];
}
