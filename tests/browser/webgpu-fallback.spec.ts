/** The field announces a startup failure even when a GPU device was acquired. */
import { expect, test } from "@playwright/test";

test("shows the unavailable message when the acquired device has no canvas context", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", {
      value: {
        requestAdapter: async () => ({
          requestDevice: async () => ({ lost: new Promise<GPUDeviceLostInfo>(() => undefined) }),
        }),
      },
    });
    const canvasPrototype = HTMLCanvasElement.prototype;
    canvasPrototype.getContext = new Proxy(canvasPrototype.getContext, {
      apply: (getContext, canvas, args) => (args[0] === "webgpu" ? null : Reflect.apply(getContext, canvas, args)),
    });
  });

  await page.goto("/?screens=1&locale=en");
  await expect(
    page.getByText("The graphics device could not be started, so the flow cannot be computed.", { exact: true }),
  ).toBeVisible();
});
