/**
 * ObstacleFociHandleNode.ts
 *
 * The ellipse's two focal points, each a draggable knob.
 *
 * The model stores the ellipse exactly as the foci define it: the focal
 * half-separation c (0 collapses the body to a disk — both knobs then sit on
 * the centre, and pulling either one outward is what stretches the disk into
 * an ellipse) and the angle of attack, which is the direction of the line
 * through the foci, i.e. the major axis. The two knobs mirror each other,
 * because an ellipse's foci are always symmetric about its centre.
 *
 * Shown on the Lab screen only, while the shape is the ellipse.
 */

import { Multilink, type NumberProperty } from "scenerystack/axon";
import { toFixed, Vector2, type Vector2Property } from "scenerystack/dot";
import { type ModelViewTransform2, StringUtils } from "scenerystack/phetcommon";
import { type Circle, DragListener, Node } from "scenerystack/scenery";
import {
  ANGLE_KEYBOARD_STEP_DEG,
  FOCAL_KEYBOARD_STEP_M,
  OBSTACLE_FOCAL_MAX_FRACTION,
} from "../../FluidDynamicsConstants.js";
import { StringManager } from "../../i18n/StringManager.js";
import { maxFocalRadius, wrapAngleOfAttackDeg } from "../model/ObstacleGeometry.js";
import { createArrowKeyListener, keyboardStep } from "./ObstacleHandleKeyboard.js";
import { createKnobDot, createKnobHitArea } from "./ObstacleHandleKnob.js";

export class ObstacleFociHandleNode extends Node {
  private readonly disposeObstacleFociHandleNode: () => void;

  public constructor(
    centerProperty: Vector2Property,
    diameterProperty: NumberProperty,
    focalRadiusProperty: NumberProperty,
    angleOfAttackProperty: NumberProperty,
    modelViewTransform: ModelViewTransform2,
  ) {
    super();

    const a11y = StringManager.getInstance().getFluidA11yStrings();
    // Both knobs write the same two properties and share one listener body,
    // differing only in where the pointer happens to be — but they must not
    // share an accessible name, or a screen-reader user tabbing through hears
    // the same words twice with no way to tell which focus they are on. The
    // help text is genuinely the same for both, so that one is shared.
    const upstreamKnob = createKnobHitArea(
      a11y.upstreamFocusHandleStringProperty,
      a11y.focusHandleHelpTextStringProperty,
    );
    const downstreamKnob = createKnobHitArea(
      a11y.downstreamFocusHandleStringProperty,
      a11y.focusHandleHelpTextStringProperty,
    );
    upstreamKnob.addChild(createKnobDot());
    downstreamKnob.addChild(createKnobDot());
    this.addChild(upstreamKnob);
    this.addChild(downstreamKnob);

    const positionListener = Multilink.multilink(
      [centerProperty, focalRadiusProperty, angleOfAttackProperty],
      (centre, focalRadius, angleDeg) => {
        const alpha = (angleDeg * Math.PI) / 180;
        const modelOffset = new Vector2(-focalRadius * Math.cos(alpha), focalRadius * Math.sin(alpha));
        const centreView = modelViewTransform.modelToViewPosition(centre);
        const deltaView = modelViewTransform.modelToViewDelta(modelOffset);
        upstreamKnob.center = centreView.plus(deltaView);
        downstreamKnob.center = centreView.minus(deltaView);
      },
    );

    const applyDrag = (globalPoint: Vector2): void => {
      const modelPoint = modelViewTransform.viewToModelPosition(this.globalToLocalPoint(globalPoint));
      const offset = modelPoint.minus(centerProperty.value);

      focalRadiusProperty.value = Math.min(
        Math.max(offset.magnitude, 0),
        maxFocalRadius(diameterProperty.value, OBSTACLE_FOCAL_MAX_FRACTION),
      );

      const pointerAngleDeg = (Math.atan2(offset.y, offset.x) * 180) / Math.PI;
      angleOfAttackProperty.value = wrapAngleOfAttackDeg(180 - pointerAngleDeg);
    };

    // Pointer-only: the arrow keys already move the foci through createArrowKeyListener
    // (ObstacleHandleKeyboard HotkeyData). A RichDragListener would bind them twice.
    const upstreamDragListener = new DragListener({
      targetNode: upstreamKnob,
      drag: (event) => {
        applyDrag(event.pointer.point);
      },
    });
    const downstreamDragListener = new DragListener({
      targetNode: downstreamKnob,
      drag: (event) => {
        applyDrag(event.pointer.point);
      },
    });
    upstreamKnob.addInputListener(upstreamDragListener);
    downstreamKnob.addInputListener(downstreamDragListener);

    // Both knobs move the foci the same way: ↑/↓ pulls them apart or together,
    // ←/→ swings the major axis around.
    const applyKeys = (focalDelta: number, angleDelta: number): void => {
      focalRadiusProperty.value = Math.min(
        Math.max(focalRadiusProperty.value + focalDelta, 0),
        maxFocalRadius(diameterProperty.value, OBSTACLE_FOCAL_MAX_FRACTION),
      );
      angleOfAttackProperty.value = wrapAngleOfAttackDeg(angleOfAttackProperty.value + angleDelta);
    };

    const focalStep = (fine: boolean) => keyboardStep(FOCAL_KEYBOARD_STEP_M, fine);
    const angleStep = (fine: boolean) => keyboardStep(ANGLE_KEYBOARD_STEP_DEG, fine);

    // As on the other knobs: the ellipse is painted by the display shader, so
    // an arrow press is silent to a screen reader unless it is announced. The
    // response goes to whichever knob has focus.
    const announceFocal = (knob: Circle): void => {
      knob.addAccessibleResponse(
        StringUtils.fillIn(a11y.focalResponsePatternStringProperty.value, {
          value: toFixed(focalRadiusProperty.value, 2),
        }),
      );
    };
    const announceAngle = (knob: Circle): void => {
      knob.addAccessibleResponse(
        StringUtils.fillIn(a11y.angleResponsePatternStringProperty.value, {
          value: toFixed(angleOfAttackProperty.value, 0),
        }),
      );
    };

    // One set of actions, bound to whichever knob is reporting them.
    const keyActionsFor = (knob: Circle) => ({
      up: (fine: boolean) => {
        applyKeys(focalStep(fine), 0);
        announceFocal(knob);
      },
      down: (fine: boolean) => {
        applyKeys(-focalStep(fine), 0);
        announceFocal(knob);
      },
      left: (fine: boolean) => {
        applyKeys(0, angleStep(fine));
        announceAngle(knob);
      },
      right: (fine: boolean) => {
        applyKeys(0, -angleStep(fine));
        announceAngle(knob);
      },
    });

    const upstreamKeyListener = createArrowKeyListener(keyActionsFor(upstreamKnob));
    const downstreamKeyListener = createArrowKeyListener(keyActionsFor(downstreamKnob));
    upstreamKnob.addInputListener(upstreamKeyListener);
    downstreamKnob.addInputListener(downstreamKeyListener);

    this.disposeObstacleFociHandleNode = () => {
      upstreamKnob.removeInputListener(upstreamKeyListener);
      downstreamKnob.removeInputListener(downstreamKeyListener);
      upstreamKeyListener.dispose();
      downstreamKeyListener.dispose();
      upstreamKnob.removeInputListener(upstreamDragListener);
      downstreamKnob.removeInputListener(downstreamDragListener);
      upstreamDragListener.dispose();
      downstreamDragListener.dispose();
      positionListener.dispose();
    };
  }

  public override dispose(): void {
    this.disposeObstacleFociHandleNode();
    super.dispose();
  }
}
