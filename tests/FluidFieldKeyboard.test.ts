/**
 * FluidFieldKeyboard.test.ts
 *
 * The keyboard stirring stroke: one arrow press moves the stirring ring one step
 * in model space (y up) and never leaves the channel, and the help dialog's
 * bindings are the keys the listeners use.
 */

import { Vector2 } from "scenerystack/dot";
import { describe, expect, it } from "vitest";
import { FIELD_HOTKEY_DATA, STIR_DIRECTIONS, stirStroke } from "../src/common/view/FluidFieldKeyboard.js";
import { keyboardStep } from "../src/common/view/ObstacleHandleKeyboard.js";
import {
  CHANNEL_HEIGHT_M,
  CHANNEL_WIDTH_M,
  HANDLE_KEYBOARD_STEP_FACTOR,
  KEYBOARD_STIR_START,
  KEYBOARD_STIR_STEP_M,
} from "../src/FluidDynamicsConstants.js";

describe("stirStroke", () => {
  it("moves one step in the pressed direction, with model y up", () => {
    const start = new Vector2(1, 0.5);
    expect(stirStroke(start, STIR_DIRECTIONS.right, 0.1).equalsEpsilon(new Vector2(1.1, 0.5), 1e-12)).toBe(true);
    expect(stirStroke(start, STIR_DIRECTIONS.up, 0.1).equalsEpsilon(new Vector2(1, 0.6), 1e-12)).toBe(true);
  });

  it("stays inside the channel at every edge", () => {
    expect(stirStroke(new Vector2(0.01, 0.5), STIR_DIRECTIONS.left, 0.1).x).toBe(0);
    expect(stirStroke(new Vector2(CHANNEL_WIDTH_M, 0.5), STIR_DIRECTIONS.right, 0.1).x).toBe(CHANNEL_WIDTH_M);
    expect(stirStroke(new Vector2(1, CHANNEL_HEIGHT_M - 0.01), STIR_DIRECTIONS.up, 0.1).y).toBe(CHANNEL_HEIGHT_M);
    expect(stirStroke(new Vector2(1, 0), STIR_DIRECTIONS.down, 0.1).y).toBe(0);
  });

  it("Shift makes a gentler stroke, by the shared handle factor", () => {
    expect(keyboardStep(KEYBOARD_STIR_STEP_M, true)).toBeCloseTo(KEYBOARD_STIR_STEP_M / HANDLE_KEYBOARD_STEP_FACTOR);
  });

  it("starts inside the channel", () => {
    expect(KEYBOARD_STIR_START.x).toBeGreaterThan(0);
    expect(KEYBOARD_STIR_START.x).toBeLessThan(CHANNEL_WIDTH_M);
    expect(KEYBOARD_STIR_START.y).toBeGreaterThan(0);
    expect(KEYBOARD_STIR_START.y).toBeLessThan(CHANNEL_HEIGHT_M);
  });
});

const keysOf = (data: { keyStringProperties: { value: string }[] }): string[] =>
  data.keyStringProperties.map((property) => property.value);

describe("FIELD_HOTKEY_DATA", () => {
  it("documents the arrows, shifted arrows, and Space/Enter", () => {
    expect(keysOf(FIELD_HOTKEY_DATA.stir)).toEqual(["arrowUp", "arrowDown", "arrowLeft", "arrowRight"]);
    expect(keysOf(FIELD_HOTKEY_DATA.stirGently)).toEqual([
      "shift+arrowUp",
      "shift+arrowDown",
      "shift+arrowLeft",
      "shift+arrowRight",
    ]);
    expect(keysOf(FIELD_HOTKEY_DATA.releaseDye)).toEqual(["space", "enter"]);
  });
});
