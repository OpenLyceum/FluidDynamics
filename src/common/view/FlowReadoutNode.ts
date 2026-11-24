/**
 * FlowReadoutNode.ts
 *
 * The Reynolds number and the regime it puts the flow in.
 *
 * This is the sim's thesis in one line. The learner moves a slider that changes
 * a speed or a viscosity; what actually decides whether the wake is smooth or
 * sheds vortices is the single dimensionless combination of speed, size and
 * viscosity — so that combination is shown next to the flow it produces, and
 * named.
 *
 * The regime label doubles as the accessible description of the field, which is
 * the only way a screen-reader user learns what the dye is doing.
 */

import { DerivedProperty, type TReadOnlyProperty } from "scenerystack/axon";
import { roundSymmetric, toFixed } from "scenerystack/dot";
import { type EmptySelfOptions, optionize } from "scenerystack/phet-core";
import { StringUtils } from "scenerystack/phetcommon";
import { HBox, type HBoxOptions, Text } from "scenerystack/scenery";
import { PhetFont } from "scenerystack/scenery-phet";
import FluidDynamicsColors from "../../FluidDynamicsColors.js";
import { READOUT_FONT_SIZE } from "../../FluidDynamicsConstants.js";
import { StringManager } from "../../i18n/StringManager.js";
import type { FlowRegime } from "../model/FlowRegime.js";
import type { FluidModel } from "../model/FluidModel.js";

export type FlowReadoutNodeOptions = HBoxOptions;

export class FlowReadoutNode extends HBox {
  private readonly disposeFlowReadoutNode: () => void;

  public constructor(model: FluidModel, providedOptions?: FlowReadoutNodeOptions) {
    const strings = StringManager.getInstance().getFluidStrings();

    const reynoldsStringProperty = new DerivedProperty(
      [model.reynoldsNumberProperty, strings.controls.reynoldsPatternStringProperty],
      (reynolds, pattern) => StringUtils.fillIn(pattern, { value: formatReynolds(reynolds) }),
    );

    const regimeStringProperty = createRegimeStringProperty(model.flowRegimeProperty);

    const reynoldsText = new Text(reynoldsStringProperty, {
      font: new PhetFont({ size: READOUT_FONT_SIZE, weight: "bold" }),
      fill: FluidDynamicsColors.textColorProperty,
    });
    const regimeText = new Text(regimeStringProperty, {
      font: new PhetFont(READOUT_FONT_SIZE),
      fill: FluidDynamicsColors.accentColorProperty,
    });

    const options = optionize<FlowReadoutNodeOptions, EmptySelfOptions, HBoxOptions>()(
      { children: [reynoldsText, regimeText], spacing: 16, align: "center" },
      providedOptions,
    );
    super(options);

    this.disposeFlowReadoutNode = () => {
      regimeText.dispose();
      reynoldsText.dispose();
      regimeStringProperty.dispose();
      reynoldsStringProperty.dispose();
    };
  }

  public override dispose(): void {
    this.disposeFlowReadoutNode();
    super.dispose();
  }
}

/**
 * The localized name of the current regime.
 */
function createRegimeStringProperty(flowRegimeProperty: TReadOnlyProperty<FlowRegime>): TReadOnlyProperty<string> {
  const regimes = StringManager.getInstance().getFluidStrings().regimes;

  // Written out rather than looked up by key, so a new regime fails to compile
  // until it has a label.
  const labels: Record<FlowRegime, TReadOnlyProperty<string>> = {
    creeping: regimes.creepingStringProperty,
    steadyWake: regimes.steadyWakeStringProperty,
    vortexShedding: regimes.vortexSheddingStringProperty,
    turbulent: regimes.turbulentStringProperty,
  };

  return DerivedProperty.deriveAny(
    [
      flowRegimeProperty,
      regimes.creepingStringProperty,
      regimes.steadyWakeStringProperty,
      regimes.vortexSheddingStringProperty,
      regimes.turbulentStringProperty,
    ],
    () => labels[flowRegimeProperty.value].value,
  );
}

/**
 * Formats a Reynolds number for display.
 *
 * Reynolds numbers here span four orders of magnitude, so a fixed number of
 * decimals is wrong at one end or the other: below 10 the interesting digit is
 * after the point, and above 100 no digit after the point means anything.
 */
export function formatReynolds(reynolds: number): string {
  if (!Number.isFinite(reynolds)) {
    return "∞";
  }
  if (reynolds < 10) {
    return toFixed(reynolds, 1);
  }
  if (reynolds < 1000) {
    return roundSymmetric(reynolds).toString();
  }
  // Round to two significant figures, so 4237 reads as 4200 rather than
  // implying a precision the model does not have.
  const magnitude = 10 ** (Math.floor(Math.log10(reynolds)) - 1);
  return (roundSymmetric(reynolds / magnitude) * magnitude).toString();
}
