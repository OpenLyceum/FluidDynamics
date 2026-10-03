/**
 * WebGPUFluidEngine.ts
 *
 * Jos Stam's Stable Fluids, run entirely in WGSL compute shaders.
 *
 * The engine owns every GPU resource and the whole fluid state; nothing is
 * mirrored on the CPU. Its only inputs are the parameter values handed to
 * {@link step} each frame, and its only output is the detached canvas it renders
 * into, which FluidFieldNode blits into Scenery.
 *
 * ── One frame ─────────────────────────────────────────────────────────────────
 *   [bake obstacle mask, if it moved] → advect velocity (MacCormack: predict →
 *   correct) → diffuse (viscosity, red-black SOR ×N) → curl → vorticity
 *   confinement → forces & boundaries → divergence → pressure (red-black SOR ×N)
 *   → subtract pressure gradient → inject dye → advect dye (MacCormack) →
 *   [advect tracer dots, if shown] → display [→ draw tracer dots]
 *
 * Every compute dispatch above is recorded into a single compute pass on a
 * single command encoder, with one queue submission per frame.
 *
 * A paused frame identical to the one before it skips the whole compute pass and
 * records only the display — see the idle guard in step().
 *
 * Two of those counts are not fixed. The pressure sweeps come from the learner's
 * accuracy preference. The diffusion sweeps are derived per step from the
 * stiffness of the viscous solve — see common/gpu/solverSchedule.ts — which both
 * cuts the count at the cheap end of the viscosity range and raises it where a
 * fixed count used to leave the fluid less viscous than the readout claimed.
 *
 * ── Ping-pong ─────────────────────────────────────────────────────────────────
 * A shader cannot read and write the same texture, so velocity, dye and pressure
 * each exist twice and swap roles after every write. Bind groups reference
 * concrete texture views, so every combination of parities that the frame can
 * reach is built once at construction: allocating bind groups inside the frame
 * loop is the classic way to make a WebGPU renderer allocate 60 times a second.
 *
 * ── The obstacle mask ─────────────────────────────────────────────────────────
 * The solver asks whether a cell is solid several times per cell in nearly every
 * dispatch. Answering it analytically means re-evaluating the obstacle SDF —
 * transcendentals, for the airfoil — tens of millions of times a frame for an
 * answer that only changes when the learner moves the body. So it is baked into
 * a texture by mask.wgsl and re-baked only when the obstacle or the grid
 * changes.
 *
 * ── Texture formats ───────────────────────────────────────────────────────────
 * Velocity and dye are rgba16float because semi-Lagrangian advection wants
 * hardware bilinear filtering, and rgba16float is both filterable and usable as
 * a storage texture in core WebGPU. rg32float would fit velocity exactly but is
 * not filterable without an optional feature. Pressure, divergence and curl are
 * r32float and are only ever read with textureLoad, so filtering does not apply.
 */

import {
  CHANNEL_HEIGHT_M,
  CHANNEL_WIDTH_M,
  DISPLAY_CANVAS_HEIGHT,
  DISPLAY_CANVAS_WIDTH,
  PRESSURE_ITERATIONS_HIGH,
  TRACER_EXIT_MARGIN_M,
  TRACER_FADE_IN_SECONDS,
  TRACER_INLET_X_M,
  TRACER_LANE_COUNT,
  TRACER_RADIUS_M,
  TRACER_TOTAL_COUNT,
  TRACER_WORKGROUP_SIZE,
} from "../../FluidDynamicsConstants.js";
import {
  BIND_LAYOUTS,
  type BindingSpec,
  type BindLayoutName,
  type BindLayoutSpec,
  OBSTACLE_BINDING,
  SCALAR_FORMAT,
  VELOCITY_FORMAT,
} from "./bindLayouts.js";
import type { FluidGridSpec } from "./FluidGridSpec.js";
import {
  FluidUniforms,
  type FluidUniformValues,
  UNIFORM_BUFFER_SIZE,
  UNIFORM_FLOAT_COUNT,
  UNIFORM_OFFSETS,
} from "./FluidUniforms.js";
import { advanceInflowRamp, type InflowRampState, isInflowSettling } from "./inflowRamp.js";
import advectWGSL from "./shaders/advect.wgsl?raw";
import commonWGSL from "./shaders/common.wgsl?raw";
import curlWGSL from "./shaders/curl.wgsl?raw";
import diffuseWGSL from "./shaders/diffuse.wgsl?raw";
import displayWGSL from "./shaders/display.wgsl?raw";
import divergenceWGSL from "./shaders/divergence.wgsl?raw";
import dyeWGSL from "./shaders/dye.wgsl?raw";
import forcesWGSL from "./shaders/forces.wgsl?raw";
import gradientSubtractWGSL from "./shaders/gradientSubtract.wgsl?raw";
import maskWGSL from "./shaders/mask.wgsl?raw";
import pressureWGSL from "./shaders/pressure.wgsl?raw";
import tracerDrawWGSL from "./shaders/tracerDraw.wgsl?raw";
import tracerStepWGSL from "./shaders/tracerStep.wgsl?raw";
import vorticityWGSL from "./shaders/vorticity.wgsl?raw";
import { diffusionAlpha, diffusionSweeps } from "./solverSchedule.js";
import {
  advanceTracerRelease,
  initialTracerRelease,
  NO_TRACER_RELEASE,
  type TracerReleaseState,
} from "./tracerSchedule.js";

/** Everything step() needs that is not derived from the grid. */
export type FluidStepValues = Omit<FluidUniformValues, "domainWidth" | "domainHeight" | "dt" | "tracerEmitBatch"> & {
  readonly pressureIterations: number;
  /**
   * Whether the tracer dots are shown. Not a uniform: it gates the advection
   * dispatch and the draw call on the CPU, and which column is released — the
   * part the shader does need to know — is the engine's own business.
   */
  readonly tracersVisible: boolean;
};

/** A field that must be read and written in the same pass, so it exists twice. */
class PingPong {
  private readonly textures: [GPUTexture, GPUTexture];
  public readonly views: [GPUTextureView, GPUTextureView];

  /** Index of the texture holding the current value. */
  public parity: 0 | 1 = 0;

  public constructor(device: GPUDevice, label: string, format: GPUTextureFormat, grid: FluidGridSpec) {
    const descriptor: GPUTextureDescriptor = {
      size: [grid.width, grid.height],
      format,
      // COPY_SRC so the engine integration test can read the velocity field
      // back; unused by the solver itself.
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    };
    this.textures = [
      device.createTexture({ ...descriptor, label: `${label}0` }),
      device.createTexture({ ...descriptor, label: `${label}1` }),
    ];
    this.views = [this.textures[0].createView(), this.textures[1].createView()];
  }

  /** Records that the field was just written, so read and write swap. */
  public swap(): void {
    this.parity = this.parity === 0 ? 1 : 0;
  }

  /** The texture holding the field's current value, for readback paths. */
  public get currentTexture(): GPUTexture {
    return this.textures[this.parity];
  }

  public destroy(): void {
    this.textures[0].destroy();
    this.textures[1].destroy();
  }
}

/** Construction options. */
export type WebGPUFluidEngineOptions = {
  /**
   * Copy each finished frame to the canvas. Turned off by the engine integration
   * test, which reads pixels back from the offscreen target instead — some
   * headless environments cannot present WebGPU to a canvas at all.
   */
  readonly presentToCanvas?: boolean;
};

export class WebGPUFluidEngine {
  public readonly canvas: HTMLCanvasElement;

  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly canvasFormat: GPUTextureFormat;
  private readonly presentToCanvas: boolean;
  private readonly uniforms = new FluidUniforms();
  private readonly uniformBuffer: GPUBuffer;
  private readonly linearSampler: GPUSampler;

  /** Reports a device or validation error, so the view can show the fallback. */
  private readonly onFailure: () => void;

  /**
   * The uncaptured-error handler, kept so dispose() can detach it.
   *
   * The device is a process-wide singleton shared by every screen (see
   * webgpuSupport.ts) and outlives any one engine, so a handler left attached
   * keeps this engine — and everything it closes over — alive for the life of
   * the page.
   */
  private readonly errorListener: (event: Event) => void;

  private grid: FluidGridSpec;

  // Fields. Recreated whenever the grid resolution changes.
  private velocity!: PingPong;
  private dye!: PingPong;
  private pressure!: PingPong;
  private velocitySource!: GPUTexture;
  private velocitySourceView!: GPUTextureView;
  /**
   * Scratch texture holding the predictor (φ_A) of the MacCormack velocity
   * advection. Written by the backward trace, read by the corrector, then dead
   * until next frame — one allocation reused for the life of the grid.
   */
  private advectTemp!: GPUTexture;
  private advectTempView!: GPUTextureView;
  /** The same scratch role, for the dye's MacCormack corrector. */
  private dyeTemp!: GPUTexture;
  private dyeTempView!: GPUTextureView;
  private divergence!: GPUTexture;
  private divergenceView!: GPUTextureView;
  private curl!: GPUTexture;
  private curlView!: GPUTextureView;
  /**
   * The obstacle's signed distance, one value per cell, written by mask.wgsl.
   * Read by every kernel that needs to know where the body is.
   */
  private obstacle!: GPUTexture;
  private obstacleView!: GPUTextureView;

  /**
   * The tracer dots: one vec4 per particle, advected in place by
   * tracerStep.wgsl and read for its positions by tracerDraw.wgsl. Never read
   * back to the CPU — a readback would stall the pipeline every frame, and
   * nothing on this side needs to know where a dot is.
   *
   * A newly created buffer reads as zero, which is a full set of parked
   * particles, so an empty channel needs no initialization pass.
   */
  private tracers!: GPUBuffer;

  /**
   * Set whenever the baked obstacle field no longer matches the parameters, so
   * the next frame re-bakes it before anything reads it. Starts true because a
   * freshly created texture reads as all-zero, which would be a body filling the
   * entire channel.
   */
  private isMaskStale = true;

  /** The obstacle the mask was last baked for. */
  private maskedObstacle = {
    shape: Number.NaN,
    radius: Number.NaN,
    x: Number.NaN,
    y: Number.NaN,
    angle: Number.NaN,
    focalRadius: Number.NaN,
    thickness: Number.NaN,
  };

  private pipelines!: Pipelines;
  private bindGroups!: BindGroups;

  /**
   * Where the display pass draws. Rendering to an offscreen texture and then
   * copying to the canvas — rather than rendering straight into the canvas
   * texture — costs one full-surface GPU copy per frame and buys two things: the
   * finished frame can be read back for testing, and presentation becomes a
   * single command that can be skipped where it is unsupported.
   */
  private displayTexture!: GPUTexture;
  private displayView!: GPUTextureView;

  /** Staging buffer for readDisplayPixels, allocated on first use. */
  private readbackBuffer: GPUBuffer | null = null;

  /** Staging buffer for readVelocity, reallocated when the grid changes size. */
  private velocityReadbackBuffer: GPUBuffer | null = null;

  /**
   * Where the inflow boundary's ramp toward the slider's speed stands, or null
   * before the first step (and after a reset, where the field at rest is
   * consistent with any inflow). See inflowRamp.ts.
   */
  private inflowRamp: InflowRampState | null = null;

  /** How far the stream has carried since the last column of dots was released. */
  private tracerRelease: TracerReleaseState = initialTracerRelease();

  /**
   * Whether the previous frame drew the dots, so that switching them on starts
   * from an empty channel rather than resuming a pattern frozen mid-flight.
   */
  private wereTracersVisible = false;

  /**
   * The previous frame's uniforms, so a paused frame can distinguish changes
   * that need compute work from display-only changes. See the idle guard in step().
   */
  private readonly lastPacked = new Float32Array(UNIFORM_FLOAT_COUNT);

  /**
   * Whether lastPacked describes a frame that actually ran against the *current*
   * textures. Cleared by reset() and setGrid(), which replace the fields with
   * zeroed ones: the uniforms are unchanged across a reset, so without this the
   * first frame after one would match the last frame before it and idle, leaving
   * the learner looking at an empty channel with no dye at the inlet.
   */
  private hasStepped = false;

  private isDisposed = false;
  private hasFailed = false;

  public constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    grid: FluidGridSpec,
    onFailure: () => void,
    options?: WebGPUFluidEngineOptions,
  ) {
    this.canvas = canvas;
    this.device = device;
    this.grid = grid;
    this.onFailure = onFailure;
    this.presentToCanvas = options?.presentToCanvas ?? true;
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();

    // Registered before any resource is created, so validation errors raised
    // during pipeline construction are caught too.
    this.errorListener = (event: Event): void => {
      this.reportError(event as GPUUncapturedErrorEvent);
    };
    device.addEventListener("uncapturederror", this.errorListener);

    canvas.width = DISPLAY_CANVAS_WIDTH;
    canvas.height = DISPLAY_CANVAS_HEIGHT;

    const context = canvas.getContext("webgpu");
    if (context === null) {
      this.hasFailed = true;
      // dispose() will never run on a constructor that throws, so the handler
      // registered above has to come back off the shared device here.
      device.removeEventListener("uncapturederror", this.errorListener);
      onFailure();
      throw new Error("canvas does not support a webgpu context");
    }
    this.context = context;
    this.context.configure({
      device,
      format: this.canvasFormat,
      // COPY_DST because frames arrive by copyTextureToTexture from the
      // offscreen display target rather than by rendering into the canvas.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      // Opaque: the result is blitted into Scenery's canvas with drawImage, and
      // a premultiplied-alpha surface would darken where the dye is thin.
      alphaMode: "opaque",
    });

    this.uniformBuffer = device.createBuffer({
      label: "fluid-uniforms",
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Clamp-to-edge, so a backtrace that leaves the channel reads the boundary
    // value rather than wrapping around to the far side.
    this.linearSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.displayTexture = device.createTexture({
      label: "display-target",
      size: [DISPLAY_CANVAS_WIDTH, DISPLAY_CANVAS_HEIGHT],
      format: this.canvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.displayView = this.displayTexture.createView();

    this.pipelines = createPipelines(device, this.canvasFormat);
    this.createFields();
  }

  /** Whether the engine is still able to render. */
  public get isRunning(): boolean {
    return !(this.isDisposed || this.hasFailed);
  }

  /** The grid the solver is currently running on. */
  public get gridSpec(): FluidGridSpec {
    return this.grid;
  }

  /**
   * Channel order of the bytes readDisplayPixels returns. It follows the
   * platform's preferred canvas format, which is bgra8unorm on most desktops —
   * so callers cannot assume RGBA.
   */
  public get displayFormat(): GPUTextureFormat {
    return this.canvasFormat;
  }

  /**
   * Advances the solver by dt seconds and renders the result.
   *
   * dt is expected to be pre-clamped and pre-substepped by the caller — the
   * engine runs exactly one solver step per call.
   */
  public step(dt: number, values: FluidStepValues): void {
    if (!this.isRunning) {
      return;
    }

    // The inflow boundary approaches the requested speed rather than following
    // it instantly; see inflowRamp.ts for why a step change is unphysical here.
    this.inflowRamp = advanceInflowRamp(this.inflowRamp, values.inflowSpeed, dt);

    // While the inflow is settling, the projection gets the high-accuracy sweep
    // count: an under-converged pressure solve is what turns the settling into
    // a backward slosh at the outflow (measured in the engine integration test).
    // Not on the paused path — a dt of zero advances nothing, so the extra
    // sweeps would only make re-render frames more expensive.
    const pressureIterations =
      dt > 0 && isInflowSettling(this.inflowRamp)
        ? Math.max(values.pressureIterations, PRESSURE_ITERATIONS_HIGH)
        : values.pressureIterations;

    // Releasing is clocked by the speed the boundary is actually applying, not
    // the one the slider asks for, so the columns stay evenly spaced through a
    // ramp as well as after it.
    this.advanceTracers(values.tracersVisible, dt, this.inflowRamp.applied);

    const packed = this.uniforms.pack(
      {
        ...values,
        dt,
        inflowSpeed: this.inflowRamp.applied,
        domainWidth: CHANNEL_WIDTH_M,
        domainHeight: CHANNEL_HEIGHT_M,
        tracerEmitBatch: this.tracerRelease.emitBatch,
      },
      this.grid,
    );
    const arePausedInputsUnchanged = this.hasStepped && pausedInputsEqual(packed, this.lastPacked);
    this.lastPacked.set(packed);
    this.hasStepped = true;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, packed);

    const encoder = this.device.createCommandEncoder({ label: "fluid-frame" });
    // How stiff the viscous solve is this step decides how many sweeps it gets;
    // zero on the paused path, where every sweep is the identity and only the
    // seeding dispatch is needed.
    const sweeps = diffusionSweeps(diffusionAlpha(values.viscosity, dt, this.grid.cellSize));
    this.markMask(values);

    // Entering pause and changing display settings must preserve the field.
    // A zero-dt projection still changes velocity, so display-only changes
    // skip the whole solver rather than merely its advection and diffusion.
    // Geometry changes and pointer painting still need the paused compute path;
    // newly allocated fields also need their first mask and inlet injection.
    const isIdle = dt <= 0 && arePausedInputsUnchanged && !this.isMaskStale;
    if (!isIdle) {
      this.recordCompute(encoder, pressureIterations, sweeps, values.tracersVisible);
    }
    this.recordDisplay(encoder, values.tracersVisible);
    if (this.presentToCanvas) {
      encoder.copyTextureToTexture({ texture: this.displayTexture }, { texture: this.context.getCurrentTexture() }, [
        DISPLAY_CANVAS_WIDTH,
        DISPLAY_CANVAS_HEIGHT,
      ]);
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Reads the last rendered frame back as RGBA bytes, row-major from the top.
   *
   * The only way to inspect the solver's output without a display, and therefore
   * how the engine integration test checks that the physics is right. Not used
   * on the rendering path: a full readback stalls the pipeline.
   */
  public async readDisplayPixels(): Promise<Uint8Array> {
    // copyTextureToBuffer requires rows to be a multiple of 256 bytes.
    const bytesPerRow = Math.ceil((DISPLAY_CANVAS_WIDTH * 4) / 256) * 256;
    const size = bytesPerRow * DISPLAY_CANVAS_HEIGHT;

    this.readbackBuffer ??= this.device.createBuffer({
      label: "display-readback",
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const buffer = this.readbackBuffer;

    const encoder = this.device.createCommandEncoder({ label: "fluid-readback" });
    encoder.copyTextureToBuffer({ texture: this.displayTexture }, { buffer, bytesPerRow }, [
      DISPLAY_CANVAS_WIDTH,
      DISPLAY_CANVAS_HEIGHT,
    ]);
    this.device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();

    // Drop the row padding so callers get a tightly packed RGBA image.
    const tightBytesPerRow = DISPLAY_CANVAS_WIDTH * 4;
    if (bytesPerRow === tightBytesPerRow) {
      return padded;
    }
    const tight = new Uint8Array(tightBytesPerRow * DISPLAY_CANVAS_HEIGHT);
    for (let row = 0; row < DISPLAY_CANVAS_HEIGHT; row++) {
      tight.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + tightBytesPerRow), row * tightBytesPerRow);
    }
    return tight;
  }

  /**
   * Reads the velocity field back as u,v pairs in m/s, row-major from the
   * bottom (texture row 0 is grid y = 0).
   *
   * The solver-side counterpart of readDisplayPixels, for the same consumer: the
   * engine integration test. The rendered frame encodes speed but not direction,
   * so questions like "is the outflow ever reversed?" can only be answered from
   * the field itself. The velocity texture is rgba16float, so the half-float
   * pairs are decoded on the CPU. Not used on the rendering path: like the
   * display readback, a full copy stalls the pipeline.
   */
  public async readVelocity(): Promise<Float32Array> {
    const width = this.grid.width;
    const height = this.grid.height;
    // rgba16float: four half-precision channels, 8 bytes per cell.
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
    const size = bytesPerRow * height;

    if (this.velocityReadbackBuffer === null || this.velocityReadbackBuffer.size !== size) {
      this.velocityReadbackBuffer?.destroy();
      this.velocityReadbackBuffer = this.device.createBuffer({
        label: "velocity-readback",
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    }
    const buffer = this.velocityReadbackBuffer;

    const encoder = this.device.createCommandEncoder({ label: "velocity-readback" });
    encoder.copyTextureToBuffer({ texture: this.velocity.currentTexture }, { buffer, bytesPerRow }, [width, height]);
    this.device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();

    const uv = new Float32Array(width * height * 2);
    const padding = bytesPerRow - width * 8;
    for (let cell = 0; cell < width * height; cell++) {
      const i = cell * 8 + Math.floor(cell / width) * padding;
      uv[2 * cell] = decodeHalfFloat((padded[i] ?? 0) | ((padded[i + 1] ?? 0) << 8));
      uv[2 * cell + 1] = decodeHalfFloat((padded[i + 2] ?? 0) | ((padded[i + 3] ?? 0) << 8));
    }
    return uv;
  }

  /** Clears the fluid state back to a channel at rest with no dye. */
  public reset(): void {
    if (!this.isRunning) {
      return;
    }
    // Recreating the textures is the clearing mechanism: WebGPU guarantees new
    // resources read as zero, which saves a clear kernel and two more layouts.
    this.destroyFields();
    this.createFields();
    this.inflowRamp = null;
    this.tracerRelease = initialTracerRelease();
    this.hasStepped = false;
  }

  /** Switches the solver to a different grid, discarding the current state. */
  public setGrid(grid: FluidGridSpec): void {
    if (!this.isRunning || (grid.width === this.grid.width && grid.height === this.grid.height)) {
      return;
    }
    this.destroyFields();
    this.grid = grid;
    this.createFields();
    this.inflowRamp = null;
    this.tracerRelease = initialTracerRelease();
    this.hasStepped = false;
  }

  public dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.device.removeEventListener("uncapturederror", this.errorListener);
    this.destroyFields();
    this.displayTexture.destroy();
    this.readbackBuffer?.destroy();
    this.velocityReadbackBuffer?.destroy();
    this.uniformBuffer.destroy();
  }

  // ── Frame recording ─────────────────────────────────────────────────────────

  /**
   * Notes whether the baked obstacle field still describes the obstacle the
   * caller is asking for. Cheap enough to do every frame, and it means dragging
   * the body costs one dispatch while leaving it alone costs none.
   */
  private markMask(values: FluidStepValues): void {
    const previous = this.maskedObstacle;
    if (
      previous.shape !== values.obstacleShape ||
      previous.radius !== values.obstacleRadius ||
      previous.x !== values.obstacleCenterX ||
      previous.y !== values.obstacleCenterY ||
      previous.angle !== values.obstacleAngle ||
      previous.focalRadius !== values.obstacleFocalRadius ||
      previous.thickness !== values.airfoilThickness
    ) {
      this.isMaskStale = true;
      this.maskedObstacle = {
        shape: values.obstacleShape,
        radius: values.obstacleRadius,
        x: values.obstacleCenterX,
        y: values.obstacleCenterY,
        angle: values.obstacleAngle,
        focalRadius: values.obstacleFocalRadius,
        thickness: values.airfoilThickness,
      };
    }
  }

  /**
   * Moves the tracer release clock on by one step, and empties the buffer when
   * the dots are switched on.
   *
   * Clearing on the way in rather than on the way out means the parked dots of
   * the last run cannot reappear mid-channel: the learner gets a channel that
   * fills from the inlet, which is the picture the control promises.
   */
  private advanceTracers(visible: boolean, dt: number, inflowSpeed: number): void {
    if (visible !== this.wereTracersVisible) {
      this.wereTracersVisible = visible;
      this.tracerRelease = initialTracerRelease();
      if (visible) {
        this.device.queue.writeBuffer(this.tracers, 0, new Float32Array(TRACER_TOTAL_COUNT * 4));
      }
    }

    this.tracerRelease = visible
      ? advanceTracerRelease(this.tracerRelease, inflowSpeed, dt)
      : { ...this.tracerRelease, emitBatch: NO_TRACER_RELEASE };
  }

  private recordCompute(
    encoder: GPUCommandEncoder,
    pressureIterations: number,
    viscousSweeps: number,
    tracersVisible: boolean,
  ): void {
    const pass = encoder.beginComputePass({ label: "fluid-solver" });
    const x = this.grid.dispatchX;
    const y = this.grid.dispatchY;
    const bg = this.bindGroups;

    const dispatch = (pipeline: GPUComputePipeline, group: GPUBindGroup): void => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(x, y);
    };

    // 0. Bake the obstacle field, if it has moved. Must come first: everything
    //    below reads it. Within a compute pass each dispatch is its own usage
    //    scope, so writing it here and sampling it two dispatches later is fine.
    if (this.isMaskStale) {
      dispatch(this.pipelines.mask, bg.mask);
      this.isMaskStale = false;
    }

    // 1. Advect velocity: backward trace into the MacCormack scratch texture
    //    (φ_A), then the corrector writes the limited, anti-diffused velocity
    //    into velocitySource, which the diffusion solve reads from.
    dispatch(this.pipelines.advectVelocity, bg.advectVelocity[this.velocity.parity]);
    dispatch(this.pipelines.advectVelocityCorrect, bg.advectVelocityCorrect[this.velocity.parity]);

    // 2. Viscous diffusion. The seeding dispatch fills the iterate from the
    //    advected source; the red-black SOR sweeps then alternate colours, one
    //    dispatch each, so a red/black pair is one full Gauss–Seidel iteration
    //    and an even count lands back on the parity it started from.
    dispatch(this.pipelines.diffuseSeed, bg.diffuseSeed);
    this.velocity.parity = 0;
    for (let i = 0; i < viscousSweeps * 2; i++) {
      dispatch(i % 2 === 0 ? this.pipelines.diffuseRed : this.pipelines.diffuseBlack, bg.diffuse[this.velocity.parity]);
      this.velocity.swap();
    }

    // 3-4. Restore the small-scale vorticity advection dissipated.
    dispatch(this.pipelines.curl, bg.curl[this.velocity.parity]);
    dispatch(this.pipelines.vorticity, bg.vorticity[this.velocity.parity]);
    this.velocity.swap();

    // 5. Inflow, outflow, walls, and the learner's pointer.
    dispatch(this.pipelines.forces, bg.forces[this.velocity.parity]);
    this.velocity.swap();

    // 6-8. Projection: make the velocity field divergence-free. Red-black SOR
    //      alternates one red and one black sweep per step, so the dispatch
    //      count equals pressureIterations while each pair is a full GS iterate.
    dispatch(this.pipelines.divergence, bg.divergence[this.velocity.parity]);
    for (let i = 0; i < pressureIterations; i++) {
      dispatch(
        i % 2 === 0 ? this.pipelines.pressureRed : this.pipelines.pressureBlack,
        bg.pressure[this.pressure.parity],
      );
      this.pressure.swap();
    }
    dispatch(this.pipelines.gradientSubtract, bg.gradientSubtract[this.velocity.parity][this.pressure.parity]);
    this.velocity.swap();

    // 9-11. Dye: inject at the inflow, then carry it with the finished velocity
    //       — through the same MacCormack predictor–corrector the velocity gets,
    //       because the dye is what the learner actually looks at and a plain
    //       backward trace smears the bands out well before the far wall.
    dispatch(this.pipelines.injectDye, bg.injectDye[this.dye.parity]);
    this.dye.swap();
    dispatch(this.pipelines.advectDye, bg.advectDye[this.velocity.parity][this.dye.parity]);
    dispatch(this.pipelines.advectDyeCorrect, bg.advectDyeCorrect[this.velocity.parity][this.dye.parity]);
    this.dye.swap();

    // 12. Carry the tracer dots along the velocity this step finished with, and
    //     release the column the clock asked for. Last, so the dots see the
    //     same divergence-free field the dye was just advected by — and one
    //     dispatch over a few hundred particles either way.
    if (tracersVisible) {
      pass.setPipeline(this.pipelines.tracerStep);
      pass.setBindGroup(0, bg.tracerStep[this.velocity.parity]);
      pass.dispatchWorkgroups(Math.ceil(TRACER_TOTAL_COUNT / TRACER_WORKGROUP_SIZE));
    }

    pass.end();
  }

  private recordDisplay(encoder: GPUCommandEncoder, tracersVisible: boolean): void {
    const pass = encoder.beginRenderPass({
      label: "fluid-display",
      colorAttachments: [
        {
          view: this.displayView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipelines.display);
    pass.setBindGroup(0, this.bindGroups.display[this.dye.parity][this.velocity.parity][this.pressure.parity]);
    pass.draw(3);

    // Over the field, in the same pass: the dots mark fluid parcels, so they
    // belong on top of whichever field is being shown. Parked particles are
    // still drawn — nothing on this side knows which those are — and collapse
    // to nothing in the vertex shader.
    if (tracersVisible) {
      pass.setPipeline(this.pipelines.tracerDots);
      pass.setBindGroup(0, this.bindGroups.tracerDraw);
      pass.draw(6, TRACER_TOTAL_COUNT);
    }

    pass.end();
  }

  // ── Resources ───────────────────────────────────────────────────────────────

  private createFields(): void {
    const device = this.device;
    const grid = this.grid;

    this.velocity = new PingPong(device, "velocity", VELOCITY_FORMAT, grid);
    this.dye = new PingPong(device, "dye", VELOCITY_FORMAT, grid);
    this.pressure = new PingPong(device, "pressure", SCALAR_FORMAT, grid);

    const storageAndSample = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;

    this.velocitySource = device.createTexture({
      label: "velocity-source",
      size: [grid.width, grid.height],
      format: VELOCITY_FORMAT,
      usage: storageAndSample,
    });
    this.velocitySourceView = this.velocitySource.createView();

    this.advectTemp = device.createTexture({
      label: "advect-temp",
      size: [grid.width, grid.height],
      format: VELOCITY_FORMAT,
      usage: storageAndSample,
    });
    this.advectTempView = this.advectTemp.createView();

    this.dyeTemp = device.createTexture({
      label: "dye-temp",
      size: [grid.width, grid.height],
      format: VELOCITY_FORMAT,
      usage: storageAndSample,
    });
    this.dyeTempView = this.dyeTemp.createView();

    this.obstacle = device.createTexture({
      label: "obstacle-field",
      size: [grid.width, grid.height],
      format: SCALAR_FORMAT,
      usage: storageAndSample,
    });
    this.obstacleView = this.obstacle.createView();
    // A new texture reads as zero, which the solver would take for "solid
    // everywhere". Nothing may read it before mask.wgsl has filled it in.
    this.isMaskStale = true;

    this.divergence = device.createTexture({
      label: "divergence",
      size: [grid.width, grid.height],
      format: SCALAR_FORMAT,
      usage: storageAndSample,
    });
    this.divergenceView = this.divergence.createView();

    this.curl = device.createTexture({
      label: "curl",
      size: [grid.width, grid.height],
      format: SCALAR_FORMAT,
      usage: storageAndSample,
    });
    this.curlView = this.curl.createView();

    // Grid-independent — the dots live in metres, not cells — but created and
    // destroyed with the fields so that reset() and a resolution change clear
    // them along with everything else.
    this.tracers = device.createBuffer({
      label: "tracers",
      // vec4<f32> per particle: position in metres, age in seconds, alive flag.
      size: TRACER_TOTAL_COUNT * 4 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.bindGroups = this.createBindGroups();
  }

  private destroyFields(): void {
    this.velocity.destroy();
    this.dye.destroy();
    this.pressure.destroy();
    this.velocitySource.destroy();
    this.advectTemp.destroy();
    this.dyeTemp.destroy();
    this.obstacle.destroy();
    this.divergence.destroy();
    this.curl.destroy();
    this.tracers.destroy();
  }

  private createBindGroups(): BindGroups {
    const device = this.device;
    const layouts = this.pipelines.layouts;
    const uniform: GPUBindGroupEntry = { binding: 0, resource: { buffer: this.uniformBuffer } };
    const sampler: GPUBindGroupEntry = { binding: 1, resource: this.linearSampler };
    /** Bound to every compute layout, whether or not the kernel reads it. */
    const obstacle: GPUBindGroupEntry = { binding: OBSTACLE_BINDING, resource: this.obstacleView };

    const velocityViews = this.velocity.views;
    const dyeViews = this.dye.views;
    const pressureViews = this.pressure.views;

    const group = (layout: GPUBindGroupLayout, entries: GPUBindGroupEntry[]): GPUBindGroup =>
      device.createBindGroup({ layout, entries });

    // Indexed by the parity of the field(s) each pass reads.
    const perParity = <T>(build: (parity: 0 | 1) => T): [T, T] => [build(0), build(1)];

    return {
      mask: group(layouts.mask, [uniform, { binding: 1, resource: this.obstacleView }]),

      // Predicts φ_A: backward-advects velocity by itself into the scratch texture.
      advectVelocity: perParity((p) =>
        group(layouts.advect, [
          uniform,
          sampler,
          { binding: 2, resource: velocityViews[p] },
          { binding: 3, resource: velocityViews[p] },
          { binding: 4, resource: this.advectTempView },
          { binding: 5, resource: velocityViews[p] },
          obstacle,
        ]),
      ),

      // MacCormack corrector: traces with φⁿ (binding 2), reads φ_A from the
      // scratch texture (binding 3) and φⁿ itself again (binding 5), and writes
      // the corrected velocity to the diffusion source.
      advectVelocityCorrect: perParity((p) =>
        group(layouts.advect, [
          uniform,
          sampler,
          { binding: 2, resource: velocityViews[p] },
          { binding: 3, resource: this.advectTempView },
          { binding: 4, resource: this.velocitySourceView },
          { binding: 5, resource: velocityViews[p] },
          obstacle,
        ]),
      ),

      // Seeding dispatch: iterate seeded from the advected source itself.
      diffuseSeed: group(layouts.twoInRGBA, [
        uniform,
        { binding: 1, resource: this.velocitySourceView },
        { binding: 2, resource: this.velocitySourceView },
        { binding: 3, resource: velocityViews[0] },
        obstacle,
      ]),

      diffuse: perParity((p) =>
        group(layouts.twoInRGBA, [
          uniform,
          { binding: 1, resource: this.velocitySourceView },
          { binding: 2, resource: velocityViews[p] },
          { binding: 3, resource: velocityViews[p === 0 ? 1 : 0] },
          obstacle,
        ]),
      ),

      curl: perParity((p) =>
        group(layouts.oneInScalar, [
          uniform,
          { binding: 1, resource: velocityViews[p] },
          { binding: 2, resource: this.curlView },
          obstacle,
        ]),
      ),

      vorticity: perParity((p) =>
        group(layouts.mixedRGBA, [
          uniform,
          { binding: 1, resource: velocityViews[p] },
          { binding: 2, resource: this.curlView },
          { binding: 3, resource: velocityViews[p === 0 ? 1 : 0] },
          obstacle,
        ]),
      ),

      forces: perParity((p) =>
        group(layouts.oneInRGBA, [
          uniform,
          { binding: 1, resource: velocityViews[p] },
          { binding: 2, resource: velocityViews[p === 0 ? 1 : 0] },
          obstacle,
        ]),
      ),

      divergence: perParity((p) =>
        group(layouts.oneInScalar, [
          uniform,
          { binding: 1, resource: velocityViews[p] },
          { binding: 2, resource: this.divergenceView },
          obstacle,
        ]),
      ),

      pressure: perParity((p) =>
        group(layouts.twoInScalar, [
          uniform,
          { binding: 1, resource: pressureViews[p] },
          { binding: 2, resource: this.divergenceView },
          { binding: 3, resource: pressureViews[p === 0 ? 1 : 0] },
          obstacle,
        ]),
      ),

      gradientSubtract: perParity((v) =>
        perParity((p) =>
          group(layouts.mixedRGBA, [
            uniform,
            { binding: 1, resource: velocityViews[v] },
            { binding: 2, resource: pressureViews[p] },
            { binding: 3, resource: velocityViews[v === 0 ? 1 : 0] },
            obstacle,
          ]),
        ),
      ),

      injectDye: perParity((d) =>
        group(layouts.oneInRGBA, [
          uniform,
          { binding: 1, resource: dyeViews[d] },
          { binding: 2, resource: dyeViews[d === 0 ? 1 : 0] },
          obstacle,
        ]),
      ),

      // Dye predictor: traced by the finished velocity, into the dye scratch.
      advectDye: perParity((v) =>
        perParity((d) =>
          group(layouts.advect, [
            uniform,
            sampler,
            { binding: 2, resource: velocityViews[v] },
            { binding: 3, resource: dyeViews[d] },
            { binding: 4, resource: this.dyeTempView },
            { binding: 5, resource: dyeViews[d] },
            obstacle,
          ]),
        ),
      ),

      // Dye corrector: unlike the velocity's, the field being carried and the
      // field doing the carrying are different textures — hence binding 5.
      advectDyeCorrect: perParity((v) =>
        perParity((d) =>
          group(layouts.advect, [
            uniform,
            sampler,
            { binding: 2, resource: velocityViews[v] },
            { binding: 3, resource: this.dyeTempView },
            { binding: 4, resource: dyeViews[d === 0 ? 1 : 0] },
            { binding: 5, resource: dyeViews[d] },
            obstacle,
          ]),
        ),
      ),

      display: perParity((d) =>
        perParity((v) =>
          perParity((p) =>
            group(layouts.display, [
              uniform,
              sampler,
              { binding: 2, resource: dyeViews[d] },
              { binding: 3, resource: velocityViews[v] },
              { binding: 4, resource: this.curlView },
              { binding: 5, resource: pressureViews[p] },
            ]),
          ),
        ),
      ),

      tracerStep: perParity((v) =>
        group(layouts.tracerStep, [
          uniform,
          sampler,
          { binding: 2, resource: velocityViews[v] },
          { binding: 3, resource: { buffer: this.tracers } },
          obstacle,
        ]),
      ),

      tracerDraw: group(layouts.tracerDraw, [uniform, { binding: 1, resource: { buffer: this.tracers } }]),
    };
  }

  private reportError(event: GPUUncapturedErrorEvent): void {
    if (this.hasFailed) {
      return;
    }
    this.hasFailed = true;
    // A WebGPU error is otherwise completely silent — it leaves a blank field
    // and no way at all to diagnose what went wrong. The learner still gets the
    // "WebGPU is not available" message via onFailure(); this line is for
    // whoever has to debug it. It is the only console use in src/, and the
    // hasFailed guard above means it fires at most once per engine.
    // biome-ignore lint/suspicious/noConsole: see above
    console.error(`WebGPU error in the fluid solver: ${event.error.message}`);
    this.onFailure();
  }
}

// ── Pipeline construction ─────────────────────────────────────────────────────

type Layouts = { readonly [K in BindLayoutName]: GPUBindGroupLayout };

type Pipelines = {
  readonly layouts: Layouts;
  readonly mask: GPUComputePipeline;
  readonly advectVelocity: GPUComputePipeline;
  readonly advectVelocityCorrect: GPUComputePipeline;
  readonly advectDye: GPUComputePipeline;
  readonly advectDyeCorrect: GPUComputePipeline;
  readonly diffuseSeed: GPUComputePipeline;
  readonly diffuseRed: GPUComputePipeline;
  readonly diffuseBlack: GPUComputePipeline;
  readonly curl: GPUComputePipeline;
  readonly vorticity: GPUComputePipeline;
  readonly forces: GPUComputePipeline;
  readonly divergence: GPUComputePipeline;
  readonly pressureRed: GPUComputePipeline;
  readonly pressureBlack: GPUComputePipeline;
  readonly gradientSubtract: GPUComputePipeline;
  readonly injectDye: GPUComputePipeline;
  readonly display: GPURenderPipeline;
  readonly tracerStep: GPUComputePipeline;
  readonly tracerDots: GPURenderPipeline;
};

type BindGroups = {
  readonly mask: GPUBindGroup;
  readonly advectVelocity: [GPUBindGroup, GPUBindGroup];
  readonly advectVelocityCorrect: [GPUBindGroup, GPUBindGroup];
  readonly diffuseSeed: GPUBindGroup;
  readonly diffuse: [GPUBindGroup, GPUBindGroup];
  readonly curl: [GPUBindGroup, GPUBindGroup];
  readonly vorticity: [GPUBindGroup, GPUBindGroup];
  readonly forces: [GPUBindGroup, GPUBindGroup];
  readonly divergence: [GPUBindGroup, GPUBindGroup];
  readonly pressure: [GPUBindGroup, GPUBindGroup];
  readonly gradientSubtract: [[GPUBindGroup, GPUBindGroup], [GPUBindGroup, GPUBindGroup]];
  readonly injectDye: [GPUBindGroup, GPUBindGroup];
  readonly advectDye: [[GPUBindGroup, GPUBindGroup], [GPUBindGroup, GPUBindGroup]];
  readonly advectDyeCorrect: [[GPUBindGroup, GPUBindGroup], [GPUBindGroup, GPUBindGroup]];
  readonly display: [
    [[GPUBindGroup, GPUBindGroup], [GPUBindGroup, GPUBindGroup]],
    [[GPUBindGroup, GPUBindGroup], [GPUBindGroup, GPUBindGroup]],
  ];
  readonly tracerStep: [GPUBindGroup, GPUBindGroup];
  readonly tracerDraw: GPUBindGroup;
};

/** The half of a layout entry that says what kind of resource is bound. */
function layoutResource(binding: BindingSpec): Omit<GPUBindGroupLayoutEntry, "binding" | "visibility"> {
  if (binding.kind === "uniform") {
    return { buffer: { type: "uniform" } };
  }
  if (binding.kind === "sampler") {
    return { sampler: { type: "filtering" } };
  }
  if (binding.kind === "texture") {
    return { texture: { sampleType: binding.sampleType } };
  }
  if (binding.kind === "storageBuffer") {
    return { buffer: { type: binding.access === "read-write" ? "storage" : "read-only-storage" } };
  }
  return { storageTexture: { access: "write-only", format: binding.format } };
}

/** Which shader stages a layout's entries are visible from. */
function layoutVisibility(stage: BindLayoutSpec["stage"]): number {
  if (stage === "compute") {
    return GPUShaderStage.COMPUTE;
  }
  if (stage === "vertexFragment") {
    return GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  }
  return GPUShaderStage.FRAGMENT;
}

/** Turns one of the plain-data layout specs in bindLayouts.ts into a real one. */
function createLayout(device: GPUDevice, spec: BindLayoutSpec): GPUBindGroupLayout {
  const visibility = layoutVisibility(spec.stage);

  return device.createBindGroupLayout({
    label: spec.label,
    entries: Object.entries(spec.bindings).map(([index, binding]) => ({
      binding: Number(index),
      visibility,
      ...layoutResource(binding),
    })),
  });
}

function createPipelines(device: GPUDevice, canvasFormat: GPUTextureFormat): Pipelines {
  const layouts = Object.fromEntries(
    Object.entries(BIND_LAYOUTS).map(([name, spec]) => [name, createLayout(device, spec)]),
  ) as Layouts;

  // WGSL has no include mechanism, so the shared struct and helpers are
  // concatenated ahead of every shader.
  const module = (label: string, source: string): GPUShaderModule =>
    device.createShaderModule({ label, code: `${commonWGSL}\n${source}` });

  const compute = (label: string, layout: GPUBindGroupLayout, source: string, entryPoint: string): GPUComputePipeline =>
    device.createComputePipeline({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: module(label, source), entryPoint },
    });

  const advectModule = module("advect", advectWGSL);
  const advectLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.advect] });
  const pressureModule = module("pressure", pressureWGSL);
  const pressureLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.twoInScalar] });
  const diffuseModule = module("diffuse", diffuseWGSL);
  const diffuseLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.twoInRGBA] });

  const displayModule = module("display", displayWGSL);
  const tracerModule = module("tracer-draw", tracerDrawWGSL);

  return {
    layouts,
    mask: compute("mask", layouts.mask, maskWGSL, "main"),
    advectVelocity: device.createComputePipeline({
      label: "advect-velocity",
      layout: advectLayout,
      compute: { module: advectModule, entryPoint: "advectVelocity" },
    }),
    advectVelocityCorrect: device.createComputePipeline({
      label: "advect-velocity-correct",
      layout: advectLayout,
      compute: { module: advectModule, entryPoint: "advectVelocityCorrect" },
    }),
    advectDye: device.createComputePipeline({
      label: "advect-dye",
      layout: advectLayout,
      compute: { module: advectModule, entryPoint: "advectDye" },
    }),
    advectDyeCorrect: device.createComputePipeline({
      label: "advect-dye-correct",
      layout: advectLayout,
      compute: { module: advectModule, entryPoint: "advectDyeCorrect" },
    }),
    diffuseSeed: device.createComputePipeline({
      label: "diffuse-seed",
      layout: diffuseLayout,
      compute: { module: diffuseModule, entryPoint: "seed" },
    }),
    diffuseRed: device.createComputePipeline({
      label: "diffuse-red",
      layout: diffuseLayout,
      compute: { module: diffuseModule, entryPoint: "solveRed" },
    }),
    diffuseBlack: device.createComputePipeline({
      label: "diffuse-black",
      layout: diffuseLayout,
      compute: { module: diffuseModule, entryPoint: "solveBlack" },
    }),
    curl: compute("curl", layouts.oneInScalar, curlWGSL, "main"),
    vorticity: compute("vorticity", layouts.mixedRGBA, vorticityWGSL, "main"),
    forces: compute("forces", layouts.oneInRGBA, forcesWGSL, "main"),
    divergence: compute("divergence", layouts.oneInScalar, divergenceWGSL, "main"),
    pressureRed: device.createComputePipeline({
      label: "pressure-red",
      layout: pressureLayout,
      compute: { module: pressureModule, entryPoint: "solveRed" },
    }),
    pressureBlack: device.createComputePipeline({
      label: "pressure-black",
      layout: pressureLayout,
      compute: { module: pressureModule, entryPoint: "solveBlack" },
    }),
    gradientSubtract: compute("gradient-subtract", layouts.mixedRGBA, gradientSubtractWGSL, "main"),
    injectDye: compute("inject-dye", layouts.oneInRGBA, dyeWGSL, "main"),
    display: device.createRenderPipeline({
      label: "display",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.display] }),
      vertex: { module: displayModule, entryPoint: "vs" },
      fragment: {
        module: displayModule,
        entryPoint: "fs",
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    }),
    tracerStep: device.createComputePipeline({
      label: "tracer-step",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.tracerStep] }),
      compute: {
        module: module("tracer-step", tracerStepWGSL),
        entryPoint: "main",
        // Pipeline-overridable constants rather than literals in the WGSL, so
        // the rake's geometry has one definition and it is the one the release
        // clock and the model are written against.
        constants: {
          laneCount: TRACER_LANE_COUNT,
          inletX: TRACER_INLET_X_M,
          exitMargin: TRACER_EXIT_MARGIN_M,
        },
      },
    }),
    tracerDots: device.createRenderPipeline({
      label: "tracer-dots",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.tracerDraw] }),
      vertex: {
        module: tracerModule,
        entryPoint: "vs",
        constants: { dotRadius: TRACER_RADIUS_M, fadeInSeconds: TRACER_FADE_IN_SECONDS },
      },
      fragment: {
        module: tracerModule,
        entryPoint: "fs",
        constants: { dotRadius: TRACER_RADIUS_M, fadeInSeconds: TRACER_FADE_IN_SECONDS },
        targets: [
          {
            format: canvasFormat,
            // Straight alpha blending, so the antialiased rim of a dot melts
            // into the field instead of cutting a hard square out of it. The
            // target's own alpha is left at 1: the canvas is opaque, and a dot
            // that punched a hole in it would show the page through the field.
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    }),
  };
}

/**
 * Whether a paused frame needs compute work, comparing same-length uniforms.
 *
 * Exact comparison is what is wanted here: these are the same values packed by
 * the same code from the same Properties, so anything that moved at all moved
 * because the learner moved it.
 */
function pausedInputsEqual(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) {
    // dt changes when entering pause. Display mode and scale only affect the
    // render pass; time and tracer release advance only during positive dt.
    // Tracer visibility clears its buffer independently in advanceTracers().
    if (
      i === UNIFORM_OFFSETS.dt ||
      i === UNIFORM_OFFSETS.visualization ||
      i === UNIFORM_OFFSETS.velocityScale ||
      i === UNIFORM_OFFSETS.time ||
      i === UNIFORM_OFFSETS.tracerEmitBatch
    ) {
      continue;
    }
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Decodes one IEEE 754 half-precision float, as stored in rgba16float textures. */
function decodeHalfFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) {
    return sign * fraction * 2 ** -24;
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : Number.NaN;
  }
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}
