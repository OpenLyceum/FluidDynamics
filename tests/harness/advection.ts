/** Isolates the production transport kernels from forcing and projection. */
import { FluidGridSpec } from "../../src/common/gpu/FluidGridSpec.js";
import { FluidUniforms, UNIFORM_BUFFER_SIZE } from "../../src/common/gpu/FluidUniforms.js";
import advectWGSL from "../../src/common/gpu/shaders/advect.wgsl?raw";
import commonWGSL from "../../src/common/gpu/shaders/common.wgsl?raw";
import { acquireFluidDevice } from "../../src/common/gpu/webgpuSupport.js";

export async function advectProfile(quantity: "dye" | "velocity", displacementCells: number): Promise<number[]> {
  const acquisition = await acquireFluidDevice();
  if (!acquisition.available) {
    throw new Error("transport test requires a WebGPU device");
  }
  const device = acquisition.device;
  const grid = FluidGridSpec.forResolution("standard");
  const resources: (GPUTexture | GPUBuffer)[] = [];
  const texture = (format: GPUTextureFormat = "rgba16float"): GPUTexture => {
    const result = device.createTexture({
      size: [grid.width, grid.height],
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
    });
    resources.push(result);
    return result;
  };
  const buffer = (size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
    const result = device.createBuffer({ size, usage });
    resources.push(result);
    return result;
  };

  device.pushErrorScope("validation");
  let result: number[] = [];
  let validationError: GPUError | null = null;
  try {
    const velocity = texture();
    const prior = quantity === "velocity" ? velocity : texture();
    const predictor = texture();
    const output = texture();
    const mask = texture("r32float");
    const v = new Uint16Array(grid.cellCount * 4);
    const p = new Uint16Array(v.length);
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const i = (y * grid.width + x) * 4;
        v[i] = encodeHalf(1);
        v[i + 1] = quantity === "velocity" ? encodeHalf(x / 512) : 0;
        v[i + 3] = encodeHalf(1);
        p[i] = encodeHalf(x / 512);
        p[i + 3] = encodeHalf(1);
      }
    }
    const extent: GPUExtent3D = [grid.width, grid.height];
    device.queue.writeTexture({ texture: velocity }, v, { bytesPerRow: grid.width * 8 }, extent);
    if (quantity === "dye") {
      device.queue.writeTexture({ texture: prior }, p, { bytesPerRow: grid.width * 8 }, extent);
    }
    device.queue.writeTexture(
      { texture: mask },
      new Float32Array(grid.cellCount).fill(1),
      { bytesPerRow: grid.width * 4 },
      extent,
    );

    const uniforms = buffer(UNIFORM_BUFFER_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const packed = new FluidUniforms().pack(
      {
        dyeColorA: [0, 0, 0, 1],
        dyeColorB: [0, 0, 0, 1],
        domainWidth: 2,
        domainHeight: 1,
        obstacleCenterX: 0,
        obstacleCenterY: 0,
        pointerX: 0,
        pointerY: 0,
        pointerDeltaX: 0,
        pointerDeltaY: 0,
        dt: displacementCells * grid.cellSize,
        viscosity: 0,
        vorticity: 0,
        dyeDissipation: 1,
        inflowSpeed: 1,
        obstacleRadius: 0,
        obstacleShape: 0,
        obstacleAngle: 0,
        obstacleFocalRadius: 0,
        airfoilThickness: 0,
        visualization: 0,
        pointerActive: false,
        pointerRadius: 0,
        velocityScale: 1,
        time: 0,
        tracerEmitBatch: -1,
      },
      grid,
    );
    device.queue.writeBuffer(uniforms, 0, packed);
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const visibility = GPUShaderStage.COMPUTE;
    const bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility, buffer: { type: "uniform" } },
        { binding: 1, visibility, sampler: { type: "filtering" } },
        { binding: 2, visibility, texture: { sampleType: "float" } },
        { binding: 3, visibility, texture: { sampleType: "float" } },
        { binding: 4, visibility, storageTexture: { access: "write-only", format: "rgba16float" } },
        { binding: 5, visibility, texture: { sampleType: "float" } },
        { binding: 6, visibility, texture: { sampleType: "unfilterable-float" } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
    const module = device.createShaderModule({ code: `${commonWGSL}\n${advectWGSL}` });
    const pipeline = (entryPoint: string): GPUComputePipeline =>
      device.createComputePipeline({ layout, compute: { module, entryPoint } });
    const group = (source: GPUTexture, target: GPUTexture): GPUBindGroup =>
      device.createBindGroup({
        layout: bindLayout,
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: velocity.createView() },
          { binding: 3, resource: source.createView() },
          { binding: 4, resource: target.createView() },
          { binding: 5, resource: prior.createView() },
          { binding: 6, resource: mask.createView() },
        ],
      });
    const suffix = quantity === "dye" ? "Dye" : "Velocity";
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline(`advect${suffix}`));
    pass.setBindGroup(0, group(prior, predictor));
    pass.dispatchWorkgroups(grid.dispatchX, grid.dispatchY);
    pass.setPipeline(pipeline(`advect${suffix}Correct`));
    pass.setBindGroup(0, group(predictor, output));
    pass.dispatchWorkgroups(grid.dispatchX, grid.dispatchY);
    pass.end();

    const readback = buffer(grid.width * 8, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    encoder.copyTextureToBuffer(
      { texture: output, origin: [0, grid.height / 2] },
      { buffer: readback, bytesPerRow: grid.width * 8 },
      [grid.width, 1],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const row = new Uint16Array(readback.getMappedRange().slice(0));
    readback.unmap();
    const channel = quantity === "dye" ? 0 : 1;
    result = [64, 96, 128, 160, 192].map((x) => decodeHalf(row[x * 4 + channel] ?? 0));
  } finally {
    validationError = await device.popErrorScope();
    for (const resource of resources) {
      resource.destroy();
    }
  }
  if (validationError !== null) {
    throw new Error(validationError.message);
  }
  return result;
}

/** The fixture contains only exactly representable, nonnegative normal halves. */
function encodeHalf(value: number): number {
  if (value === 0) {
    return 0;
  }
  const exponent = Math.floor(Math.log2(value));
  return ((exponent + 15) << 10) | Math.round((value / 2 ** exponent - 1) * 1024);
}

function decodeHalf(bits: number): number {
  return 2 ** (((bits >> 10) & 31) - 15) * (1 + (bits & 1023) / 1024);
}
