/**
 * WebGPUUnavailableNode.ts
 *
 * Shown in place of the fluid field when a GPUDevice cannot be obtained.
 *
 * The solver runs entirely in WGSL compute shaders, so there is no meaningful
 * degraded rendering to fall back to — the honest thing is to say so, in the
 * learner's language, and explain what would fix it. The node is sized to the
 * field's bounds so the screen layout is identical whether or not WebGPU works.
 *
 * Its text is a DerivedProperty over both the failure reason and every localized
 * message, so switching language while the message is on screen re-translates it.
 */

import { DerivedProperty, type TReadOnlyProperty } from "scenerystack/axon";
import type { Bounds2 } from "scenerystack/dot";
import { type EmptySelfOptions, optionize } from "scenerystack/phet-core";
import { Node, type NodeOptions, Rectangle, RichText, Text, VBox } from "scenerystack/scenery";
import { PhetFont } from "scenerystack/scenery-phet";
import FluidDynamicsColors from "../../FluidDynamicsColors.js";
import {
  WEBGPU_MESSAGE_FONT_SIZE,
  WEBGPU_MESSAGE_MAX_WIDTH,
  WEBGPU_TITLE_FONT_SIZE,
} from "../../FluidDynamicsConstants.js";
import { StringManager } from "../../i18n/StringManager.js";
import { FluidDynamicsPanel } from "../FluidDynamicsPanel.js";
import type { GpuUnavailableReason } from "../gpu/webgpuSupport.js";

/** Spacing and margins of the "WebGPU unavailable" message panel, px. */
const MESSAGE_SPACING = 10;
const MESSAGE_X_MARGIN = 20;
const MESSAGE_Y_MARGIN = 16;

export type WebGPUUnavailableNodeOptions = NodeOptions;

export class WebGPUUnavailableNode extends Node {
  private readonly disposeWebGPUUnavailableNode: () => void;

  /**
   * @param reasonProperty - the failure code, or null while a device is still being acquired
   * @param fieldBounds - the view rectangle the fluid field would have occupied
   * @param providedOptions
   */
  public constructor(
    reasonProperty: TReadOnlyProperty<GpuUnavailableReason | null>,
    fieldBounds: Bounds2,
    providedOptions?: WebGPUUnavailableNodeOptions,
  ) {
    const webgpuStrings = StringManager.getInstance().getWebGPUStrings();

    // Resolve the reason code to a localized message. deriveAny is used rather
    // than the typed DerivedProperty overloads because the dependency list is
    // "the reason plus every message", and only one message is read per update.
    const messageProperty = DerivedProperty.deriveAny(
      [
        reasonProperty,
        webgpuStrings.noWebGPUStringProperty,
        webgpuStrings.noAdapterStringProperty,
        webgpuStrings.noDeviceStringProperty,
        webgpuStrings.deviceLostStringProperty,
      ],
      () => {
        switch (reasonProperty.value) {
          case "noWebGPU":
            return webgpuStrings.noWebGPUStringProperty.value;
          case "noAdapter":
            return webgpuStrings.noAdapterStringProperty.value;
          case "noDevice":
            return webgpuStrings.noDeviceStringProperty.value;
          case "deviceLost":
            return webgpuStrings.deviceLostStringProperty.value;
          case null:
            return "";
        }
      },
    );

    const titleText = new Text(webgpuStrings.unavailableTitleStringProperty, {
      font: new PhetFont({ size: WEBGPU_TITLE_FONT_SIZE, weight: "bold" }),
      fill: FluidDynamicsColors.textColorProperty,
      maxWidth: WEBGPU_MESSAGE_MAX_WIDTH,
    });

    // RichText wraps at maxWidth; Text would clip a multi-sentence message.
    const messageText = new RichText(messageProperty, {
      font: new PhetFont(WEBGPU_MESSAGE_FONT_SIZE),
      fill: FluidDynamicsColors.textColorProperty,
      lineWrap: WEBGPU_MESSAGE_MAX_WIDTH,
      maxWidth: WEBGPU_MESSAGE_MAX_WIDTH,
    });

    const panel = new FluidDynamicsPanel(
      new VBox({
        children: [titleText, messageText],
        spacing: MESSAGE_SPACING,
        align: "left",
      }),
      { xMargin: MESSAGE_X_MARGIN, yMargin: MESSAGE_Y_MARGIN },
    );
    panel.center = fieldBounds.center;

    // An outline where the field would have been, so the layout still reads as
    // "the simulation belongs here" rather than as empty space.
    const frame = new Rectangle(fieldBounds, {
      stroke: FluidDynamicsColors.panelBorderColorProperty,
      lineWidth: 1,
    });

    // Hidden while the device request is still in flight (reason === null), so a
    // successful start never flashes an error.
    const hasFailedProperty = DerivedProperty.valueNotEqualsConstant(reasonProperty, null);

    const options = optionize<WebGPUUnavailableNodeOptions, EmptySelfOptions, NodeOptions>()(
      {
        children: [frame, panel],
        // Screen readers get the same explanation sighted users see.
        //
        // `tagName` is required, not decorative: Scenery only creates a paragraph
        // sibling when the paragraph content is non-empty (PDOMPeer.orderElements),
        // and `messageProperty` is empty until a failure reason arrives. Without a
        // primary sibling to fall back on, getPlaceableSibling() asserts
        // "No placeable sibling found!" and the sim fails to launch.
        tagName: "div",
        accessibleParagraph: messageProperty,
        visibleProperty: hasFailedProperty,
      },
      providedOptions,
    );
    super(options);

    this.disposeWebGPUUnavailableNode = () => {
      messageText.dispose();
      titleText.dispose();
      hasFailedProperty.dispose();
      messageProperty.dispose();
    };
  }

  public override dispose(): void {
    this.disposeWebGPUUnavailableNode();
    super.dispose();
  }
}
