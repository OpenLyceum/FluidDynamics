/**
 * webgpuSupport.ts
 *
 * Feature detection and device acquisition for the WebGPU fluid solver.
 *
 * WebGPU is only available in recent browsers, and even there an adapter can be
 * refused (no compatible GPU, blocklisted driver, headless CI). Every caller
 * therefore gets a discriminated result rather than a throwing API, and the
 * simulation degrades to a "not supported" message instead of failing to boot.
 *
 * ── One device, many screens ──────────────────────────────────────────────────
 * A GPUDevice is expensive and shareable: GPU resources created from it can be
 * used by any number of canvases. Both the Intro and Lab screens therefore await
 * the SAME cached promise; only per-screen resources (textures, canvas contexts)
 * are duplicated.
 *
 * ── Why no console output ─────────────────────────────────────────────────────
 * `noConsole` is an error inside src/, and a console message would be invisible
 * to the learner anyway. Failures are reported as a `GpuUnavailableReason` code,
 * which the view maps to a localized string.
 */

import { TinyEmitter } from "scenerystack/axon";

/**
 * Why WebGPU could not be used. These are codes, not messages — the view maps
 * them to localized strings via StringManager.
 */
export type GpuUnavailableReason =
  /** `navigator.gpu` is missing entirely (older browser, non-secure context, jsdom/happy-dom). */
  | "noWebGPU"
  /** `requestAdapter()` resolved to null — no compatible or permitted GPU. */
  | "noAdapter"
  /** `requestDevice()` rejected, or the returned device was immediately unusable. */
  | "noDevice"
  /** The device was lost after a successful start (driver reset, tab backgrounded too long, OOM). */
  | "deviceLost";

/** Result of attempting to acquire a device. */
export type GpuAcquisition =
  | { readonly available: true; readonly device: GPUDevice }
  | { readonly available: false; readonly reason: GpuUnavailableReason };

/**
 * Fires when a previously-acquired device is lost. Engines listen so they can
 * stop issuing commands and let their view swap in the unavailable message.
 */
export const deviceLostEmitter = new TinyEmitter();

/** Cached acquisition, so repeated calls (one per screen) share a single device. */
let acquisitionPromise: Promise<GpuAcquisition> | null = null;

/**
 * Acquires (or returns the cached) GPUDevice for the fluid solver.
 *
 * Never rejects: every failure path resolves to `{ available: false, reason }`.
 */
export function acquireFluidDevice(): Promise<GpuAcquisition> {
  acquisitionPromise ??= requestDevice();
  return acquisitionPromise;
}

/**
 * Discards the cached acquisition so the next call retries from scratch.
 * Called on device loss; also keeps unit tests independent of each other.
 */
function resetFluidDeviceCache(): void {
  acquisitionPromise = null;
}

/**
 * Reads `navigator.gpu` defensively.
 *
 * The @webgpu/types declaration merges `gpu: GPU` onto `Navigator` as a required
 * property, which is a lie in every environment that matters here (happy-dom,
 * Firefox on some platforms, any pre-2023 browser). Both the navigator and the
 * property are therefore treated as possibly absent.
 */
function getGPU(): GPU | undefined {
  const nav: Navigator | undefined = globalThis.navigator;
  if (nav === undefined) {
    return undefined;
  }
  const gpu: GPU | undefined = nav.gpu;
  return gpu;
}

async function requestDevice(): Promise<GpuAcquisition> {
  const gpu = getGPU();
  if (gpu === undefined) {
    return { available: false, reason: "noWebGPU" };
  }

  let adapter: GPUAdapter | null;
  try {
    // "high-performance" asks for the discrete GPU on dual-GPU machines; the
    // solver is fill-rate bound and benefits, and falling back is automatic.
    adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    return { available: false, reason: "noAdapter" };
  }
  if (adapter === null) {
    return { available: false, reason: "noAdapter" };
  }

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ label: "fluid-dynamics-device" });
  } catch {
    return { available: false, reason: "noDevice" };
  }

  // `device.lost` resolves (never rejects) when the device becomes unusable.
  // Drop the cache so a later screen can retry, and let engines tear down.
  device.lost.then(() => {
    resetFluidDeviceCache();
    deviceLostEmitter.emit();
  });

  return { available: true, device };
}
