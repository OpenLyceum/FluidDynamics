/**
 * Engine integration test — does the solver actually behave like a fluid?
 *
 * The whole fluid state lives in GPU textures, so none of it is reachable from
 * Vitest. This test drives the real engine in a real browser through
 * tests/harness/engine.html (served and transpiled by the Vite dev server), runs
 * actual compute passes, and reads the rendered frame back with
 * WebGPUFluidEngine.readDisplayPixels().
 *
 * ── Requirements ──────────────────────────────────────────────────────────────
 * A WebGPU adapter. Chromium needs `--enable-unsafe-webgpu --enable-features=Vulkan`
 * on Linux; playwright.config.ts passes them. Where no adapter is available the
 * tests skip rather than fail, since that is also the configuration in which the
 * sim correctly shows its "WebGPU is not available" message.
 *
 * Presentation is disabled in the harness: some headless environments lose the
 * device the moment a WebGPU canvas is presented, while compute and offscreen
 * rendering work correctly.
 */

import { expect, type Page, test } from "@playwright/test";

const WIDTH = 2048;
const HEIGHT = 1024;

/** One rendered frame, with pixel access in the field's own orientation. */
class Frame {
  private readonly bytes: Uint8Array;
  private readonly redOffset: number;
  private readonly blueOffset: number;

  public constructor(bytes: number[], format: string) {
    this.bytes = Uint8Array.from(bytes);
    // getPreferredCanvasFormat is bgra8unorm on most desktops, so channel order
    // cannot be assumed.
    this.redOffset = format === "bgra8unorm" ? 2 : 0;
    this.blueOffset = format === "bgra8unorm" ? 0 : 2;
  }

  /**
   * @param u - 0 at the inflow edge, 1 at the outflow edge
   * @param v - 0 at the bottom wall, 1 at the top wall
   */
  public at(u: number, v: number): { r: number; g: number; b: number } {
    const x = Math.min(WIDTH - 1, Math.max(0, Math.round(u * (WIDTH - 1))));
    // Row 0 of the readback is the top of the image, which is v = 1.
    const y = Math.min(HEIGHT - 1, Math.max(0, Math.round((1 - v) * (HEIGHT - 1))));
    const i = (y * WIDTH + x) * 4;
    return {
      r: this.bytes[i + this.redOffset] ?? 0,
      g: this.bytes[i + 1] ?? 0,
      b: this.bytes[i + this.blueOffset] ?? 0,
    };
  }

  public brightness(u: number, v: number): number {
    const { r, g, b } = this.at(u, v);
    return (r + g + b) / 3;
  }

  /** Mean brightness down a vertical line, used to find where the wake is. */
  public columnBrightness(u: number, samples = 64): number {
    let total = 0;
    for (let i = 0; i < samples; i++) {
      total += this.brightness(u, (i + 0.5) / samples);
    }
    return total / samples;
  }

  /**
   * Pixels brighter than a threshold, optionally only where `region` says.
   *
   * How the tracer dots are found: their core is near-white, well above
   * anything the dye colours, the colour ramps or the obstacle's rim reach, so
   * counting bright pixels over a region answers "is there a dot here?" without
   * having to guess exactly where one landed.
   */
  public countBrighterThan(threshold: number, region?: (u: number, v: number) => boolean): number {
    let count = 0;
    for (let y = 0; y < HEIGHT; y++) {
      // Row 0 of the readback is the top of the image, which is v = 1.
      const v = 1 - y / (HEIGHT - 1);
      for (let x = 0; x < WIDTH; x++) {
        const i = (y * WIDTH + x) * 4;
        const total = (this.bytes[i] ?? 0) + (this.bytes[i + 1] ?? 0) + (this.bytes[i + 2] ?? 0);
        if (total / 3 > threshold && (region === undefined || region(x / (WIDTH - 1), v))) {
          count++;
        }
      }
    }
    return count;
  }
}

/**
 * Brightness no field, ramp or obstacle rim reaches, but the white core of a
 * tracer dot passes comfortably. The brightest thing otherwise on screen is the
 * top of the sequential speed ramp; the dye view, used by the tracer tests, is
 * far below it.
 */
const TRACER_BRIGHTNESS = 230;

type Harness = {
  start: (resolution?: string) => Promise<{ ok: boolean; reason?: string; format?: string }>;
  run: (steps: number, dt: number, overrides?: Record<string, unknown>) => { running: boolean; time: number };
  pixels: () => Promise<number[]>;
  velocity: () => Promise<{ width: number; height: number; uv: number[] }>;
  reset: () => void;
  dispose: () => void;
};

declare global {
  interface Window {
    harness: Harness;
    harnessReady?: boolean;
  }
}

async function startEngine(page: Page): Promise<string | null> {
  await page.goto("/tests/harness/engine.html");
  await page.waitForFunction(() => window.harnessReady === true, null, { timeout: 30_000 });
  const result = await page.evaluate(() => window.harness.start());
  return result.ok ? (result.format ?? "rgba8unorm") : null;
}

async function render(page: Page, format: string, steps: number, overrides: Record<string, unknown>): Promise<Frame> {
  const status = await page.evaluate(
    ([s, o]) => window.harness.run(s as number, 1 / 60, o as Record<string, unknown>),
    [steps, overrides] as const,
  );
  expect(status.running, "the device survived the run").toBe(true);
  return new Frame(await page.evaluate(() => window.harness.pixels()), format);
}

test.describe("WebGPU fluid engine", () => {
  // The solver runs hundreds of steps per case; the default 30 s is not enough
  // on a software rasterizer. The per-frame dispatch count now varies with the
  // viscosity (the viscous solve schedules its own sweeps), so this is budgeted
  // for the stiff end of the range rather than tuned to the wire.
  test.setTimeout(360_000);

  test("dye is carried downstream and around a cylinder", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    const frame = await render(page, format, 240, { inflowSpeed: 1, viscosity: 1e-3 });

    // Dye is injected at the inflow, so the upstream edge must be coloured.
    expect(frame.brightness(0.02, 0.5), "dye at the inflow").toBeGreaterThan(20);

    // …and advection must have carried it well past the obstacle.
    expect(frame.brightness(0.85, 0.2), "dye downstream").toBeGreaterThan(20);

    // The obstacle is drawn as a dark solid body at the centre of the channel.
    const body = frame.brightness(0.25, 0.5);
    const beside = frame.brightness(0.25, 0.1);
    expect(body, "the obstacle is darker than the free stream").toBeLessThan(beside);
  });

  test("the wake is steady at low Reynolds number and unsteady at high", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    // This is the sim's central claim, so it is the thing most worth pinning:
    // below the shedding threshold the wake settles to a steady state and stops
    // changing, and above it the vortex street makes the wake change forever.
    //
    // Measured directly as how much the picture moves between two frames a third
    // of a second apart, in the vorticity view — which isolates the wake from
    // the uniform free stream around it.
    const unsteadiness = async (settleSteps: number, overrides: Record<string, unknown>): Promise<number> => {
      const before = await render(page, format, settleSteps, { ...overrides, visualization: 2 });
      const after = await render(page, format, 20, { ...overrides, visualization: 2 });

      let total = 0;
      let samples = 0;
      // The wake region: downstream of the obstacle, spanning the channel.
      for (let i = 0; i <= 20; i++) {
        const u = 0.35 + i * 0.03;
        for (let j = 0; j <= 10; j++) {
          const v = 0.25 + j * 0.05;
          total += Math.abs(before.brightness(u, v) - after.brightness(u, v));
          samples++;
        }
      }
      return total / samples;
    };

    // Re ≈ 4.5, firmly in the creeping regime. Long enough to settle: at
    // 0.3 m/s the fluid crosses the 2 m channel in about 7 seconds.
    await page.evaluate(() => window.harness.reset());
    const steady = await unsteadiness(360, { inflowSpeed: 0.3, viscosity: 1e-2 });

    // Re ≈ 150, well past the shedding threshold.
    await page.evaluate(() => window.harness.reset());
    const shedding = await unsteadiness(360, { inflowSpeed: 1, viscosity: 1e-3 });

    expect(steady, "the low-Reynolds wake has settled").toBeLessThan(3);
    expect(shedding, "the vortex street keeps the wake moving").toBeGreaterThan(steady * 3);
  });

  test("reset returns the field to a channel with no dye", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    const before = await render(page, format, 120, { inflowSpeed: 1 });
    expect(before.columnBrightness(0.6), "dye reached mid-channel").toBeGreaterThan(10);

    await page.evaluate(() => window.harness.reset());
    // A single zero-length step re-renders without advancing the fluid.
    const after = await render(page, format, 1, { inflowSpeed: 1 });

    // Only the freshly injected inflow strip should carry dye.
    expect(after.columnBrightness(0.6), "downstream is clear after reset").toBeLessThan(
      before.columnBrightness(0.6) / 2,
    );
  });

  test("every visualization mode renders something", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    await render(page, format, 240, { inflowSpeed: 1 });

    for (const visualization of [0, 1, 2, 3]) {
      const frame = await render(page, format, 1, { inflowSpeed: 1, visualization });
      // Every mode must put non-background colour somewhere in the wake region.
      const wake = frame.columnBrightness(0.45);
      expect(wake, `visualization ${visualization} is not blank`).toBeGreaterThan(2);
    }
  });

  test("every obstacle shape blocks the flow", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    // Shape codes come from ObstacleShape.ts: 1 cylinder, 2 plate, 3 airfoil.
    // The plate runs broadside — the pose this test was written for — and the
    // airfoil at its default 8° tilt; the cylinder ignores the angle entirely.
    const DEG = Math.PI / 180;
    const cases = [
      { shape: 1, angle: 0 },
      { shape: 2, angle: 90 * DEG },
      { shape: 3, angle: 8 * DEG },
    ];
    for (const { shape, angle } of cases) {
      await page.evaluate(() => window.harness.reset());
      const frame = await render(page, format, 180, {
        inflowSpeed: 1,
        obstacleShape: shape,
        obstacleAngle: angle,
        visualization: 1,
      });

      // In the speed view the body is dark (no-slip) and the flow accelerating
      // past its shoulders is bright.
      const body = frame.brightness(0.25, 0.5);
      const shoulder = frame.brightness(0.25, 0.62);
      expect(shoulder, `shape ${shape} accelerates the flow past it`).toBeGreaterThan(body);
    }
  });

  test("tilting the flat plate changes how much it blocks the flow", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    // The same plate, at the two ends of the angle slider's story: lying along
    // the flow at 0° it is a streamlined sliver; broadside at 90° it is a baffle.
    const renderPose = async (angle: number): Promise<Frame> => {
      await page.evaluate(() => window.harness.reset());
      return render(page, format, 180, {
        inflowSpeed: 1,
        obstacleShape: 2,
        obstacleAngle: angle,
        visualization: 1,
      });
    };
    const aligned = await renderPose(0);
    const broadside = await renderPose(Math.PI / 2);

    // Geometry: half a plate-height above the centre is inside the solid when
    // the plate stands broadside and open fluid when it lies along the flow.
    expect(broadside.brightness(0.25, 0.545), "the broadside plate covers its shoulder line").toBeLessThan(
      aligned.brightness(0.25, 0.545),
    );

    // Stagnation: just upstream of the broadside face the flow is piled up and
    // slow (dark in the speed view); there it slips past the aligned sliver at
    // close to the free-stream speed.
    expect(broadside.brightness(0.225, 0.56), "the broadside face stalls the flow ahead of it").toBeLessThan(
      aligned.brightness(0.225, 0.56),
    );

    // Venturi: what does get past the broadside plate squeezes through the gaps
    // at its tips and accelerates above the free stream; above the aligned
    // plate the flow is undisturbed.
    expect(broadside.brightness(0.25, 0.62), "the broadside plate jets flow past its tips").toBeGreaterThan(
      aligned.brightness(0.25, 0.62),
    );
  });

  test("tilting the airfoil deflects the flow the way lift does", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    // At a shedding Reynolds number the wake flaps, and one velocity snapshot
    // says more about the phase of the flapping than about the deflection. So
    // this runs in creeping flow (Re = U·D/ν = 1 · 0.15 / 0.05 = 3), where the
    // wake is steady and the mean vertical velocity downstream of the wing is
    // exactly the flow deflection: nose up (positive angle of attack) pushes
    // fluid down behind the wing, nose down pushes it up, and the flat wing at
    // 0° deflects nothing. The velocity field is read directly because the
    // rendered frame encodes speed but not direction.
    type VelocityField = { width: number; height: number; uv: number[] };

    const runPose = async (angle: number): Promise<VelocityField> => {
      await page.evaluate(() => window.harness.reset());
      const status = await page.evaluate(
        ([s, o]) => window.harness.run(s as number, 1 / 60, o as Record<string, unknown>),
        [
          420,
          {
            inflowSpeed: 1,
            viscosity: 0.05,
            obstacleShape: 3,
            obstacleAngle: angle,
          },
        ] as const,
      );
      expect(status.running, "the device survived the run").toBe(true);
      return page.evaluate(() => window.harness.velocity());
    };

    // Mean v in a box downstream of the wing (x 0.65–0.95 m, y 0.35–0.65 m).
    const meanVerticalVelocity = (field: VelocityField): number => {
      let sum = 0;
      let count = 0;
      for (let y = 0; y < field.height; y++) {
        const yMetres = (y + 0.5) / field.height;
        if (yMetres < 0.35 || yMetres > 0.65) {
          continue;
        }
        for (let x = 0; x < field.width; x++) {
          const xMetres = ((x + 0.5) / field.width) * 2;
          if (xMetres < 0.65 || xMetres > 0.95) {
            continue;
          }
          sum += field.uv[2 * (y * field.width + x) + 1] ?? 0;
          count++;
        }
      }
      return sum / count;
    };

    const DEG = Math.PI / 180;
    const downwash = meanVerticalVelocity(await runPose(30 * DEG));
    const flat = meanVerticalVelocity(await runPose(0));
    const upwash = meanVerticalVelocity(await runPose(-30 * DEG));

    expect(flat, "the untilted wing deflects nothing").toBeCloseTo(0, 3);
    expect(downwash, "nose up pushes the flow down behind the wing").toBeLessThan(flat);
    expect(upwash, "nose down pushes the flow up behind the wing").toBeGreaterThan(flat);
  });

  test("the largest obstacle the size slider allows leaves the solver finite", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    // The top of the size slider nearly blocks the channel: a 0.8 m body in a
    // 1 m one forces the whole inflow through two 0.1 m gaps, where continuity
    // accelerates it well past the free-stream speed. That is real physics
    // (the Venturi effect), but it is also the stiffest geometry the slider can
    // ask for, so the velocity field must stay finite and the device alive —
    // for every shape, since each spans the flow differently at that size.
    // The centre is the one the model's resize clamp would pick: pinned near
    // mid-height, the only place the largest body fits. Each shape runs at its
    // most blocking pose — the plate broadside, the airfoil at its default tilt.
    const DEG = Math.PI / 180;
    const cases = [
      { shape: 1, angle: 0 },
      { shape: 2, angle: 90 * DEG },
      { shape: 3, angle: 8 * DEG },
    ];
    type VelocityField = { width: number; height: number; uv: number[] };

    const runSteps = async (steps: number, overrides: Record<string, unknown>): Promise<void> => {
      const status = await page.evaluate(
        ([s, o]) => window.harness.run(s as number, 1 / 60, o as Record<string, unknown>),
        [steps, overrides] as const,
      );
      expect(status.running, "the device survived the run").toBe(true);
    };

    for (const { shape, angle } of cases) {
      await page.evaluate(() => window.harness.reset());
      await runSteps(240, {
        inflowSpeed: 1,
        obstacleShape: shape,
        obstacleAngle: angle,
        obstacleRadius: 0.4,
        obstacleCenterX: 0.5,
        obstacleCenterY: 0.5,
      });

      const field: VelocityField = await page.evaluate(() => window.harness.velocity());
      let maxSpeed = 0;
      let nonFinite = 0;
      for (let i = 0; i < field.uv.length; i += 2) {
        const u = field.uv[i] ?? 0;
        const v = field.uv[i + 1] ?? 0;
        if (!(Number.isFinite(u) && Number.isFinite(v))) {
          nonFinite++;
        } else {
          maxSpeed = Math.max(maxSpeed, Math.hypot(u, v));
        }
      }

      expect(nonFinite, `shape ${shape} keeps the velocity field finite`).toBe(0);
      // Venturi peaks of several times the inflow are expected in the gaps;
      // tens of m/s would mean the projection has lost its grip.
      expect(maxSpeed, `shape ${shape} shows no runaway acceleration`).toBeLessThan(20);
    }
  });

  test("with no obstacle the flow stays uniform across the channel", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    const frame = await render(page, format, 240, { inflowSpeed: 1, obstacleShape: 0, visualization: 1 });

    // Speed view: with nothing to flow around, every column reads the same.
    const centre = frame.brightness(0.5, 0.5);
    for (const v of [0.25, 0.35, 0.65, 0.75]) {
      expect(Math.abs(frame.brightness(0.5, v) - centre), `uniform at v=${v}`).toBeLessThan(20);
    }
  });

  test("changing the flow speed never reverses the outflow", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    // The outflow boundary models a reservoir the channel empties into: fluid
    // may leave, but the reservoir never pushes it back in. Reversal at the
    // right edge after a speed change is what a step change of the Dirichlet
    // inflow used to do here: the incompressible pressure solve answered
    // globally and instantly, and the transient reflected off the p = 0 outflow
    // until the whole column sloshes backward at up to several times the *old*
    // speed. The inflow ramp (inflowRamp.ts), the settling pressure boost, and
    // the outflow's downstream clamp exist to prevent exactly that, so this
    // test measures the velocity field itself — the rendered frame encodes
    // speed but not direction — as the most negative u in the rightmost band of
    // the channel, sampled through the second after the slider jumps.
    type VelocityField = { width: number; height: number; uv: number[] };

    const sample = async (): Promise<VelocityField> => page.evaluate(() => window.harness.velocity());

    // Deliberately not render(): this test reads the velocity field, not the
    // frame, and skipping the 8 MB pixel readback per burst is what keeps it
    // inside the suite's time budget on a software adapter.
    const runSteps = async (steps: number, overrides: Record<string, unknown>): Promise<void> => {
      const status = await page.evaluate(
        ([s, o]) => window.harness.run(s as number, 1 / 60, o as Record<string, unknown>),
        [steps, overrides] as const,
      );
      expect(status.running, "the device survived the run").toBe(true);
    };

    const minimumOutflowU = (field: VelocityField): number => {
      let minimum = Infinity;
      for (let y = 0; y < field.height; y++) {
        for (let x = field.width - 12; x < field.width; x++) {
          minimum = Math.min(minimum, field.uv[2 * (y * field.width + x)] ?? 0);
        }
      }
      return minimum;
    };

    /** Solver steps after the jump at which the outflow is sampled. */
    const SAMPLES = [4, 12, 30, 70];

    /**
     * Develops a flow at `from` m/s, then jumps the inflow to `to` m/s and
     * reports the worst reversal in the outflow band over the next ~1.2 s —
     * the window in which the unfixed solver's backward slosh peaked.
     */
    const jump = async (from: number, to: number, obstacleShape: number, warmup: number): Promise<number> => {
      await page.evaluate(() => window.harness.reset());
      await runSteps(warmup, { inflowSpeed: from, viscosity: 1e-3, obstacleShape });

      let worst = minimumOutflowU(await sample());
      let at = 0;
      for (const target of SAMPLES) {
        await runSteps(target - at, { inflowSpeed: to, viscosity: 1e-3, obstacleShape });
        at = target;
        worst = Math.min(worst, minimumOutflowU(await sample()));
      }
      return worst;
    };

    // With no obstacle in the channel any leftward velocity is a pure boundary
    // artifact. With the cylinder, shed vortices crossing the outlet plane
    // legitimately carry patches of backward flow, so the tolerance is looser —
    // but nothing like the several m/s of backward slosh the unfixed solver
    // produced on the slow-down, which is the case this test exists for.
    const bareUp = await jump(0.3, 3, 0, 150);
    const bareDown = await jump(3, 0.3, 0, 150);
    const cylinderDown = await jump(3, 0.3, 1, 240);

    expect(bareUp, "no reversal after speeding up").toBeGreaterThan(-0.3);
    expect(bareDown, "no reversal after slowing down").toBeGreaterThan(-0.3);
    expect(cylinderDown, "no unphysical reversal past the cylinder after slowing down").toBeGreaterThan(-1.0);
  });

  test("dragging while paused paints dye without disturbing the velocity field", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    // FluidFieldNode keeps submitting frames while the sim is paused, with
    // dt = 0 and whatever pointer state the last drag event left behind. Dye
    // injection is position-driven and must keep working; the velocity impulse
    // divides the per-frame delta by dt, which a paused frame does not have.
    // Before forces.wgsl skipped the impulse at dt = 0, a 5 mm drag held for a
    // second while paused injected ~5000 m/s on every frame, overflowed the
    // half-float velocity field to NaN, and left the whole grid permanently
    // non-finite once the sim resumed — invisible until play was pressed,
    // because dt = 0 also freezes the dye.
    type VelocityField = { width: number; height: number; uv: number[] };

    const runSteps = async (steps: number, dt: number, overrides: Record<string, unknown>): Promise<void> => {
      const status = await page.evaluate(
        ([s, d, o]) => window.harness.run(s as number, d as number, o as Record<string, unknown>),
        [steps, dt, overrides] as const,
      );
      expect(status.running, "the device survived the run").toBe(true);
    };

    const sampleVelocity = (): Promise<VelocityField> => page.evaluate(() => window.harness.velocity());

    const stats = (field: VelocityField): { maxSpeed: number; nonFinite: number } => {
      let maxSpeed = 0;
      let nonFinite = 0;
      for (let i = 0; i < field.uv.length; i += 2) {
        const u = field.uv[i] ?? 0;
        const v = field.uv[i + 1] ?? 0;
        if (!(Number.isFinite(u) && Number.isFinite(v))) {
          nonFinite++;
        } else {
          maxSpeed = Math.max(maxSpeed, Math.hypot(u, v));
        }
      }
      return { maxSpeed, nonFinite };
    };

    await runSteps(240, 1 / 60, { inflowSpeed: 1 });
    const before = stats(await sampleVelocity());
    expect(before.nonFinite, "the flowing field is finite").toBe(0);

    const beforeFrame = new Frame(await page.evaluate(() => window.harness.pixels()), format);

    // The paused branch of update(): one 5 mm drag, then the pointer held
    // still for 60 re-render frames at dt = 0.
    await runSteps(60, 0, {
      pointerActive: true,
      pointerX: 1.4,
      pointerY: 0.55,
      pointerDeltaX: 0.005,
      pointerDeltaY: 0,
    });

    const afterPaused = stats(await sampleVelocity());
    expect(afterPaused.nonFinite, "a paused drag injects no non-finite velocity").toBe(0);
    // Small drift from the projection re-converging is fine; the unfixed
    // impulse left a ~20 km/s jet here.
    expect(afterPaused.maxSpeed, "a paused drag adds no impulse").toBeLessThan(before.maxSpeed + 0.5);

    // The drag must still have painted dye under the pointer — the only thing
    // a dt = 0 frame is allowed to change. Count sampled pixels that moved by
    // more than a band's worth of colour anywhere in the frame: with the
    // pointer disc spanning ~160 px, thousands of samples change when the
    // injection works and only the inflow strip's re-mix (colour-identical at
    // a frozen time) when it does not.
    const afterFrame = new Frame(await page.evaluate(() => window.harness.pixels()), format);
    let changed = 0;
    for (let i = 0; i <= WIDTH; i += 2) {
      for (let j = 0; j <= HEIGHT; j += 2) {
        const u = i / WIDTH;
        const v = j / HEIGHT;
        const a = beforeFrame.at(u, v);
        const b = afterFrame.at(u, v);
        if (Math.abs(a.r - b.r) > 40 || Math.abs(a.g - b.g) > 40 || Math.abs(a.b - b.b) > 40) {
          changed++;
        }
      }
    }
    expect(changed, "dye was injected at the pointer while paused").toBeGreaterThan(300);

    // And resuming must inherit a healthy field, not a delayed explosion.
    await runSteps(60, 1 / 60, {});
    const afterResume = stats(await sampleVelocity());
    expect(afterResume.nonFinite, "the field is still finite a second after resuming").toBe(0);
    expect(afterResume.maxSpeed, "no lingering explosion after resuming").toBeLessThan(5);
  });

  test("tracer dots are released at the inlet and carried out of the channel", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    // Nothing in the dye view is this bright on its own, so any bright pixel is
    // a dot. Checked first, because the rest of the test rests on it.
    const withoutDots = await render(page, format, 120, { inflowSpeed: 1, obstacleShape: 0 });
    expect(withoutDots.countBrighterThan(TRACER_BRIGHTNESS), "the field alone has no near-white pixels").toBe(0);

    // u < 0.45, not 0.3: a freshly released column takes 0.15 s to fade up to
    // TRACER_BRIGHTNESS, and at 1 m/s the previous column has by then crossed
    // u = 0.3 (columns are 0.56 m apart, 0.28 of the channel). A tight inlet
    // band therefore reads as "stopped releasing" whenever we sample during
    // that fade-in, which the 210-frame checkpoint does. 0.45 is still the
    // first half of the channel, well short of the downstream check.
    const upstream = (u: number): boolean => u < 0.45;
    const downstream = (u: number): boolean => u > 0.6;
    const inlet = (u: number): boolean => u < 0.08;

    // Half a second in, the columns released so far are still in the upstream
    // end: dots exist, and none has teleported downstream.
    await page.evaluate(() => window.harness.reset());
    const early = await render(page, format, 30, { inflowSpeed: 1, obstacleShape: 0, tracersVisible: true });
    expect(early.countBrighterThan(TRACER_BRIGHTNESS, upstream), "dots near the inlet").toBeGreaterThan(0);
    expect(early.countBrighterThan(TRACER_BRIGHTNESS, downstream), "nothing downstream yet").toBe(0);

    // Four seconds at 1 m/s is two channel widths, so the first columns have
    // left and later ones are spread across the whole channel.
    const later = await render(page, format, 210, { inflowSpeed: 1, obstacleShape: 0, tracersVisible: true });
    expect(later.countBrighterThan(TRACER_BRIGHTNESS, downstream), "dots have reached the far end").toBeGreaterThan(0);
    expect(later.countBrighterThan(TRACER_BRIGHTNESS, inlet), "and the inlet is still releasing").toBeGreaterThan(0);
  });

  test("tracer dots are never drawn on the obstacle", async ({ page }) => {
    const format = await startEngine(page);
    test.skip(format === null, "no WebGPU adapter available");
    if (format === null) {
      return;
    }

    // A dot that reaches the body is retired rather than advected into it: the
    // velocity inside a solid cell is zero, so a dot that got in would stall
    // there in plain sight, on top of a body it is supposed to be flowing past.
    const radius = 0.075;
    const frame = await render(page, format, 480, {
      inflowSpeed: 1,
      obstacleShape: 1,
      obstacleRadius: radius,
      tracersVisible: true,
    });

    // Tested as the disc it is rather than as a bounding box: the corners of a
    // box around the cylinder are outside it, and dots stream through them.
    //
    // The margin is TRACER_RADIUS_M (0.008 m) plus one cell of the standard
    // 256-wide grid (0.0078 m), because a dot resting *against* the body is
    // legitimate: the baked mask that retires it resolves the surface to a
    // cell, and the dot is drawn as a disc around its centre. Anything deeper
    // than that got inside and stalled. Written out rather than imported —
    // this suite runs under Playwright's own transpile and does not pull in
    // the sim's modules.
    const margin = 0.008 + 2 / 256;
    const insideBody = (u: number, v: number): boolean => Math.hypot(u * 2 - 0.5, v - 0.5) < radius - margin;

    expect(frame.countBrighterThan(TRACER_BRIGHTNESS), "dots are on screen at all").toBeGreaterThan(0);
    expect(frame.countBrighterThan(TRACER_BRIGHTNESS, insideBody), "no dot inside the body").toBe(0);
  });
});
