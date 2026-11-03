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
});
