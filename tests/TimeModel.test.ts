/**
 * TimeModel.test.ts
 *
 * Sample unit test shipped with the template so new sims are testable by default.
 * Exercises the composable play/pause + elapsed-time model in src/common/TimeModel.ts.
 * Delete or replace these when building a real sim — but keep at least one test so the
 * fleet-wide CI "test" step has something to run.
 */

import { TimeSpeed } from "scenerystack/scenery-phet";
import { describe, expect, it } from "vitest";
import { TimeModel } from "../src/common/TimeModel.js";
import { TIME_SPEED_MULTIPLIERS } from "../src/FluidDynamicsConstants.js";

const speed = (timeSpeed: TimeSpeed): number => TIME_SPEED_MULTIPLIERS.get(timeSpeed) ?? 1;
const fluidTimer = (): TimeModel =>
  new TimeModel({ initiallyPlaying: true, timeSpeedMultipliers: TIME_SPEED_MULTIPLIERS });

describe("TimeModel", () => {
  it("starts paused at time 0 by default", () => {
    const model = new TimeModel();
    expect(model.isPlayingProperty.value).toBe(false);
    expect(model.timeProperty.value).toBe(0);
    model.dispose();
  });

  it("can start playing when constructed with initiallyPlaying", () => {
    const model = new TimeModel({ initiallyPlaying: true });
    expect(model.isPlayingProperty.value).toBe(true);
    model.dispose();
  });

  it("does not advance time while paused", () => {
    const model = new TimeModel();
    model.step(1);
    expect(model.timeProperty.value).toBe(0);
    model.dispose();
  });

  it("accumulates time while playing", () => {
    const model = new TimeModel({ initiallyPlaying: true });
    model.step(0.5);
    model.step(0.25);
    expect(model.timeProperty.value).toBeCloseTo(0.75);
    model.dispose();
  });

  it("reset() restores the initial playback state and clears time", () => {
    const model = new TimeModel();
    model.isPlayingProperty.value = true;
    model.step(2);
    model.reset();
    expect(model.isPlayingProperty.value).toBe(false);
    expect(model.timeProperty.value).toBe(0);
    model.dispose();
  });

  it("defaults to Normal speed, which advances time one-to-one", () => {
    const model = new TimeModel({ initiallyPlaying: true });
    expect(model.timeSpeedProperty.value).toBe(TimeSpeed.NORMAL);
    model.step(1);
    expect(model.timeProperty.value).toBe(1);
    model.dispose();
  });

  it("scales elapsed time by the playback speed while playing", () => {
    const model = fluidTimer();

    model.timeSpeedProperty.value = TimeSpeed.SLOW;
    model.step(1);
    expect(model.timeProperty.value).toBeCloseTo(speed(TimeSpeed.SLOW));

    model.timeSpeedProperty.value = TimeSpeed.FAST;
    model.step(1);
    expect(model.timeProperty.value).toBeCloseTo(speed(TimeSpeed.SLOW) + speed(TimeSpeed.FAST));

    model.dispose();
  });

  it("does not advance while paused, at any speed", () => {
    const model = new TimeModel({ timeSpeedMultipliers: TIME_SPEED_MULTIPLIERS });
    model.timeSpeedProperty.value = TimeSpeed.FAST;
    model.step(1);
    expect(model.timeProperty.value).toBe(0);
    model.dispose();
  });

  it("reset() restores Normal speed", () => {
    const model = fluidTimer();
    model.timeSpeedProperty.value = TimeSpeed.SLOW;
    model.reset();
    expect(model.timeSpeedProperty.value).toBe(TimeSpeed.NORMAL);
    model.dispose();
  });
});
