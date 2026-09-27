/**
 * Fleet-standard memory-leak regression suite (SceneryStackTemplate / QubitSketch pattern).
 *
 * Creates a disposable model object inside a function boundary, disposes it, forces
 * garbage collection via global.gc (--expose-gc in vitest.config.ts), then asserts via
 * WeakRef that the object was collected. V8 requires a function boundary (not merely
 * a block scope) so local strong references die when the helper returns.
 */

import { describe, expect, it } from "vitest";
import { FluidModel } from "../src/common/model/FluidModel.js";
import { TimeModel } from "../src/common/TimeModel.js";
import { IntroModel } from "../src/intro/model/IntroModel.js";
import { FluidDynamicsPreferencesModel } from "../src/preferences/FluidDynamicsPreferencesModel.js";
import { describeDisposalLeaks, forceGC } from "./helpers/memoryLeak.js";

function createAndDisposeTimeModel(): WeakRef<object> {
  const model = new TimeModel();
  const ref = new WeakRef<object>(model);
  model.dispose();
  return ref;
}

/**
 * FluidModel is the interesting case: its two DerivedProperties listen to three
 * source Properties, so a missed dispose() would pin the whole model.
 * The Properties are exercised first so the derivations actually fire.
 */
function createAndDisposeFluidModel(): WeakRef<object> {
  const model = new FluidModel();
  const ref = new WeakRef<object>(model);

  model.flowSpeedProperty.value = 1.5;
  model.kinematicViscosityProperty.value = 5e-3;
  model.obstacleDiameterProperty.value = 0.25;
  model.obstacleShapeProperty.value = "plate";
  model.angleOfAttackProperty.value = 20;
  model.visualizationModeProperty.value = "vorticity";
  expect(model.flowRegimeProperty.value).toBeDefined();

  model.dispose();
  return ref;
}

function createAndDisposeIntroModel(): WeakRef<object> {
  // The screen model links to a preferences Property, so a leak here would also
  // pin the preferences model — worth exercising rather than stubbing out.
  const model = new IntroModel(new FluidDynamicsPreferencesModel());
  const ref = new WeakRef<object>(model);

  model.step(1 / 60);
  model.fluid.flowSpeedProperty.value = 2;
  model.reset();

  model.dispose();
  return ref;
}

describe("Memory leak regression", () => {
  it("TimeModel is collected after dispose", async () => {
    const ref = createAndDisposeTimeModel();
    await forceGC(ref);
    expect(ref.deref()).toBeUndefined();
  });

  it("FluidModel is collected after dispose", async () => {
    const ref = createAndDisposeFluidModel();
    await forceGC(ref);
    expect(ref.deref()).toBeUndefined();
  });

  it("IntroModel is collected after dispose", async () => {
    const ref = createAndDisposeIntroModel();
    await forceGC(ref);
    expect(ref.deref()).toBeUndefined();
  });

  it("double dispose() does not throw", () => {
    const model = new TimeModel();
    model.dispose();
    expect(() => model.dispose()).not.toThrow();
  });

  it("double dispose() of FluidModel does not throw", () => {
    const model = new FluidModel();
    model.dispose();
    expect(() => model.dispose()).not.toThrow();
  });

  it("repeated create/dispose cycles leave no survivors", async () => {
    const refs: WeakRef<object>[] = [];
    for (let i = 0; i < 10; i++) {
      refs.push(createAndDisposeTimeModel());
      refs.push(createAndDisposeFluidModel());
    }
    await forceGC(refs);
    const survivors = refs.filter((r) => r.deref() !== undefined).length;
    expect(survivors).toBe(0);
  });
});

describeDisposalLeaks([
  { name: "TimeModel", create: () => new TimeModel(), idempotentDispose: true },
  { name: "FluidModel", create: () => new FluidModel() },
]);
