/**
 * main.ts
 *
 * Entry point for the simulation. Initializes SceneryStack, creates the
 * screens, and starts the main event loop.
 *
 * !! CRITICAL IMPORT ORDER !!
 * brand.js MUST be the first import. Each module imports the next, so the import nesting is
 *
 *   main → brand → splash → assert → init
 *
 * and therefore the actual EXECUTION order (deepest import runs first) is the reverse:
 *
 *   init → assert → splash → brand → main
 *
 * SceneryStack requires this exact load order. Never reorder these imports.
 */

// brand.js MUST be first; importing it runs the whole chain (init→assert→splash→brand) before main.
import "./brand.js";

import { onReadyToLaunch, PreferencesModel, Sim } from "scenerystack/sim";
import { Tandem } from "scenerystack/tandem";
import FluidDynamicsColors from "./FluidDynamicsColors.js";
import { StringManager } from "./i18n/StringManager.js";
import { IntroScreen } from "./intro/IntroScreen.js";
import { LabScreen } from "./lab/LabScreen.js";
import { FluidDynamicsPreferencesModel } from "./preferences/FluidDynamicsPreferencesModel.js";
import { FluidDynamicsPreferencesNode } from "./preferences/FluidDynamicsPreferencesNode.js";

onReadyToLaunch(() => {
  const stringManager = StringManager.getInstance();

  // Simulation-specific preferences; initial values come from fluidDynamicsQueryParameters.
  const simPreferences = new FluidDynamicsPreferencesModel(Tandem.ROOT.createTandem("preferences"));

  const screens = [
    new IntroScreen(simPreferences, {
      // The screen name Property updates automatically when the locale changes
      name: stringManager.getScreenNames().introStringProperty,
      tandem: Tandem.ROOT.createTandem("introScreen"),
      backgroundColorProperty: FluidDynamicsColors.backgroundColorProperty,
    }),
    new LabScreen(simPreferences, {
      // The screen name Property updates automatically when the locale changes
      name: stringManager.getScreenNames().labStringProperty,
      tandem: Tandem.ROOT.createTandem("labScreen"),
      backgroundColorProperty: FluidDynamicsColors.backgroundColorProperty,
    }),
  ];

  const sim = new Sim(stringManager.getTitleStringProperty(), screens, {
    preferencesModel: new PreferencesModel({
      visualOptions: {
        // Adds a "Projector Mode" toggle in Preferences → Visual
        supportsProjectorMode: true,
        // Enables keyboard-navigation highlight outlines
        supportsInteractiveHighlights: true,
      },
      simulationOptions: {
        customPreferences: [
          {
            createContent: (tandem: Tandem) => new FluidDynamicsPreferencesNode(simPreferences, tandem),
          },
        ],
      },
      localizationOptions: {
        // Adds a language picker in Preferences → Language
        supportsDynamicLocale: true,
      },
    }),

    // No `credits`: joist skips each field it finds empty, so the four blank
    // strings this used to carry were dead config. Attribution and the papers
    // the solver implements live in CREDITS.md; add a `credits` object here if
    // and when there are names to put in it.
  });

  sim.start();
});
