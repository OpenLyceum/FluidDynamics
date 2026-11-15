/**
 * bindLayouts.ts
 *
 * The bind group layouts the solver's pipelines are built from, as plain data.
 *
 * WebGPU checks a bind *group* against its layout, and a shader's declared
 * resources against the pipeline layout — but only for resources the entry point
 * statically uses, and only at pipeline-creation time, on a device. That is a
 * long way from the code being edited: adding a binding to a kernel and
 * forgetting to add it to the layout it shares with five other kernels produces
 * a validation error at startup, on hardware, and nothing at all in the type
 * checker.
 *
 * So the layouts live here as data rather than as `device.createBindGroupLayout`
 * calls buried in the engine, and `tests/ShaderBindings.test.ts` parses the WGSL
 * to check that every `@group(0) @binding(n)` a shader declares exists in the
 * layout its pipelines use, with a compatible kind and storage format. That test
 * runs in Vitest with no GPU.
 *
 * Several kernels share a layout, and a layout may legitimately carry entries a
 * given kernel does not use — the obstacle field is bound to every compute
 * layout, but the dye injection kernel has no use for it. The check is therefore
 * one-directional: shader ⊆ layout.
 */

/** Texture formats the fields use, shared with WebGPUFluidEngine. */
export const VELOCITY_FORMAT: GPUTextureFormat = "rgba16float";
export const SCALAR_FORMAT: GPUTextureFormat = "r32float";

/**
 * Binding index of the baked obstacle field, in every compute layout that has
 * one. A single high index rather than "the next free one per layout", so the
 * number means the same thing in every kernel that reads it.
 */
export const OBSTACLE_BINDING = 6;

/** What a binding holds, in the terms both WebGPU and WGSL can be checked in. */
export type BindingSpec =
  | { readonly kind: "uniform" }
  | { readonly kind: "sampler" }
  | { readonly kind: "texture"; readonly sampleType: "float" | "unfilterable-float" }
  | { readonly kind: "storageTexture"; readonly format: GPUTextureFormat }
  | { readonly kind: "storageBuffer"; readonly access: "read-only" | "read-write" };

export type BindLayoutSpec = {
  readonly label: string;
  /**
   * Which shader stages the layout's entries are visible to. "vertexFragment"
   * is for the tracer draw pass, whose vertex stage reads the particle buffer
   * and whose fragment stage reads nothing — the uniform is declared once for
   * the module, so both stages have to be able to see it.
   */
  readonly stage: "compute" | "fragment" | "vertexFragment";
  readonly bindings: Readonly<Record<number, BindingSpec>>;
};

const uniform: BindingSpec = { kind: "uniform" };
const sampler: BindingSpec = { kind: "sampler" };

/** A texture read through the filtering sampler, so it must be filterable. */
const filterable: BindingSpec = { kind: "texture", sampleType: "float" };

/**
 * r32float is not guaranteed filterable, so pressure, divergence, curl and the
 * obstacle field are declared unfilterable and read only with textureLoad.
 */
const unfilterable: BindingSpec = { kind: "texture", sampleType: "unfilterable-float" };

const velocityOut: BindingSpec = { kind: "storageTexture", format: VELOCITY_FORMAT };
const scalarOut: BindingSpec = { kind: "storageTexture", format: SCALAR_FORMAT };

/**
 * The tracer particle buffer, in the two roles it plays: advected in place by
 * the compute pass, then read for its positions by the draw pass. Writable
 * storage is not allowed in a vertex shader, which is the other reason the two
 * passes cannot share one layout.
 */
const tracersInOut: BindingSpec = { kind: "storageBuffer", access: "read-write" };
const tracersIn: BindingSpec = { kind: "storageBuffer", access: "read-only" };

export const BIND_LAYOUTS = {
  /** Bakes the obstacle SDF. The one kernel that does not read the result. */
  mask: {
    label: "mask",
    stage: "compute",
    bindings: { 0: uniform, 1: scalarOut },
  },

  /**
   * Semi-Lagrangian transport. 2 is the field the trace follows, 3 the field
   * being carried, 5 the pre-advection field the MacCormack corrector needs.
   */
  advect: {
    label: "advect",
    stage: "compute",
    bindings: {
      0: uniform,
      1: sampler,
      2: filterable,
      3: filterable,
      4: velocityOut,
      5: filterable,
      [OBSTACLE_BINDING]: unfilterable,
    },
  },

  /** Diffusion: the fixed source, the current iterate, the next one. */
  twoInRGBA: {
    label: "two-in-rgba",
    stage: "compute",
    bindings: { 0: uniform, 1: filterable, 2: filterable, 3: velocityOut, [OBSTACLE_BINDING]: unfilterable },
  },

  oneInRGBA: {
    label: "one-in-rgba",
    stage: "compute",
    bindings: { 0: uniform, 1: filterable, 2: velocityOut, [OBSTACLE_BINDING]: unfilterable },
  },

  oneInScalar: {
    label: "one-in-scalar",
    stage: "compute",
    bindings: { 0: uniform, 1: filterable, 2: scalarOut, [OBSTACLE_BINDING]: unfilterable },
  },

  mixedRGBA: {
    label: "mixed-rgba",
    stage: "compute",
    bindings: { 0: uniform, 1: filterable, 2: unfilterable, 3: velocityOut, [OBSTACLE_BINDING]: unfilterable },
  },

  twoInScalar: {
    label: "two-in-scalar",
    stage: "compute",
    bindings: { 0: uniform, 1: unfilterable, 2: unfilterable, 3: scalarOut, [OBSTACLE_BINDING]: unfilterable },
  },

  display: {
    label: "display",
    stage: "fragment",
    bindings: { 0: uniform, 1: sampler, 2: filterable, 3: filterable, 4: unfilterable, 5: unfilterable },
  },

  /** Carries the tracer dots along the finished velocity field. */
  tracerStep: {
    label: "tracer-step",
    stage: "compute",
    bindings: { 0: uniform, 1: sampler, 2: filterable, 3: tracersInOut, [OBSTACLE_BINDING]: unfilterable },
  },

  /** Draws them, straight out of the same buffer. */
  tracerDraw: {
    label: "tracer-draw",
    stage: "vertexFragment",
    bindings: { 0: uniform, 1: tracersIn },
  },
} as const satisfies Record<string, BindLayoutSpec>;

export type BindLayoutName = keyof typeof BIND_LAYOUTS;

/** @internal Exported for unit tests; not part of the application API. */
export const BIND_LAYOUT_NAMES = Object.keys(BIND_LAYOUTS) as BindLayoutName[];

/**
 * What a layout binds at an index, or undefined if it binds nothing there.
 *
 * `as const satisfies` above narrows each layout's bindings to a literal record,
 * which is what makes a typo in a layout a compile error — but it also means the
 * records cannot be indexed by a computed number. This is the one place that
 * widening happens.
 * @internal Exported for unit tests; not part of the application API.
 */
export function layoutBinding(name: BindLayoutName, binding: number): BindingSpec | undefined {
  return (BIND_LAYOUTS[name].bindings as Readonly<Record<number, BindingSpec>>)[binding];
}

/**
 * Which layout each shader's pipelines are created with. Every shader file must
 * appear here, so a new one cannot quietly escape the binding check.
 * @internal Exported for unit tests; not part of the application API.
 */
export const SHADER_LAYOUTS = {
  "mask.wgsl": "mask",
  "advect.wgsl": "advect",
  "diffuse.wgsl": "twoInRGBA",
  "curl.wgsl": "oneInScalar",
  "vorticity.wgsl": "mixedRGBA",
  "forces.wgsl": "oneInRGBA",
  "divergence.wgsl": "oneInScalar",
  "pressure.wgsl": "twoInScalar",
  "gradientSubtract.wgsl": "mixedRGBA",
  "dye.wgsl": "oneInRGBA",
  "display.wgsl": "display",
  "tracerStep.wgsl": "tracerStep",
  "tracerDraw.wgsl": "tracerDraw",
} as const satisfies Record<string, BindLayoutName>;
