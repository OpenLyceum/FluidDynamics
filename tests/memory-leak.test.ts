/**
 * Fleet-standard memory-leak regression suite (SceneryStackTemplate / QubitSketch pattern).
 *
 * Creates a disposable model object inside a function boundary, disposes it, forces
 * garbage collection via global.gc (--expose-gc in vitest.config.ts), then asserts via
 * WeakRef that the object was collected. V8 requires a function boundary (not merely
 * a block scope) so local strong references die when the helper returns.
 */

import { NumberProperty, Property } from "scenerystack/axon";
import { Bounds2, Vector2, Vector2Property } from "scenerystack/dot";
import { ModelViewTransform2 } from "scenerystack/phetcommon";
import { Node } from "scenerystack/scenery";
import { describe, expect, it } from "vitest";
import type { GpuUnavailableReason } from "../src/common/gpu/webgpuSupport.js";
import { FluidModel } from "../src/common/model/FluidModel.js";
import { TimeModel } from "../src/common/TimeModel.js";
import { FlowReadoutNode } from "../src/common/view/FlowReadoutNode.js";
import { FluidControlPanel } from "../src/common/view/FluidControlPanel.js";
import { FluidRulerNode } from "../src/common/view/FluidRulerNode.js";
import { FluidScaleBarNode } from "../src/common/view/FluidScaleBarNode.js";
import { ObstacleFociHandleNode } from "../src/common/view/ObstacleFociHandleNode.js";
import { ObstacleHandleNode } from "../src/common/view/ObstacleHandleNode.js";
import { ObstacleSizeAngleHandleNode } from "../src/common/view/ObstacleSizeAngleHandleNode.js";
import { ObstacleThicknessHandleNode } from "../src/common/view/ObstacleThicknessHandleNode.js";
import { WebGPUUnavailableNode } from "../src/common/view/WebGPUUnavailableNode.js";
import { IntroModel } from "../src/intro/model/IntroModel.js";
import { LabModel } from "../src/lab/model/LabModel.js";
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

// One preferences model shared by every LabModel, as in the sim: a LabModel that
// failed to unlink from it would stay reachable and fail the check.
const SHARED_PREFERENCES = new FluidDynamicsPreferencesModel();
const fluidForViews = new FluidModel();
const listParent = new Node();
const modelViewTransform = ModelViewTransform2.createSinglePointScaleInvertedYMapping(
  Vector2.ZERO,
  new Vector2(100, 100),
  200,
);
const obstacleCenterProperty = new Vector2Property(new Vector2(0.5, 0.25));
const obstacleDiameterProperty = new NumberProperty(0.2);
const obstacleFocalRadiusProperty = new NumberProperty(0.05);
const obstacleAngleProperty = new NumberProperty(0);
const obstacleThicknessProperty = new NumberProperty(0.05);
const rulerCenterProperty = new Vector2Property(new Vector2(0.3, 0.1));
const screenViewBounds = new Bounds2(0, 0, 768, 504);
const gpuReasonProperty = new Property<GpuUnavailableReason | null>("noWebGPU");
const fieldBounds = new Bounds2(0, 0, 350, 280);

describeDisposalLeaks([
  { name: "TimeModel", create: () => new TimeModel(), idempotentDispose: true },
  { name: "FluidModel", create: () => new FluidModel() },
  { name: "LabModel", create: () => new LabModel(SHARED_PREFERENCES) },
  {
    name: "FlowReadoutNode",
    create: () => new FlowReadoutNode(fluidForViews),
    keepAlive: () => [fluidForViews],
  },
  {
    name: "FluidControlPanel",
    create: () => new FluidControlPanel(fluidForViews, listParent),
    keepAlive: () => [fluidForViews, listParent],
  },
  {
    name: "FluidScaleBarNode",
    create: () => new FluidScaleBarNode(modelViewTransform),
    keepAlive: () => [modelViewTransform],
  },
  {
    name: "FluidRulerNode",
    create: () => new FluidRulerNode(rulerCenterProperty, modelViewTransform, screenViewBounds),
    keepAlive: () => [rulerCenterProperty, modelViewTransform],
  },
  {
    name: "ObstacleHandleNode",
    create: () => new ObstacleHandleNode(obstacleCenterProperty, obstacleDiameterProperty, modelViewTransform),
    keepAlive: () => [obstacleCenterProperty, obstacleDiameterProperty],
  },
  {
    name: "ObstacleFociHandleNode",
    create: () =>
      new ObstacleFociHandleNode(
        obstacleCenterProperty,
        obstacleDiameterProperty,
        obstacleFocalRadiusProperty,
        obstacleAngleProperty,
        modelViewTransform,
      ),
    keepAlive: () => [
      obstacleCenterProperty,
      obstacleDiameterProperty,
      obstacleFocalRadiusProperty,
      obstacleAngleProperty,
    ],
  },
  {
    name: "ObstacleSizeAngleHandleNode",
    create: () =>
      new ObstacleSizeAngleHandleNode(
        obstacleCenterProperty,
        obstacleDiameterProperty,
        obstacleAngleProperty,
        modelViewTransform,
      ),
    keepAlive: () => [obstacleCenterProperty, obstacleDiameterProperty, obstacleAngleProperty],
  },
  {
    name: "ObstacleThicknessHandleNode",
    create: () =>
      new ObstacleThicknessHandleNode(
        obstacleCenterProperty,
        obstacleDiameterProperty,
        obstacleThicknessProperty,
        obstacleAngleProperty,
        modelViewTransform,
      ),
    keepAlive: () => [
      obstacleCenterProperty,
      obstacleDiameterProperty,
      obstacleThicknessProperty,
      obstacleAngleProperty,
    ],
  },
  {
    name: "WebGPUUnavailableNode",
    create: () => new WebGPUUnavailableNode(gpuReasonProperty, fieldBounds),
    keepAlive: () => [gpuReasonProperty],
  },
]);
