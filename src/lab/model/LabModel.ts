/**
 * LabModel.ts
 *
 * Model for the Lab screen: the same solver, with every parameter exposed.
 *
 * Identical in structure to IntroModel — the difference between the two screens
 * is entirely in which Properties the view builds controls for. Each screen owns
 * its own FluidModel instance (the fleet default), so changing the viscosity in
 * the Lab does not disturb the Intro screen's flow.
 */
import type { TModel } from "scenerystack/joist";
import { FluidModel } from "../../common/model/FluidModel.js";
import { TimeModel } from "../../common/TimeModel.js";
import { TIME_SPEED_MULTIPLIERS } from "../../FluidDynamicsConstants.js";
import type { FluidDynamicsPreferencesModel } from "../../preferences/FluidDynamicsPreferencesModel.js";

export class LabModel implements TModel {
  /**
   * Flow parameters. All of them are exposed to the learner on this screen.
   * Starts on the ellipse, which the handles can pull into any eccentricity —
   * including none, where it is the disk.
   */
  public readonly fluid = new FluidModel({ initialObstacleShape: "ellipse" });

  /** Play/pause and elapsed time. Starts playing — a paused fluid shows nothing. */
  public readonly timer = new TimeModel({ initiallyPlaying: true, timeSpeedMultipliers: TIME_SPEED_MULTIPLIERS });

  public constructor(preferences: FluidDynamicsPreferencesModel) {
    // Solver accuracy, vortex detail, dye fade and grid resolution are
    // preferences rather than screen controls, so the model subscribes to them
    // here instead of owning them.
    this.fluid.attachSolverQuality(preferences.highQualitySolverProperty);
    this.fluid.attachVorticity(preferences.vorticityProperty);
    this.fluid.attachDyeDissipation(preferences.dyeDissipationProperty);
    this.fluid.attachGridResolution(preferences.gridResolutionProperty);
  }

  public reset(): void {
    this.fluid.reset();
    this.timer.reset();
  }

  /** Advances the clock; the GPU solver is stepped from the view. */
  public step(dt: number): void {
    this.timer.step(dt);
  }

  public dispose(): void {
    this.timer.dispose();
    this.fluid.dispose();
  }
}
