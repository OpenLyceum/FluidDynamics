/**
 * FluidDynamicsScreenIcons.ts
 *
 * Programmatic home-screen / navigation-bar icons, drawn on the standard PhET
 * 548 × 373 canvas.
 *
 * Each icon shows the flow its screen is about: the Intro icon is the exact
 * potential-flow streamline pattern past a cylinder, and the Lab icon is the
 * same body shedding a Kármán vortex street. Both are hand-computed rather
 * than a rendered frame of the solver — an icon has to be legible at 40 px in
 * a navigation bar, which a real dye field is not, and rendering one would
 * mean spinning up a GPUDevice before the sim has started.
 *
 * The obstacle is filled with the same dark-body/light-rim ramp that
 * display.wgsl paints, so the icons match the field. Those shader colours are
 * profile-invariant, so the icon's are too; everything else follows the
 * ProfileColorProperties, including the dye colours of the lines themselves.
 */
import { Shape } from "scenerystack/kite";
import { Circle, Node, Path, RadialGradient, Rectangle } from "scenerystack/scenery";
import { ScreenIcon } from "scenerystack/sim";
import FluidDynamicsColors from "../FluidDynamicsColors.js";

const W = 548;
const H = 373;

/** Centre of the cylinder, matching the model's default obstacle position. */
const BODY_X = W * 0.3;
const BODY_Y = H * 0.5;
const BODY_R = H * 0.11;

function background(): Rectangle {
  return new Rectangle(0, 0, W, H, { fill: FluidDynamicsColors.backgroundColorProperty });
}

/**
 * The obstacle, filled the way display.wgsl paints it: a flat dark body
 * lifting to a light rim at the surface, and no outline stroke — a rim reads
 * as a surface, a stroke reads as a cartoon ball.
 */
function body(): Circle {
  const rim = new RadialGradient(BODY_X, BODY_Y, BODY_R * 0.6, BODY_X, BODY_Y, BODY_R)
    .addColorStop(0, FluidDynamicsColors.obstacleBodyColorProperty)
    .addColorStop(0.75, FluidDynamicsColors.obstacleBodyColorProperty)
    .addColorStop(1, FluidDynamicsColors.obstacleRimColorProperty);

  return new Circle(BODY_R, { centerX: BODY_X, centerY: BODY_Y, fill: rim });
}

function iconFrom(content: Node): ScreenIcon {
  return new ScreenIcon(content, {
    maxIconWidthProportion: 1,
    maxIconHeightProportion: 1,
    fill: FluidDynamicsColors.backgroundColorProperty,
  });
}

/**
 * One streamline of the exact potential flow past a cylinder, in units where
 * the free-stream speed is 1 and distances are measured from the body centre:
 * ψ(x, y) = y (1 − R² / (x² + y²)). `offset` is the streamline's far-field
 * distance from the centreline, signed — equal spacing in ψ is equal spacing
 * of the dye bands the sim injects.
 *
 * At each x the height is the root of ψ = |offset|, found by bisection: ψ is
 * 0 on the centreline and on the body surface, and strictly increasing in y
 * above the surface, so the root is unique and the search cannot slip inside
 * the body.
 *
 * `bulge` (Lab only) pushes the line that many pixels further from the
 * centreline through the wake, plateauing downstream — a shed wake blocks
 * more flow than the inviscid solution, and the outer streamlines splay
 * around it.
 */
function streamline(offset: number, bulge = 0): Path {
  const k = Math.abs(offset);
  const sign = Math.sign(offset);
  const steps = 140;
  const shape = new Shape();

  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * W;
    const dx = x - BODY_X;

    let lo = 0;
    let hi = k + 2 * BODY_R + H;
    for (let j = 0; j < 32; j++) {
      const y = (lo + hi) / 2;
      const psi = y * (1 - (BODY_R * BODY_R) / (dx * dx + y * y));
      if (psi < k) {
        lo = y;
      } else {
        hi = y;
      }
    }
    const y = (lo + hi) / 2 + bulge * (1 - Math.exp(-Math.max(0, dx - BODY_R) / (2.5 * BODY_R)));

    if (i === 0) {
      shape.moveTo(x, BODY_Y + sign * y);
    } else {
      shape.lineTo(x, BODY_Y + sign * y);
    }
  }

  return new Path(shape, {
    stroke: offset < 0 ? FluidDynamicsColors.dyeColorBProperty : FluidDynamicsColors.dyeColorAProperty,
    lineWidth: 5,
  });
}

/**
 * One vortex of the street: a logarithmic spiral whose arms tighten inward,
 * the way a rolled-up shear layer looks — an Archimedean spiral's even
 * spacing reads as a decorative curl, not a vortex.
 */
function vortex(centerX: number, centerY: number, radius: number, clockwise: boolean): Path {
  const shape = new Shape();
  const turns = 1.6;
  const shrink = 0.1; // radius at the innermost arm, as a fraction of `radius`
  const steps = 72;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Start at angle π so the outer arm trails upstream, towards the shear
    // layer that fed the vortex. Screen y grows downward, so a growing angle
    // is a clockwise winding.
    const angle = Math.PI + (clockwise ? 1 : -1) * t * turns * 2 * Math.PI;
    const r = radius * shrink ** t;
    const x = centerX + r * Math.cos(angle);
    const y = centerY + r * Math.sin(angle);

    if (i === 0) {
      shape.moveTo(x, y);
    } else {
      shape.lineTo(x, y);
    }
  }

  return new Path(shape, {
    stroke: clockwise ? FluidDynamicsColors.dyeColorAProperty : FluidDynamicsColors.dyeColorBProperty,
    lineWidth: 5,
    lineCap: "round",
  });
}

/** Intro: smooth, attached flow past a cylinder. */
export function createIntroIcon(): ScreenIcon {
  return iconFrom(
    new Node({
      children: [background(), ...[-3, -2, -1, 1, 2, 3].map((n) => streamline(n * BODY_R * 0.85)), body()],
    }),
  );
}

/** Lab: the same cylinder, now shedding a Kármán vortex street. */
export function createLabIcon(): ScreenIcon {
  const inflow = [-3, -2, 2, 3].map((n) => streamline(n * BODY_R * 0.85, BODY_R * 0.45));

  // Alternating sign, alternating side of the centreline — the defining
  // geometry of a vortex street. The vortices shrink downstream as their
  // circulation diffuses away, which is why the wake fades rather than
  // repeating forever.
  const SPACING = BODY_R * 2.75;
  const street = [0, 1, 2].map((i) => {
    const radius = BODY_R * 0.92 * 0.85 ** i;
    const x = BODY_X + BODY_R * 2.7 + SPACING * i;
    const y = BODY_Y + (i % 2 === 0 ? -1 : 1) * BODY_R * 0.95;
    return { x, y, radius, clockwise: i % 2 === 0 };
  });

  // The braid: the shear layer separating from the shoulder travels
  // downstream and rolls into the first vortex; between vortices it crosses
  // the centreline to feed the next one of the opposite row. Drawn as one
  // quadratic per vortex, from the shoulder (first) or just past the previous
  // vortex to the new vortex's outer arm.
  const braids: Path[] = [];
  let braidStart = { x: BODY_X + BODY_R * 0.45, y: BODY_Y - BODY_R * 0.9 };

  for (const v of street) {
    const controlX = (braidStart.x + v.x - v.radius) / 2;
    // Bowed gently towards the centreline, so the braid arrives at the arm
    // travelling with the vortex's winding rather than across it.
    const controlY = (braidStart.y + v.y) / 2 + (v.clockwise ? 1 : -1) * BODY_R * 0.2;

    const shape = new Shape()
      .moveTo(braidStart.x, braidStart.y)
      .quadraticCurveTo(controlX, controlY, v.x - v.radius * 0.98, v.y);

    braids.push(
      new Path(shape, {
        stroke: v.clockwise ? FluidDynamicsColors.dyeColorAProperty : FluidDynamicsColors.dyeColorBProperty,
        lineWidth: 4.5,
        lineCap: "round",
      }),
    );

    braidStart = { x: v.x + SPACING * 0.45, y: v.y };
  }

  const vortices = street.map((v) => vortex(v.x, v.y, v.radius, v.clockwise));

  return iconFrom(new Node({ children: [background(), ...inflow, ...braids, ...vortices, body()] }));
}
