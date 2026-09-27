/**
 * IntroScreen.ts
 *
 * The top-level Screen component. It wires together the model and view
 * factories and passes screen-level options (name, background color, tandem)
 * to the parent Screen class.
 *
 * Registered in the screens array in src/main.ts. Its home-screen and navigation-bar
 * icons come from createIntroIcon() in src/common/FluidDynamicsScreenIcons.ts
 * (see SceneryStackTemplate doc/multi-screen.md).
 */
import { type EmptySelfOptions, optionize } from "scenerystack/phet-core";
import type { ScreenOptions } from "scenerystack/sim";
import { Screen } from "scenerystack/sim";
import type { Tandem } from "scenerystack/tandem";
import { createIntroIcon } from "../common/FluidDynamicsScreenIcons.js";
import FluidDynamicsColors from "../FluidDynamicsColors.js";
import type { FluidDynamicsPreferencesModel } from "../preferences/FluidDynamicsPreferencesModel.js";
import { IntroModel } from "./model/IntroModel.js";
import { IntroKeyboardHelpContent } from "./view/IntroKeyboardHelpContent.js";
import { IntroScreenView } from "./view/IntroScreenView.js";

// Require tandem to be explicit — accidental omission would break PhET-iO.
type IntroScreenOptions = ScreenOptions & { tandem: Tandem };

export class IntroScreen extends Screen<IntroModel, IntroScreenView> {
  public constructor(preferences: FluidDynamicsPreferencesModel, options: IntroScreenOptions) {
    super(
      // Model factory — called once when the screen is first shown
      () => new IntroModel(preferences),
      // View factory — receives the model instance
      (model) =>
        new IntroScreenView(model, {
          tandem: options.tandem.createTandem("view"),
        }),
      optionize<IntroScreenOptions, EmptySelfOptions, ScreenOptions>()(
        {
          backgroundColorProperty: FluidDynamicsColors.backgroundColorProperty,
          createKeyboardHelpNode: () => new IntroKeyboardHelpContent(),
          homeScreenIcon: createIntroIcon(),
          navigationBarIcon: createIntroIcon(),
        },
        options,
      ),
    );
  }
}
