/**
 * FluidFieldKeyboard.ts
 *
 * Keyboard stirring for the fluid field — the keyboard path for the pointer drag
 * that pushes the fluid and paints dye — and the single source of truth for its
 * keys, read both by FluidFieldNode's listeners and by the keyboard-help dialog
 * (see ObstacleHandleKeyboard.ts for why bindings are HotkeyData).
 *
 * The field is one focus stop with a visible stirring ring. Each arrow press moves
 * the ring one step and is treated exactly like a pointer drag over that distance:
 * the solver pushes the fluid along the stroke and paints dye under the ring.
 * Space or Enter paints dye at the ring without pushing.
 */

import { Bounds2, Vector2 } from "scenerystack/dot";
import { HotkeyData, KeyboardListener } from "scenerystack/scenery";
import { CHANNEL_HEIGHT_M, CHANNEL_WIDTH_M } from "../../FluidDynamicsConstants.js";
import { StringManager } from "../../i18n/StringManager.js";

/** The repo these bindings belong to, for `binder` documentation output. */
const REPO_NAME = "fluid-dynamics";

const keyboardHelp = StringManager.getInstance().getKeyboardHelpStrings();

/** The channel in model metres; the stirring ring never leaves it. */
const CHANNEL_BOUNDS = new Bounds2(0, 0, CHANNEL_WIDTH_M, CHANNEL_HEIGHT_M);

export const FIELD_HOTKEY_DATA = {
  stir: new HotkeyData({
    keys: ["arrowUp", "arrowDown", "arrowLeft", "arrowRight"],
    keyboardHelpDialogLabelStringProperty: keyboardHelp.stirStringProperty,
    repoName: REPO_NAME,
  }),

  stirGently: new HotkeyData({
    keys: ["shift+arrowUp", "shift+arrowDown", "shift+arrowLeft", "shift+arrowRight"],
    keyboardHelpDialogLabelStringProperty: keyboardHelp.stirGentlyStringProperty,
    repoName: REPO_NAME,
  }),

  releaseDye: new HotkeyData({
    keys: ["space", "enter"],
    keyboardHelpDialogLabelStringProperty: keyboardHelp.releaseDyeStringProperty,
    repoName: REPO_NAME,
  }),
} as const;

/**
 * Where one stirring step from `position` lands: `direction` (a unit vector in
 * model space, y up) times `step` metres, kept inside the channel.
 */
export function stirStroke(position: Vector2, direction: Vector2, step: number): Vector2 {
  return CHANNEL_BOUNDS.closestPointTo(position.plus(direction.timesScalar(step)));
}

/** Unit directions for the four arrow keys, in model space (y up). */
export const STIR_DIRECTIONS = {
  up: new Vector2(0, 1),
  down: new Vector2(0, -1),
  left: new Vector2(-1, 0),
  right: new Vector2(1, 0),
} as const;

/**
 * The Space/Enter listener. `releaseDye` runs on the press and again on every
 * hold repeat, so a held key keeps painting; `announce` runs once per physical
 * press, so a screen reader hears "dye released" once rather than per repeat.
 *
 * The caller owns the returned listener: add it with `addInputListener` and
 * dispose it (after `removeInputListener`) when the node goes away.
 */
export function createReleaseDyeListener(
  releaseDye: () => void,
  announce: () => void,
): KeyboardListener<["space", "enter"]> {
  return new KeyboardListener({
    keys: ["space", "enter"],
    fireOnHold: true,
    press: () => announce(),
    fire: () => releaseDye(),
  });
}
