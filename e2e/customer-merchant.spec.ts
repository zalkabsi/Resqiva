import { expect, test } from "@playwright/test";

test("shopper plans from live inventory and merchant workspace loads", async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto("/");
  await expect(page.getByText("Fictional demo inventory").first()).toBeVisible();
  await expect(page.getByLabel("Pickup store")).toBeVisible();

  await page.getByRole("button", { name: "My orders" }).click();
  await expect(page.getByRole("heading", { name: "My orders" })).toBeVisible();
  await expect(page.getByText(/No orders yet|View receipt/).first()).toBeVisible();

  await page.getByLabel("Describe your meals and preferences").fill(
    "Plan one vegetarian dinner for two under $25 with pickup tomorrow.",
  );
  await page.getByLabel("Budget").fill("25");
  await page.getByLabel("Servings").fill("2");
  await page.getByRole("spinbutton", { name: "Meals" }).fill("1");
  await page.getByRole("button", { name: "Find my meal plan" }).click();

  await expect(page.getByText("Request understood", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Verified against stock")).toBeVisible();
  await expect(page.locator(".bundle-card").filter({ has: page.getByRole("button", { name: /Reserve this meal set/ }) }).first()).toBeVisible();

  await page.getByRole("tab", { name: "Merchant" }).click();
  await expect(page.getByRole("heading", { name: "Your store snapshot" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inventory snapshot" })).toBeVisible();
  await expect(page.locator(".inventory-table tbody tr").first()).toBeVisible();

  const storeName = `E2E Demo Store ${Date.now()}`;
  await page.getByRole("button", { name: "Add demo store" }).click();
  const storeForm = page.locator("form").filter({ has: page.getByLabel("Store name") }).last();
  await storeForm.getByLabel("Store name").fill(storeName);
  await storeForm.getByLabel("City").fill("Riyadh");
  await storeForm.getByLabel("Timezone").fill("UTC");
  await storeForm.getByLabel("Pickup address").fill("100 Fictional Market Road");
  await storeForm.getByRole("button", { name: "Create demo store" }).click();
  await expect(page.getByText(storeName, { exact: true })).toBeVisible();

  const storeCard = page.locator("article").filter({ hasText: storeName }).first();
  await storeCard.getByRole("button", { name: "Add pickup window" }).click();
  const startsAtMs = Date.now() + 72 * 60 * 60 * 1_000;
  const inputDate = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 16);
  await page.getByLabel(`New pickup start for ${storeName}`).fill(inputDate(startsAtMs));
  await page.getByLabel(`New pickup end for ${storeName}`).fill(inputDate(startsAtMs + 2 * 60 * 60 * 1_000));
  await page.getByLabel(`New reservation cutoff for ${storeName}`).fill(inputDate(startsAtMs - 60 * 60 * 1_000));
  await page.getByLabel(`New pickup capacity for ${storeName}`).fill("120");
  await storeCard.getByRole("button", { name: "Create pickup window" }).click();
  await expect(page.getByText(`Pickup window for ${storeName} was created and confirmed by the server.`)).toBeVisible();
  await expect(page.getByText(`${storeName} pickup`, { exact: false })).toBeVisible();
});
