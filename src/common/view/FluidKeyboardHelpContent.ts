/**
 * FluidKeyboardHelpContent.ts
 *
 * Content for the keyboard-help dialog (the "?" button in the navigation bar),
 * shared by both screens.
 *
 * Which sections appear is an option rather than a subclass, mirroring
 * FluidControlPanel: the two screens run the same interactions and differ only
 * in how many of them are exposed. The Intro screen has one slider and no combo
 * box, and its obstacle is a cylinder — which has no chord to tilt, no foci to
 * pull and no thickness — so it documents resizing alone.
 *
 * ── Where the rows come from ──────────────────────────────────────────────────
 * The stirring and obstacle rows are built with KeyboardHelpSectionRow.fromHotkeyData
 * from the same HotkeyData the field's and handles' listeners are built from (see
 * FluidFieldKeyboard.ts and ObstacleHandleKeyboard.ts). The keys shown here are therefore the keys the sim
 * actually responds to, by construction — the icons are generated from the key
 * strings rather than drawn by hand.
 *
 * The remaining sections are the standard scenery-phet ones. They already
 * describe the sliders, combo boxes, draggable tools and time controls in the
 * fleet's shared vocabulary, so there is nothing sim-specific to say about them.
 */

import {
  BasicActionsKeyboardHelpSection,
  ComboBoxKeyboardHelpSection,
  KeyboardHelpIconFactory,
  KeyboardHelpSection,
  KeyboardHelpSectionRow,
  MoveDraggableItemsKeyboardHelpSection,
  SliderControlsKeyboardHelpSection,
  TimeControlsKeyboardHelpSection,
  TwoColumnKeyboardHelpContent,
} from "scenerystack/scenery-phet";
import { StringManager } from "../../i18n/StringManager.js";
import { FIELD_HOTKEY_DATA } from "./FluidFieldKeyboard.js";
import { HANDLE_HOTKEY_DATA } from "./ObstacleHandleKeyboard.js";

type SelfOptions = {
  /**
   * Document the shaping handles the Lab screen adds: tilting the body, pulling
   * the ellipse's foci, and thickening the airfoil. The Intro screen's cylinder
   * responds to none of them.
   */
  readonly showShapingControls: boolean;

  /** Document the combo boxes, which only the Lab screen has. */
  readonly showComboBoxControls: boolean;
};

export class FluidKeyboardHelpContent extends TwoColumnKeyboardHelpContent {
  public constructor(providedOptions: SelfOptions) {
    const strings = StringManager.getInstance().getKeyboardHelpStrings();

    // Resizing is on both screens; the rest belongs to the shapes only the Lab
    // screen offers. "Adjust in smaller steps" comes last because it modifies
    // every row above it rather than being an interaction of its own.
    const obstacleRows = [
      KeyboardHelpSectionRow.fromHotkeyData(HANDLE_HOTKEY_DATA.resize),
      ...(providedOptions.showShapingControls
        ? [
            KeyboardHelpSectionRow.fromHotkeyData(HANDLE_HOTKEY_DATA.tilt),
            KeyboardHelpSectionRow.fromHotkeyData(HANDLE_HOTKEY_DATA.stretchEllipse),
            KeyboardHelpSectionRow.fromHotkeyData(HANDLE_HOTKEY_DATA.rotateEllipse),
            KeyboardHelpSectionRow.fromHotkeyData(HANDLE_HOTKEY_DATA.airfoilThickness),
          ]
        : []),
      // Icon overridden: the generated one spells out all four shifted arrows
      // as "Shift+▲ or Shift+▼ or Shift+◀ or Shift+▶", which wraps to two lines
      // and buries the one thing the row says — hold Shift. One Shift and the
      // arrow cluster says it in a quarter of the width.
      KeyboardHelpSectionRow.fromHotkeyData(HANDLE_HOTKEY_DATA.smallerSteps, {
        icon: KeyboardHelpIconFactory.shiftPlusIcon(KeyboardHelpIconFactory.arrowKeysRowIcon()),
      }),
    ];

    const obstacleSection = new KeyboardHelpSection(strings.obstacleHeadingStringProperty, obstacleRows);

    // Stirring is the field's own focus stop, on both screens. The gentle row gets
    // the same compact Shift + arrows icon as "smaller steps" above, for the same reason.
    const fieldSection = new KeyboardHelpSection(strings.fieldHeadingStringProperty, [
      KeyboardHelpSectionRow.fromHotkeyData(FIELD_HOTKEY_DATA.stir, {
        icon: KeyboardHelpIconFactory.arrowKeysRowIcon(),
      }),
      KeyboardHelpSectionRow.fromHotkeyData(FIELD_HOTKEY_DATA.stirGently, {
        icon: KeyboardHelpIconFactory.shiftPlusIcon(KeyboardHelpIconFactory.arrowKeysRowIcon()),
      }),
      KeyboardHelpSectionRow.fromHotkeyData(FIELD_HOTKEY_DATA.releaseDye, {
        icon: KeyboardHelpIconFactory.spaceOrEnter(),
      }),
    ]);

    // Covers the obstacle's own translation handle and both measurement tools —
    // all three are KeyboardDragListeners with the same arrow/shift behaviour.
    const moveSection = new MoveDraggableItemsKeyboardHelpSection({
      headingStringProperty: strings.moveHeadingStringProperty,
    });

    const sliderSection = new SliderControlsKeyboardHelpSection();

    // The toolbox icons are buttons, so Enter and Space reach them — but what
    // those keys *do* there (take a tool out, or put it back) is not something
    // the generic "press buttons" row conveys.
    const toolboxSection = new KeyboardHelpSection(strings.toolboxHeadingStringProperty, [
      KeyboardHelpSectionRow.labelWithIcon(strings.toolTakeOutStringProperty, KeyboardHelpIconFactory.spaceOrEnter()),
    ]);

    const leftColumn = [fieldSection, obstacleSection, moveSection, toolboxSection];
    const rightColumn = [
      sliderSection,
      ...(providedOptions.showComboBoxControls ? [new ComboBoxKeyboardHelpSection()] : []),
      new TimeControlsKeyboardHelpSection(),
      new BasicActionsKeyboardHelpSection({ withCheckboxContent: true }),
    ];

    super(leftColumn, rightColumn);
  }
}
