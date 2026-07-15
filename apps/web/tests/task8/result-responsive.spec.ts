import { expect, test } from "@playwright/test";

const basket = {
  version: 1,
  needs: [
    { id: "milk", query: "Lettmelk", quantity: 1, quantityUnit: "each", matchRuleId: "milk-rule", required: true },
    { id: "cheese", query: "Norvegia", quantity: 1, quantityUnit: "each", matchRuleId: "cheese-rule", required: true },
    { id: "soap", query: "Omo", quantity: 1, quantityUnit: "each", matchRuleId: "soap-rule", required: true },
  ],
  matchingRules: [
    { id: "milk-rule", mode: "exact", exactEan: "7038010000013", userApproved: true, explanation: "Eksakt produkt" },
    { id: "cheese-rule", mode: "exact", exactEan: "7038010000020", userApproved: true, explanation: "Eksakt produkt" },
    { id: "soap-rule", mode: "exact", exactEan: "7038010000037", userApproved: true, explanation: "Eksakt produkt" },
  ],
  products: [
    { ean: "7038010000013", name: "TINE Lettmelk 1 l", brand: "TINE" },
    { ean: "7038010000020", name: "Norvegia 1 kg", brand: "TINE" },
    { ean: "7038010000037", name: "Omo Color 1,2 l", brand: "Omo" },
  ],
  travel: { enabled: false, mode: "car" },
};

const response = {
  generatedAt: "2026-07-15T07:12:00.000Z",
  caveats: ["Kjedepris betyr ikke at varen er på lager eller har samme hyllepris i din butikk."],
  plans: [
    { id: "plan-balanced", assignments: [{ needId: "milk", ean: "7038010000013", chain: "rema-1000", quantity: 1, costOre: 30_000 }, { needId: "cheese", ean: "7038010000020", chain: "extra", quantity: 1, costOre: 20_000 }, { needId: "soap", ean: "7038010000037", chain: "extra", quantity: 1, costOre: 32_460 }], totalOre: 82_460, chains: ["extra", "rema-1000"], substitutions: [], coverage: 1, freshness: { milk: "eligible", cheese: "eligible", soap: "eligible" } },
    { id: "plan-savings", assignments: [{ needId: "milk", ean: "7038010000013", chain: "bunnpris", quantity: 1, costOre: 30_000 }, { needId: "cheese", ean: "7038010000020", chain: "rema-1000", quantity: 1, costOre: 20_000 }, { needId: "soap", ean: "7038010000037", chain: "extra", quantity: 1, costOre: 29_320 }], totalOre: 79_320, chains: ["bunnpris", "extra", "rema-1000"], substitutions: [], coverage: 1, freshness: { milk: "eligible", cheese: "eligible", soap: "eligible" } },
    { id: "plan-convenience", assignments: [{ needId: "milk", ean: "7038010000013", chain: "extra", quantity: 1, costOre: 30_000 }, { needId: "cheese", ean: "7038010000020", chain: "extra", quantity: 1, costOre: 30_000 }, { needId: "soap", ean: "7038010000037", chain: "extra", quantity: 1, costOre: 35_060 }], totalOre: 95_060, chains: ["extra"], substitutions: [], coverage: 1, freshness: { milk: "eligible", cheese: "eligible", soap: "eligible" } },
  ],
};

const viewports = [
  { width: 320, height: 800 },
  { width: 768, height: 900 },
  { width: 1440, height: 1000 },
] as const;

for (const viewport of viewports) {
  test(`${viewport.width}px result workspace is stable and keyboard operable`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((value) => localStorage.setItem("handleplan:basket:v1", JSON.stringify(value)), basket);
    await page.route("**/api/plans", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) }));
    await page.goto("/planlegg/resultat");
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}html,body,button,input{font-family:Arial,sans-serif!important}.font-mono,.result-total{font-family:monospace!important}nextjs-portal{display:none!important}" });

    await expect(page).toHaveTitle("Resultat | Handleplan");
    await expect(page.getByRole("heading", { name: "Handleliste fordelt på rute" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Balansert/ })).toBeChecked();
    await expect(page.locator(".result-total")).toHaveText("824,60 kr");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const heading = await page.locator(".result-heading").boundingBox();
    const rail = await page.locator(".result-rail").boundingBox();
    const firstStore = await page.locator(".result-store").first().boundingBox();
    expect(heading && rail && firstStore).toBeTruthy();
    if (viewport.width === 1440) {
      const assignments = await page.locator(".result-assignments").boundingBox();
      expect(assignments && assignments.x + assignments.width < rail!.x).toBe(true);
      expect(Math.abs(heading!.y - rail!.y)).toBeLessThan(48);
    } else if (viewport.width === 768) {
      expect(firstStore!.y < rail!.y).toBe(true);
    } else {
      expect(heading!.y < rail!.y && rail!.y < firstStore!.y).toBe(true);
    }

    await expect(page).toHaveScreenshot(`result-${viewport.width}.png`, { fullPage: true, animations: "disabled", caret: "hide" });

    const balanced = page.getByRole("radio", { name: /Balansert/ });
    await balanced.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: /Mest spart/ })).toBeChecked();
    await expect(page.locator(".result-total")).toHaveText("793,20 kr");
    await expect(page.getByRole("region", { name: /Stopp 3: REMA 1000/ })).toBeVisible();
  });
}
