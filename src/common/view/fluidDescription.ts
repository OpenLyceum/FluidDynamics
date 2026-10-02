/**
 * fluidDescription.ts
 *
 * A live, localized sentence describing what the flow is currently doing.
 *
 * A screen-reader user cannot see the dye, so this is the whole simulation for
 * them: what the fluid is flowing past, how fast, and — the part that matters —
 * which regime the Reynolds number puts the wake in. It is used both as the
 * fluid field's accessible description and as the screen summaries' live
 * "current details" paragraph, so the two never disagree.
 */

import { DerivedProperty, type TReadOnlyProperty } from "scenerystack/axon";
import { toFixed } from "scenerystack/dot";
import { StringUtils } from "scenerystack/phetcommon";
import { StringManager } from "../../i18n/StringManager.js";
import type { FlowRegime } from "../model/FlowRegime.js";
import type { FluidModel } from "../model/FluidModel.js";
import type { ObstacleShape } from "../model/ObstacleShape.js";
import { formatReynolds } from "./FlowReadoutNode.js";

/**
 * Builds the description Property.
 *
 * Disposal matters more here than the usual view Property: this listens to the
 * *global* localized string Properties as well as the model's, so an undisposed
 * one is reachable from a page-lifetime singleton and keeps the model alive
 * behind it. The screen views construct it and hand it to FluidScreenView, which
 * owns it from that point and disposes it with the rest of the screen — they
 * have no dispose() of their own to do it in.
 */
export function createFluidDescriptionProperty(model: FluidModel): TReadOnlyProperty<string> {
  const a11y = StringManager.getInstance().getFluidA11yStrings();

  // Whole phrases per shape and per regime, rather than a label slotted into an
  // English sentence: each language needs its own article and gender ("past an
  // airfoil", "autour d'une ellipse"), and "None" is a channel with no obstacle.
  // Written out rather than looked up by key, so a new shape or regime fails to
  // compile until it can be described.
  const obstaclePhrases: Record<ObstacleShape, TReadOnlyProperty<string>> = {
    none: a11y.obstaclePhrases.noneStringProperty,
    cylinder: a11y.obstaclePhrases.cylinderStringProperty,
    plate: a11y.obstaclePhrases.plateStringProperty,
    airfoil: a11y.obstaclePhrases.airfoilStringProperty,
    ellipse: a11y.obstaclePhrases.ellipseStringProperty,
  };
  const wakePhrases: Record<FlowRegime, TReadOnlyProperty<string>> = {
    creeping: a11y.wakePhrases.creepingStringProperty,
    steadyWake: a11y.wakePhrases.steadyWakeStringProperty,
    vortexShedding: a11y.wakePhrases.vortexSheddingStringProperty,
    turbulent: a11y.wakePhrases.turbulentStringProperty,
  };

  return DerivedProperty.deriveAny(
    [
      model.obstacleShapeProperty,
      model.flowSpeedProperty,
      model.reynoldsNumberProperty,
      model.flowRegimeProperty,
      a11y.fieldDescriptionPatternStringProperty,
      ...Object.values(obstaclePhrases),
      ...Object.values(wakePhrases),
    ],
    () =>
      StringUtils.fillIn(a11y.fieldDescriptionPatternStringProperty.value, {
        obstacle: obstaclePhrases[model.obstacleShapeProperty.value].value,
        speed: toFixed(model.flowSpeedProperty.value, 2),
        reynolds: formatReynolds(model.reynoldsNumberProperty.value),
        wake: wakePhrases[model.flowRegimeProperty.value].value,
      }),
  );
}
