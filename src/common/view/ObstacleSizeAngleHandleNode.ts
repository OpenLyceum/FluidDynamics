/**
 * ObstacleSizeAngleHandleNode.ts
 *
 * The knob on the obstacle's leading edge, which sizes and tilts the body in
 * one gesture: the knob's polar coordinates around the body's centre *are*
 * the model's size and angle properties.
 *
 *   dragging it outward            → larger body   (diameter = 2 × radius)
 *   dragging it around the centre  → tilted body   (angle of attack)
 *   ↑/↓                            → size, ←/→     → angle (Shift = finer)
 *
 * For the disk the tilt is inert — a circle has no nose — so on the Intro
 * screen the same knob is purely the radius handle. The angle is still
 * written there: the model allows it and the shader ignores it, and keeping
 * one interaction for every shape is simpler than special cases.
 *
 * Like ObstacleHandleNode, this node draws no part of the body itself; it is
 * a knob (see ObstacleHandleKnob) positioned where the display shader draws
 * the leading edge.
 */

import { Multilink, type NumberProperty } from "scenerystack/axon";
import { toFixed, Vector2, type Vector2Property } from "scenerystack/dot";
import type { ModelViewTransform2 } from "scenerystack/phetcommon";
import { StringUtils } from "scenerystack/phetcommon";
import { DragListener, Node } from "scenerystack/scenery";
import {
  ANGLE_KEYBOARD_STEP_DEG,
  OBSTACLE_DIAMETER_RANGE,
  SIZE_KEYBOARD_STEP_M,
} from "../../FluidDynamicsConstants.js";
import { StringManager } from "../../i18n/StringManager.js";
import { wrapAngleOfAttackDeg } from "../model/ObstacleGeometry.js";
import { createArrowKeyListener, keyboardStep } from "./ObstacleHandleKeyboard.js";
import { createKnobDot, createKnobHitArea } from "./ObstacleHandleKnob.js";

export class ObstacleSizeAngleHandleNode extends Node {
  private readonly disposeObstacleSizeAngleHandleNode: () => void;

  public constructor(
    centerProperty: Vector2Property,
    diameterProperty: NumberProperty,
    angleOfAttackProperty: NumberProperty,
    modelViewTransform: ModelViewTransform2,
  ) {
    super();

    const a11y = StringManager.getInstance().getFluidA11yStrings();
    const knob = createKnobHitArea(a11y.sizeAngleHandleStringProperty, a11y.sizeAngleHandleHelpTextStringProperty);
    knob.addChild(createKnobDot());
    this.addChild(knob);

    // The leading edge, in the frame the shader's toChordFrame expects: at
    // angle of attack α it sits at world angle 180° − α from the body's
    // centre, i.e. on the side tilted up into the flow.
    const positionListener = Multilink.multilink(
      [centerProperty, diameterProperty, angleOfAttackProperty],
      (centre, diameter, angleDeg) => {
        const alpha = (angleDeg * Math.PI) / 180;
        const modelOffset = new Vector2((-diameter / 2) * Math.cos(alpha), (diameter / 2) * Math.sin(alpha));
        knob.center = modelViewTransform
          .modelToViewPosition(centre)
          .plus(modelViewTransform.modelToViewDelta(modelOffset));
      },
    );

    const applyPolar = (globalPoint: Vector2): void => {
      // This node sits at the ScreenView's origin, so its local frame is the
      // frame modelViewTransform maps from — same contract as FluidFieldNode.
      const modelPoint = modelViewTransform.viewToModelPosition(this.globalToLocalPoint(globalPoint));
      const offset = modelPoint.minus(centerProperty.value);
      const distance = offset.magnitude;

      diameterProperty.value = OBSTACLE_DIAMETER_RANGE.constrainValue(2 * distance);

      const pointerAngleDeg = (Math.atan2(offset.y, offset.x) * 180) / Math.PI;
      angleOfAttackProperty.value = wrapAngleOfAttackDeg(180 - pointerAngleDeg);
    };

    // Pointer-only: the arrow keys already change size and angle through createArrowKeyListener
    // (ObstacleHandleKeyboard HotkeyData). A RichDragListener would bind them twice.
    const dragListener = new DragListener({
      targetNode: knob,
      drag: (event) => {
        applyPolar(event.pointer.point);
      },
    });
    knob.addInputListener(dragListener);

    // A knob change is invisible to a screen reader: the body it resizes is
    // painted by the display shader, and the field's live paragraph is on the
    // field node, not here, so nothing is announced while focus is on the knob.
    // Each arrow press therefore reports the value it just produced.
    const announceSize = (): void => {
      knob.addAccessibleResponse(
        StringUtils.fillIn(a11y.sizeResponsePatternStringProperty.value, {
          value: toFixed(diameterProperty.value, 2),
        }),
      );
    };
    const announceAngle = (): void => {
      knob.addAccessibleResponse(
        StringUtils.fillIn(a11y.angleResponsePatternStringProperty.value, {
          value: toFixed(angleOfAttackProperty.value, 0),
        }),
      );
    };

    const keyListener = createArrowKeyListener({
      up: (fine) => {
        diameterProperty.value = OBSTACLE_DIAMETER_RANGE.constrainValue(
          diameterProperty.value + keyboardStep(SIZE_KEYBOARD_STEP_M, fine),
        );
        announceSize();
      },
      down: (fine) => {
        diameterProperty.value = OBSTACLE_DIAMETER_RANGE.constrainValue(
          diameterProperty.value - keyboardStep(SIZE_KEYBOARD_STEP_M, fine),
        );
        announceSize();
      },
      left: (fine) => {
        angleOfAttackProperty.value = wrapAngleOfAttackDeg(
          angleOfAttackProperty.value + keyboardStep(ANGLE_KEYBOARD_STEP_DEG, fine),
        );
        announceAngle();
      },
      right: (fine) => {
        angleOfAttackProperty.value = wrapAngleOfAttackDeg(
          angleOfAttackProperty.value - keyboardStep(ANGLE_KEYBOARD_STEP_DEG, fine),
        );
        announceAngle();
      },
    });
    knob.addInputListener(keyListener);

    this.disposeObstacleSizeAngleHandleNode = () => {
      knob.removeInputListener(keyListener);
      keyListener.dispose();
      knob.removeInputListener(dragListener);
      dragListener.dispose();
      positionListener.dispose();
    };
  }

  public override dispose(): void {
    this.disposeObstacleSizeAngleHandleNode();
    super.dispose();
  }
}
