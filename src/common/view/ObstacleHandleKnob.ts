/**
 * ObstacleHandleKnob.ts
 *
 * The visible grip shared by the obstacle's handles.
 *
 * The body is drawn by the display shader (see ObstacleHandleNode for why
 * Scenery never draws it), so a handle can only mark itself: a small dot with
 * a dark rim so it reads on both the dark body and the bright dye field. The
 * dot is deliberately tiny — it sits on the body's outline and must not cover
 * flow the learner is looking at — so the hit area is an invisible larger
 * circle around it, which is also the focusable node carrying the keyboard
 * interaction.
 *
 * That hit circle is as large as it can be without the knobs colliding: the
 * foci sit on top of each other at zero eccentricity, and the thickness knob
 * rides close to the leading edge on a slim airfoil. Touch needs more than
 * that, so the touch area is dilated past the visible geometry instead — a
 * finger gets a comfortable target without the mouse gaining one that overlaps
 * its neighbour.
 */

import type { TReadOnlyProperty } from "scenerystack/axon";
import { Circle } from "scenerystack/scenery";
import FluidDynamicsColors from "../../FluidDynamicsColors.js";
import { KNOB_DOT_RADIUS_PX, KNOB_HIT_RADIUS_PX, KNOB_TOUCH_DILATION_PX } from "../../FluidDynamicsConstants.js";

/**
 * The invisible hit/focus circle. The caller adds its input listeners here,
 * then the visible dot as a child. Accessibility names are supplied here
 * because every handle knob answers to a different description.
 */
export function createKnobHitArea(
  accessibleName: TReadOnlyProperty<string>,
  accessibleHelpText: TReadOnlyProperty<string>,
): Circle {
  const knob = new Circle(KNOB_HIT_RADIUS_PX, {
    // Transparent rather than invisible: an invisible Node is removed from the
    // parallel DOM and can be neither focused nor hit-tested.
    fill: FluidDynamicsColors.hitAreaColorProperty,
    cursor: "pointer",
    tagName: "div",
    focusable: true,
    accessibleName,
    accessibleHelpText,
  });
  knob.touchArea = knob.localBounds.dilated(KNOB_TOUCH_DILATION_PX);
  return knob;
}

/** The visible dot, centered in its hit area. */
export function createKnobDot(): Circle {
  return new Circle(KNOB_DOT_RADIUS_PX, {
    fill: FluidDynamicsColors.accentColorProperty,
    stroke: FluidDynamicsColors.handleKnobStrokeColorProperty,
    lineWidth: 2,
    pickable: false,
  });
}
