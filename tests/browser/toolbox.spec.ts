/**
 * The toolbox's take-out gesture, in a real browser.
 *
 * Playwright rather than Vitest because the whole contract lives in scenery's
 * input handling: a press on an icon has to be handed to the tool's own drag
 * listener, and whether that hand-off succeeds depends on which listener owns
 * the pointer. None of it is observable without a Display and a real pointer.
 *
 * The regression this pins down was invisible to a test that only checked
 * whether the tool became visible: an attaching PressListener on the icon made
 * the hand-off a silent no-op, so the tool appeared at the pointer, correctly
 * positioned, and then stayed there while the pointer dragged nothing at all.
 * Every assertion below is therefore about *where* the tool ends up.
 *
 * Needs no WebGPU — the toolbox is live even when the field shows the "WebGPU
 * is not available" message, which is what it shows on a headless CI runner.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

type Point = { x: number; y: number };

// Pinned so the layout, and the empty patch of screen the tape test drops onto,
// do not depend on the runner's default viewport.
test.use({ viewport: { width: 1280, height: 800 } });

/** Centre of a toolbox icon, in page pixels. Icons are buttons; tools are not. */
async function iconCentre(page: Page, accessibleName: string): Promise<Point> {
  const box = await page.getByRole("button", { name: accessibleName, exact: true }).boundingBox();
  if (box === null) {
    throw new Error(`no toolbox icon named "${accessibleName}"`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The ruler's own parallel-DOM element — a focusable div, and one of the few
 * the sim positions over its node, which is what makes its rect the ruler's.
 */
function rulerTool(page: Page): Locator {
  return page.locator('div[tabindex="0"]').filter({ hasText: /^Ruler/ });
}

/** The tape's base element, from scenery-phet's own parallel-DOM markup. */
function tapeBase(page: Page): Locator {
  return page.locator('div[role="application"]').first();
}

/** Moves in steps, because a single jump is one event and a drag needs a stream. */
async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / 10, from.y + ((to.y - from.y) * step) / 10);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
}

async function boundsOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("expected the element to be laid out");
  }
  return box;
}

test.describe("toolbox", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?screens=1");
    await page.waitForSelector("#sim");
    // The gestures below need the icons laid out, not merely the DOM up.
    await expect(page.getByRole("button", { name: "Ruler", exact: true })).toBeVisible();
    await page.waitForTimeout(1000);
  });

  test("a ruler dragged out of the toolbox follows the pointer", async ({ page }) => {
    const icon = await iconCentre(page, "Ruler");
    const drop = { x: icon.x + 420, y: icon.y - 330 };
    await drag(page, icon, drop);

    // The whole point of the gesture: the ruler comes out under the hand and
    // stays there. When the hand-off is refused it is left back at the icon.
    const rect = await boundsOf(rulerTool(page));
    expect(rect.x).toBeLessThanOrEqual(drop.x);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(drop.x);
    expect(rect.y).toBeLessThanOrEqual(drop.y);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(drop.y);
  });

  test("a ruler dropped back on the toolbox goes away; one merely taken out does not", async ({ page }) => {
    const icon = await iconCentre(page, "Ruler");

    // A take-out drag ends over the toolbox by construction — the pointer never
    // left it — and that must not read as putting the ruler straight back.
    await drag(page, icon, { x: icon.x + 60, y: icon.y - 40 });
    await expect(rulerTool(page)).toBeVisible();

    const rect = await boundsOf(rulerTool(page));
    await drag(page, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, icon);
    await expect(rulerTool(page)).toBeHidden();
  });

  test("clicking the ruler icon parks the ruler clear of the toolbox, and clicking again puts it back", async ({
    page,
  }) => {
    const icon = await iconCentre(page, "Ruler");
    const iconRect = await boundsOf(page.getByRole("button", { name: "Ruler", exact: true }));

    await page.mouse.click(icon.x, icon.y);
    await expect(rulerTool(page)).toBeVisible();

    // A press that never travelled is a click, and a click leaves the ruler out
    // in the channel rather than face down on the toolbox it came from.
    const rect = await boundsOf(rulerTool(page));
    expect(rect.y + rect.height).toBeLessThan(iconRect.y);

    await page.mouse.click(icon.x, icon.y);
    await expect(rulerTool(page)).toBeHidden();
  });

  test("a measuring tape dragged out of the toolbox follows the pointer", async ({ page }) => {
    const icon = await iconCentre(page, "Measuring tape");

    // The tape's own parallel-DOM element is scenery-phet's and is not
    // positioned over the node, so this one is measured in pixels: an empty
    // patch of screen beside the toolbox, before and after the tape is dragged
    // onto it. Empty and outside the field, so nothing else can repaint it.
    const drop = { x: icon.x + 620, y: icon.y - 10 };
    const patch = { x: drop.x - 70, y: drop.y - 60, width: 120, height: 80 };
    const before = await page.screenshot({ clip: patch });

    await drag(page, icon, drop);

    await expect(tapeBase(page)).toBeVisible();
    const after = await page.screenshot({ clip: patch });
    expect(after.equals(before), "the tape should have been dragged onto the empty patch").toBe(false);
  });

  test("a measuring tape dropped back on the toolbox goes away", async ({ page }) => {
    const icon = await iconCentre(page, "Measuring tape");
    await drag(page, icon, { x: icon.x + 420, y: icon.y - 330 });
    await expect(tapeBase(page)).toBeVisible();

    // Grab the base where the take-out left it — under the pointer — and carry
    // it home.
    await drag(page, { x: icon.x + 420, y: icon.y - 330 }, icon);
    await expect(tapeBase(page)).toBeHidden();
  });
});
