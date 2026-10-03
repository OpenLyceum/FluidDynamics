/** The Lab's obstacle controls must disappear with the obstacle itself. */
import { expect, test } from "@playwright/test";

test("no obstacle removes its handle from keyboard interaction and restores it when selected again", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  // Freeze before the first animation frame, so a software adapter does not
  // accumulate solver work while this test exercises keyboard controls.
  await page.route("**/src/lab/model/LabModel.ts", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    expect(source).toContain("new TimeModel(true)");
    await route.fulfill({
      response,
      body: source.replace("new TimeModel(true)", "new TimeModel(false)"),
    });
  });
  // Like the engine harness, exercise WebGPU without canvas presentation:
  // headless Chromium under WSL2 loses the device when a canvas is presented.
  // The response override changes only presentation, leaving the real view,
  // solver and input handling in place.
  await page.route("**/src/common/gpu/WebGPUFluidEngine.ts", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    expect(source).toContain("options?.presentToCanvas ?? true");
    await route.fulfill({ response, body: source.replace("options?.presentToCanvas ?? true", "false") });
  });
  await page.goto("/?screens=2");
  await page.waitForSelector("#sim");
  const hasAdapter = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()));
  test.skip(!hasAdapter, "no WebGPU adapter available");

  const handle = page.locator('div[tabindex="0"]').filter({ hasText: /^Obstacle position$/ });
  const shapeButton = page.getByRole("button", { name: /Obstacle shape/ });
  await expect(handle).toBeVisible();
  await shapeButton.press("Enter");
  await page.getByRole("option", { name: "None", exact: true }).press("Enter");
  await expect(handle).toBeHidden();

  // The hidden node must leave the traversal order, not merely stop drawing.
  await page
    .locator('div[tabindex="0"]')
    .filter({ hasText: /^Fluid channel$/ })
    .focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Measuring tape", exact: true })).toBeFocused();

  await shapeButton.press("Enter");
  await page.getByRole("option", { name: "Ellipse", exact: true }).press("Enter");
  await expect(handle).toBeVisible();
  await handle.focus();
  await expect(handle).toBeFocused();
  expect(errors, "the paused offscreen sim starts and handles input without errors").toEqual([]);
});
