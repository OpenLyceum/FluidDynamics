/**
 * FluidScreenView.ts
 *
 * Layout and wiring shared by both screens.
 *
 * The Intro and Lab screens run the same solver over the same model and differ
 * only in how many of its parameters they expose, so the arrangement — field on
 * the left, readout beneath it, controls in a column on the right, time controls
 * and Reset All along the bottom — is defined once here. Each screen supplies
 * its own screen-summary content and sets `showFullControls`.
 *
 * ── Stepping ──────────────────────────────────────────────────────────────────
 * step() advances the GPU solver and nothing else. joist already steps the
 * active screen's model, so calling model.step() here would run the clock twice
 * as fast.
 */

import { Multilink, type TReadOnlyProperty } from "scenerystack/axon";
import { optionize } from "scenerystack/phet-core";
import { Node } from "scenerystack/scenery";
import { ResetAllButton, TimeControlNode } from "scenerystack/scenery-phet";
import { ScreenView, type ScreenViewOptions } from "scenerystack/sim";
import {
  CONTROL_PANEL_WIDTH,
  FIELD_VIEW_BOUNDS,
  SCREEN_VIEW_MARGIN,
  STEP_FORWARD_DT,
} from "../../FluidDynamicsConstants.js";
import {
  FLAT_BUTTON_APPEARANCE_OPTIONS,
  FLAT_PLAY_PAUSE_STEP_BUTTON_OPTIONS,
  FLAT_RESET_ALL_BUTTON_OPTIONS,
  TIME_CONTROL_SPEED_RADIO_OPTIONS,
} from "../FluidDynamicsButtonOptions.js";
import type { GpuUnavailableReason } from "../gpu/webgpuSupport.js";
import type { FluidModel } from "../model/FluidModel.js";
import type { ObstacleShape } from "../model/ObstacleShape.js";
import { TIME_SPEEDS, type TimeModel } from "../TimeModel.js";
import { FlowReadoutNode } from "./FlowReadoutNode.js";
import { FluidControlPanel } from "./FluidControlPanel.js";
import { FluidFieldNode } from "./FluidFieldNode.js";
import { FluidScaleBarNode } from "./FluidScaleBarNode.js";
import { ObstacleFociHandleNode } from "./ObstacleFociHandleNode.js";
import { ObstacleHandleNode } from "./ObstacleHandleNode.js";
import { ObstacleSizeAngleHandleNode } from "./ObstacleSizeAngleHandleNode.js";
import { ObstacleThicknessHandleNode } from "./ObstacleThicknessHandleNode.js";
import { ToolboxPanel } from "./ToolboxPanel.js";
import { WebGPUUnavailableNode } from "./WebGPUUnavailableNode.js";

type SelfOptions = {
  /** Show viscosity, obstacle, visualization and grid controls (the Lab screen). */
  readonly showFullControls?: boolean;
};

export type FluidScreenViewOptions = SelfOptions & ScreenViewOptions;

export class FluidScreenView extends ScreenView {
  /** Live description of the flow, shared with the screen summary. */
  public readonly fluidDescriptionProperty: TReadOnlyProperty<string>;

  private readonly fluidFieldNode: FluidFieldNode;
  private readonly disposers: (() => void)[] = [];

  public constructor(
    model: FluidModel,
    timer: TimeModel,
    fluidDescriptionProperty: TReadOnlyProperty<string>,
    providedOptions: FluidScreenViewOptions,
  ) {
    const options = optionize<FluidScreenViewOptions, SelfOptions, ScreenViewOptions>()(
      { showFullControls: false },
      providedOptions,
    );
    super(options);

    this.fluidDescriptionProperty = fluidDescriptionProperty;

    // ── Fluid field ───────────────────────────────────────────────────────────
    // The solver needs a GPUDevice, which arrives asynchronously. Until it does,
    // the field paints nothing and the unavailable message stays hidden, so a
    // successful start never flashes an error.
    this.fluidFieldNode = new FluidFieldNode(
      model,
      timer.isPlayingProperty,
      timer.timeSpeedProperty,
      FIELD_VIEW_BOUNDS,
      {
        accessibleParagraph: fluidDescriptionProperty,
      },
    );
    this.addChild(this.fluidFieldNode);

    // Above the field, so a press on the body moves it instead of stirring
    // the fluid. Both screens: moving the body is the point of the obstacle.
    const obstacleHandle = new ObstacleHandleNode(
      model.obstacleCenterProperty,
      model.obstacleDiameterProperty,
      this.fluidFieldNode.modelViewTransform,
    );
    this.addChild(obstacleHandle);

    // The shaping handles, above the translation handle so their knobs win the
    // hit test where they overlap it. Every shape offers the leading-edge
    // knob; the foci and thickness knobs belong to one shape each and spend
    // the rest of their time hidden.
    const sizeAngleHandle = new ObstacleSizeAngleHandleNode(
      model.obstacleCenterProperty,
      model.obstacleDiameterProperty,
      model.angleOfAttackProperty,
      this.fluidFieldNode.modelViewTransform,
    );
    const fociHandle = new ObstacleFociHandleNode(
      model.obstacleCenterProperty,
      model.obstacleDiameterProperty,
      model.obstacleFocalRadiusProperty,
      model.angleOfAttackProperty,
      this.fluidFieldNode.modelViewTransform,
    );
    const thicknessHandle = new ObstacleThicknessHandleNode(
      model.obstacleCenterProperty,
      model.obstacleDiameterProperty,
      model.airfoilThicknessProperty,
      model.angleOfAttackProperty,
      this.fluidFieldNode.modelViewTransform,
    );
    this.addChild(sizeAngleHandle);
    this.addChild(fociHandle);
    this.addChild(thicknessHandle);

    // Linked only now that the handles are in the scene graph: a node that is
    // already invisible when it is added never populates its pdomDisplays, and
    // its parallel-DOM content stays hidden for good (the tools below rely on
    // the same ordering).
    //
    // Also gated on the field being renderable at all. Without a device there is
    // no body on screen to grab, so a visible handle is a control over nothing —
    // and worse for a keyboard user, who would tab through four of them and hear
    // four names for an obstacle that is not there.
    const gpuReasonProperty = this.fluidFieldNode.gpuUnavailableReasonProperty;
    const shapeListener = (shape: ObstacleShape, reason: GpuUnavailableReason | null): void => {
      const hasField = reason === null;
      const wanted: readonly [Node, boolean][] = [
        [obstacleHandle, hasField && shape !== "none"],
        [sizeAngleHandle, hasField && shape !== "none"],
        [fociHandle, hasField && shape === "ellipse"],
        [thicknessHandle, hasField && shape === "airfoil"],
      ];
      for (const [handle, visible] of wanted) {
        // Hiding also interrupts, as it does for the tools below: the device can
        // be lost, or the shape changed by a combo box, with a finger still down
        // on a knob — and a drag that outlives its node goes on writing values
        // no one can see until the finger lifts.
        if (!visible) {
          handle.interruptSubtreeInput();
        }
        handle.visible = visible;
      }
    };
    const shapeMultilink = Multilink.multilink([model.obstacleShapeProperty, gpuReasonProperty], shapeListener);

    this.addChild(new WebGPUUnavailableNode(gpuReasonProperty, FIELD_VIEW_BOUNDS));

    // ── Reynolds number and regime ────────────────────────────────────────────
    const readout = new FlowReadoutNode(model, {
      left: FIELD_VIEW_BOUNDS.minX,
      top: FIELD_VIEW_BOUNDS.maxY + 14,
    });
    this.addChild(readout);

    // The fixed reference for the channel's size, anchoring the other end of
    // the readout row. Not pickable, so it never intercepts a stray drag.
    const scaleBar = new FluidScaleBarNode(this.fluidFieldNode.modelViewTransform, {
      right: FIELD_VIEW_BOUNDS.maxX,
      top: FIELD_VIEW_BOUNDS.maxY + 14,
    });
    this.addChild(scaleBar);

    // ── Controls ──────────────────────────────────────────────────────────────
    // The combo-box list has to be drawn above everything else, so it lives in a
    // dedicated parent added last.
    const comboBoxListParent = new Node();

    const controlPanel = new FluidControlPanel(model, comboBoxListParent, {
      showFullControls: options.showFullControls,
      minWidth: CONTROL_PANEL_WIDTH,
      right: this.layoutBounds.maxX - SCREEN_VIEW_MARGIN,
      top: FIELD_VIEW_BOUNDS.minY,
    });
    this.addChild(controlPanel);

    const timeControl = new TimeControlNode(timer.isPlayingProperty, {
      timeSpeedProperty: timer.timeSpeedProperty,
      timeSpeeds: TIME_SPEEDS,
      ...TIME_CONTROL_SPEED_RADIO_OPTIONS,
      playPauseStepButtonOptions: {
        ...FLAT_PLAY_PAUSE_STEP_BUTTON_OPTIONS,
        // The flat appearance has to be re-spread here: naming
        // stepForwardButtonOptions replaces the whole object the spread above
        // supplied, so a bare { listener } would leave this one button beveled
        // among its flat neighbours.
        stepForwardButtonOptions: {
          ...FLAT_BUTTON_APPEARANCE_OPTIONS,
          listener: () => {
            // The clock is advanced explicitly rather than through
            // timer.step(), which ignores dt while paused — and paused is the
            // only state this button is reachable in. Without this the sim
            // clock and the solver would drift apart by one frame per press.
            timer.stepOnce(STEP_FORWARD_DT);
            this.fluidFieldNode.stepOnce(STEP_FORWARD_DT);
          },
        },
      },
      centerX: FIELD_VIEW_BOUNDS.centerX,
      bottom: this.layoutBounds.maxY - SCREEN_VIEW_MARGIN,
    });
    this.addChild(timeControl);

    const resetAllButton = new ResetAllButton({
      ...FLAT_RESET_ALL_BUTTON_OPTIONS,
      listener: () => {
        model.reset();
        timer.reset();
        this.reset();
      },
      right: this.layoutBounds.maxX - SCREEN_VIEW_MARGIN,
      bottom: this.layoutBounds.maxY - SCREEN_VIEW_MARGIN,
    });
    this.addChild(resetAllButton);

    // ── Measurement tools ────────────────────────────────────────────────────
    // The toolbox is a panel like any other; the tools it owns are not its
    // children but siblings added here, so a ruler dragged across the control
    // panel floats above it rather than sliding underneath.
    const toolboxPanel = new ToolboxPanel(model, {
      modelViewTransform: this.fluidFieldNode.modelViewTransform,
      screenViewBounds: this.layoutBounds,
      globalToViewPoint: (globalPoint) => this.globalToLocalPoint(globalPoint),
      left: FIELD_VIEW_BOUNDS.minX,
      bottom: this.layoutBounds.maxY - SCREEN_VIEW_MARGIN,
    });
    this.addChild(toolboxPanel);
    this.addChild(toolboxPanel.measuringTapeNode);
    this.addChild(toolboxPanel.rulerNode);

    // Linked only now that the tools are in the scene graph: a node that is
    // already invisible when it is added never populates its pdomDisplays, and
    // its parallel-DOM content stays hidden for good. The links fire
    // immediately (tools start in the toolbox), hiding through the same path
    // every later show retraces.
    // Hiding a tool also interrupts any drag of it. Reset All can empty the
    // toolbox with a finger still on a tool, and a drag that outlives its node
    // goes on writing positions no one can see until the finger lifts.
    const tapeVisibleListener = (visible: boolean): void => {
      if (!visible) {
        toolboxPanel.measuringTapeNode.interruptSubtreeInput();
      }
      toolboxPanel.measuringTapeNode.visible = visible;
    };
    model.measuringTapeVisibleProperty.link(tapeVisibleListener);
    const rulerVisibleListener = (visible: boolean): void => {
      if (!visible) {
        toolboxPanel.rulerNode.interruptSubtreeInput();
      }
      toolboxPanel.rulerNode.visible = visible;
    };
    model.rulerVisibleProperty.link(rulerVisibleListener);

    this.addChild(comboBoxListParent);

    // ── Keyboard / reading traversal order ────────────────────────────────────
    // Explicit and independent of z-order: the field first (it is the thing the
    // screen is about), then the obstacle, then the toolbox and any tools out
    // of it, then the controls top to bottom, with the time controls and Reset
    // All last.
    this.addChild(
      new Node({
        pdomOrder: [
          this.fluidFieldNode,
          obstacleHandle,
          sizeAngleHandle,
          fociHandle,
          thicknessHandle,
          toolboxPanel.tapeIconNode,
          toolboxPanel.rulerIconNode,
          toolboxPanel.measuringTapeNode,
          toolboxPanel.rulerNode,
          ...controlPanel.controlsInOrder,
          timeControl,
          resetAllButton,
        ],
      }),
    );

    this.disposers.push(() => {
      shapeMultilink.dispose();
      model.rulerVisibleProperty.unlink(rulerVisibleListener);
      model.measuringTapeVisibleProperty.unlink(tapeVisibleListener);
      toolboxPanel.dispose();
      controlPanel.dispose();
      scaleBar.dispose();
      readout.dispose();
      thicknessHandle.dispose();
      fociHandle.dispose();
      sizeAngleHandle.dispose();
      obstacleHandle.dispose();
      this.fluidFieldNode.dispose();
      // Created by the subclass and handed down, but owned here: it is a
      // DerivedProperty over the model *and* the global localized strings, so
      // leaving it alive keeps the model reachable from a page-lifetime
      // singleton. The subclasses have no dispose() of their own to do it in.
      fluidDescriptionProperty.dispose();
    });
  }

  /** Resets view-side state. The model is reset by the caller. */
  public reset(): void {
    this.fluidFieldNode.reset();
  }

  /**
   * Advances the GPU solver. Deliberately does not step the model: joist already
   * does that for the active screen.
   */
  public override step(dt: number): void {
    this.fluidFieldNode.update(dt);
  }

  /**
   * Releases the subscriptions the screen created.
   *
   * Does not call super.dispose(): joist's ScreenView is intentionally
   * non-disposable, and its setPDOMOrder override throws during ParallelDOM
   * teardown. The subscription surface is what fuzz and unit tests need
   * released; the ScreenView shell itself lives as long as the sim.
   */
  public override dispose(): void {
    for (const disposer of this.disposers.splice(0)) {
      disposer();
    }
  }
}
