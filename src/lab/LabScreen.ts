/**
 * LabScreen.ts
 *
 * The top-level Screen component. It wires together the model and view
 * factories and passes screen-level options (name, background color, tandem)
 * to the parent Screen class.
 *
 * Registered in the screens array in src/main.ts. Its home-screen and navigation-bar
 * icons come from createLabIcon() in src/common/FluidDynamicsScreenIcons.ts
 * (see SceneryStackTemplate doc/multi-screen.md).
 */
import { type EmptySelfOptions, optionize } from "scenerystack/phet-core";
import type { ScreenOptions } from "scenerystack/sim";
import { Screen } from "scenerystack/sim";
import type { Tandem } from "scenerystack/tandem";
import { createLabIcon } from "../common/FluidDynamicsScreenIcons.js";
import FluidDynamicsColors from "../FluidDynamicsColors.js";
import type { FluidDynamicsPreferencesModel } from "../preferences/FluidDynamicsPreferencesModel.js";
import { LabModel } from "./model/LabModel.js";
import { LabKeyboardHelpContent } from "./view/LabKeyboardHelpContent.js";
import { LabScreenView } from "./view/LabScreenView.js";

// Require tandem to be explicit — accidental omission would break PhET-iO.
type LabScreenOptions = ScreenOptions & { tandem: Tandem };

export class LabScreen extends Screen<LabModel, LabScreenView> {
  public constructor(preferences: FluidDynamicsPreferencesModel, options: LabScreenOptions) {
    super(
      // Model factory — called once when the screen is first shown
      () => new LabModel(preferences),
      // View factory — receives the model instance
      (model) =>
        new LabScreenView(model, {
          tandem: options.tandem.createTandem("view"),
        }),
      optionize<LabScreenOptions, EmptySelfOptions, ScreenOptions>()(
        {
          backgroundColorProperty: FluidDynamicsColors.backgroundColorProperty,
          createKeyboardHelpNode: () => new LabKeyboardHelpContent(),
          homeScreenIcon: createLabIcon(),
          navigationBarIcon: createLabIcon(),
        },
        options,
      ),
    );
  }
}
