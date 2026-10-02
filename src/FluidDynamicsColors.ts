/**
 * FluidDynamicsColors.ts
 *
 * Defines all dynamic colors for the simulation using ProfileColorProperty.
 *
 * Each color has two profiles:
 *   - "default"   — used in standard (dark) mode
 *   - "projector" — used when the user enables Projector Mode in Preferences
 *
 * SceneryStack switches profiles automatically; no manual toggling is needed.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 * Import FluidDynamicsColors and pass properties directly to Node's fillProperty or
 * strokeProperty options:
 *
 *   import FluidDynamicsColors from "../../FluidDynamicsColors.js";
 *
 *   new Rectangle( 0, 0, 100, 50, {
 *     fillProperty: FluidDynamicsColors.backgroundColorProperty,
 *   });
 *
 * ── How to add a color ────────────────────────────────────────────────────────
 * Add a new ProfileColorProperty entry to the FluidDynamicsColors object below.
 * Always provide both "default" and "projector" values.
 */
import { ProfileColorProperty } from "scenerystack/scenery";
import FluidDynamicsNamespace from "./FluidDynamicsNamespace.js";

const FluidDynamicsColors = {
  /**
   * Background color for the simulation screen.
   * Deep navy in default mode; white in projector mode.
   */
  backgroundColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "background", {
    default: "#1a1a2e",
    projector: "#ffffff",
  }),

  /**
   * Primary accent color for highlights, selected items, and key UI elements.
   * Sky blue in default mode; dark navy in projector mode.
   */
  accentColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "accent", {
    default: "#4fc3f7",
    projector: "#1a1a2e",
  }),

  /**
   * Background fill for control panels and dialogs.
   * Deep blue in default mode; light gray in projector mode.
   */
  panelBackgroundColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "panelBackground", {
    default: "#16213e",
    projector: "#f5f5f5",
  }),

  /**
   * Border/stroke color for control panels and dialogs.
   * Teal-navy in default mode; medium gray in projector mode.
   */
  panelBorderColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "panelBorder", {
    default: "#0f3460",
    projector: "#999999",
  }),

  /**
   * Text color for labels, readouts, and general UI text.
   * Near-white in default mode; near-black in projector mode.
   */
  textColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "text", {
    default: "#e0e0e0",
    projector: "#1a1a1a",
  }),

  // ── Fluid field ──────────────────────────────────────────────────────────────
  // The two dye colors injected in alternating bands at the inflow. The
  // interface between them is what actually reveals the flow, so they must stay
  // clearly distinguishable — including for the most common colour-vision
  // deficiencies, hence a blue/orange pair rather than red/green.

  /** Dye injected in the odd bands at the inflow. */
  dyeColorAProperty: new ProfileColorProperty(FluidDynamicsNamespace, "dyeA", {
    default: "#38bdf8",
    projector: "#0369a1",
  }),

  /** Dye injected in the even bands at the inflow. */
  dyeColorBProperty: new ProfileColorProperty(FluidDynamicsNamespace, "dyeB", {
    default: "#fb923c",
    projector: "#c2410c",
  }),

  // ── Light control surfaces ───────────────────────────────────────────────────
  // White chrome (combo boxes, flat push buttons, editable input fields) stays light
  // in both profiles; its text stays dark. Same values in default and projector mode,
  // but defined here so every color lives in one themeable place.

  /** Fill of light control surfaces: combo-box button/list, editable input fields. */
  controlSurfaceColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "controlSurface", {
    default: "#ffffff",
    projector: "#ffffff",
  }),

  /** Fill of a disabled control surface (grayed-out editable input field). */
  controlSurfaceDisabledColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "controlSurfaceDisabled", {
    default: "#cccccc",
    projector: "#cccccc",
  }),

  /** Text on light control surfaces: combo items, flat-button labels, field values, preferences. */
  controlSurfaceTextColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "controlSurfaceText", {
    default: "#1a1a1a",
    projector: "#1a1a1a",
  }),

  // ── Objects drawn over the field ─────────────────────────────────────────────
  // These sit on the dye field rather than on a panel, and the field's own colors
  // come from the display shader and do not follow the color profile. So these
  // are profile-invariant too — but they live here, not inline in a view, so
  // there is still one place to change them.

  /** Rim around a handle knob's dot, dark enough to read on both the body and bright dye. */
  handleKnobStrokeColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "handleKnobStroke", {
    default: "rgba(10, 11, 16, 0.85)",
    projector: "rgba(10, 11, 16, 0.85)",
  }),

  /** Body of the toolbox's ruler icon, matching the ruler the icon takes out. */
  rulerIconFillColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "rulerIconFill", {
    default: "#ece171",
    projector: "#ece171",
  }),

  /** Outline and tick marks on the toolbox's ruler icon. */
  rulerIconStrokeColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "rulerIconStroke", {
    default: "#000000",
    projector: "#000000",
  }),

  /**
   * Flat dark body of the obstacle on the home-screen icons.
   *
   * Matches the body colour display.wgsl paints. The shader does not follow the
   * color profile, so the icon stops stay the same in both profiles too.
   */
  obstacleBodyColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "obstacleBody", {
    default: "#1a1c29",
    projector: "#1a1c29",
  }),

  /** Light rim at the obstacle surface on the home-screen icons, matching display.wgsl. */
  obstacleRimColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "obstacleRim", {
    default: "#9ea8bd",
    projector: "#9ea8bd",
  }),

  /**
   * Fully transparent fill for the obstacle handles' hit areas. Transparent
   * rather than invisible: an invisible Node leaves the parallel DOM and can be
   * neither focused nor hit-tested.
   */
  hitAreaColorProperty: new ProfileColorProperty(FluidDynamicsNamespace, "hitArea", {
    default: "rgba(0,0,0,0)",
  }),
};

export default FluidDynamicsColors;
