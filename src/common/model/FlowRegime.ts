/**
 * FlowRegime.ts
 *
 * Classification of flow past a bluff body by Reynolds number.
 *
 * The four regimes below are the textbook stages of flow past a circular
 * cylinder, and they are what this simulation exists to show. The numeric
 * thresholds live in FluidDynamicsConstants.ts with every other named number;
 * this file owns only the vocabulary and the classification rule.
 *
 * A TypeScript `enum` is not usable here: tsconfig sets `erasableSyntaxOnly`.
 */

import { RE_SEPARATION, RE_SHEDDING_ONSET, RE_TURBULENT_ONSET } from "../../FluidDynamicsConstants.js";

/**
 * Flow regimes, ordered by increasing Reynolds number.
 * @internal Exported for unit tests; not part of the application API.
 */
export const FLOW_REGIMES = ["creeping", "steadyWake", "vortexShedding", "turbulent"] as const;

export type FlowRegime = (typeof FLOW_REGIMES)[number];

/**
 * Classifies a Reynolds number into the regime the learner should see.
 *
 * Boundaries are exclusive-below / inclusive-at: exactly RE_SHEDDING_ONSET is
 * already "vortexShedding", matching the convention that the named value is
 * where the new behaviour begins.
 */
export function classifyFlowRegime(reynoldsNumber: number): FlowRegime {
  if (reynoldsNumber < RE_SEPARATION) {
    return "creeping";
  }
  if (reynoldsNumber < RE_SHEDDING_ONSET) {
    return "steadyWake";
  }
  if (reynoldsNumber < RE_TURBULENT_ONSET) {
    return "vortexShedding";
  }
  return "turbulent";
}

/**
 * Reynolds number Re = U·D/ν for flow of speed U past a body of diameter D in a
 * fluid of kinematic viscosity ν.
 *
 * Returns Infinity for ν = 0 — an inviscid fluid has no finite Reynolds number,
 * and Infinity classifies as "turbulent", which is the honest visual answer.
 */
export function computeReynoldsNumber(flowSpeed: number, obstacleDiameter: number, kinematicViscosity: number): number {
  return (flowSpeed * obstacleDiameter) / kinematicViscosity;
}
