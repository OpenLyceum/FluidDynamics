/** Startup failure handling with just the WebGPU APIs reached before a failed allocation. */

import { describe, expect, it, vi } from "vitest";
import { FluidGridSpec } from "../src/common/gpu/FluidGridSpec.js";
import { WebGPUFluidEngine } from "../src/common/gpu/WebGPUFluidEngine.js";

describe("WebGPU fluid engine startup", () => {
  it("returns unavailable before touching the device when the canvas has no context", () => {
    const canvas = document.createElement("canvas");
    const getContext = vi.fn(() => null);
    Object.defineProperty(canvas, "getContext", { value: getContext });

    const device = new EventTarget();
    const addEventListener = vi.spyOn(device, "addEventListener");
    const onFailure = vi.fn();
    const creation = WebGPUFluidEngine.create(
      canvas,
      device as GPUDevice,
      FluidGridSpec.forResolution("standard"),
      onFailure,
    );

    expect(getContext).toHaveBeenCalledWith("webgpu");
    expect(creation).toEqual({ available: false, reason: "noDevice" });
    expect(addEventListener).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("releases allocated resources and preserves the error when startup fails partway", () => {
    const canvas = document.createElement("canvas");
    const configure = vi.fn();
    const unconfigure = vi.fn();
    Object.defineProperty(canvas, "getContext", { value: () => ({ configure, unconfigure }) });
    vi.stubGlobal("navigator", { gpu: { getPreferredCanvasFormat: () => "rgba8unorm" } });
    vi.stubGlobal("GPUTextureUsage", {
      RENDER_ATTACHMENT: 16,
      STORAGE_BINDING: 8,
      TEXTURE_BINDING: 4,
      COPY_DST: 2,
      COPY_SRC: 1,
    });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, COPY_DST: 8 });
    vi.stubGlobal("GPUShaderStage", { COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 });

    const initializationError = new Error("second velocity texture unavailable");
    const cleanupError = new Error("display texture cleanup failed");
    const destroyUniform = vi.fn();
    const destroyDisplay = vi.fn(() => {
      throw cleanupError;
    });
    const destroyVelocity = vi.fn();
    const device = new EventTarget();
    const addEventListener = vi.spyOn(device, "addEventListener");
    const removeEventListener = vi.spyOn(device, "removeEventListener");
    Object.assign(device, {
      createBuffer: () => ({ destroy: destroyUniform }),
      createSampler: () => ({}),
      createBindGroupLayout: () => ({}),
      createShaderModule: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}),
      createRenderPipeline: () => ({}),
      createTexture: ({ label }: GPUTextureDescriptor) => {
        if (label === "velocity1") {
          throw initializationError;
        }
        return { destroy: label === "display-target" ? destroyDisplay : destroyVelocity, createView: () => ({}) };
      },
    });
    const onFailure = vi.fn();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // This device double only implements methods called before the injected failure.
    const creation = WebGPUFluidEngine.create(
      canvas,
      device as GPUDevice,
      FluidGridSpec.forResolution("standard"),
      onFailure,
    );

    expect(creation).toEqual({ available: false, reason: "noDevice" });
    expect(configure).toHaveBeenCalledTimes(1);
    expect(destroyUniform).toHaveBeenCalledTimes(1);
    expect(destroyDisplay).toHaveBeenCalledTimes(1);
    expect(destroyVelocity).toHaveBeenCalledTimes(1);
    expect(unconfigure).toHaveBeenCalledTimes(1);
    expect(removeEventListener.mock.calls).toEqual(addEventListener.mock.calls);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith("WebGPU cleanup failed after fluid solver initialization", cleanupError);
    expect(diagnostic).toHaveBeenCalledWith("WebGPU initialization failed in the fluid solver", initializationError);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
