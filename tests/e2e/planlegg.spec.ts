import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

function collectPublicEvidence(page: Page): { records: string[]; settle: () => Promise<void> } {
  const records: string[] = [];
  const pending: Promise<void>[] = [];
  page.on("console", (message) => records.push(`console:${message.type()}:${message.text()}`));
  page.on("request", (request) => {
    records.push(`request:${request.url()}:${JSON.stringify(request.headers())}:${request.postData() ?? ""}`);
  });
  page.on("response", (response) => {
    if (!response.url().includes("/api/")) return;
    pending.push(response.text().then((body) => {
      records.push(`response:${response.url()}:${JSON.stringify(response.headers())}:${body}`);
    }).catch(() => undefined));
  });
  return { records, settle: async () => { await Promise.all(pending); } };
}

async function expectNoSeriousAccessibilityViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([]);
}

async function addExactProduct(page: Page, query: string, productName: RegExp): Promise<void> {
  const composer = page.getByLabel("Hva skal du handle?");
  await composer.fill(query);
  await page.getByRole("option", { name: productName }).click();
}

test("anonymous shopper approves matching and chooses a complete balanced plan", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/planlegg");

  await expect(page).toHaveTitle("Handleplan");
  await expect(page.getByRole("heading", { name: "Hva skal du handle?" })).toBeVisible();
  await expect(page.getByText("Ingen konto nødvendig.")).toBeVisible();
  await expect(page.getByText(/logg inn|opprett konto/i)).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByLabel("Hva skal du handle?").fill("lettmelk");
  await page.getByRole("button", { name: "Legg til" }).click();
  await expect(page.getByRole("group", { name: /Godkjenn treff for lettmelk/ })).toBeVisible();
  await page.getByRole("button", { name: "Samme type, valgfritt merke" }).click();
  await expect(page.getByText("Samme type, valgfritt merke").last()).toBeVisible();

  await addExactProduct(page, "lettmelk", /TINE Lettmelk/);
  await addExactProduct(page, "kaffe", /Evergood Kaffe/);
  await addExactProduct(page, "brød", /Norsk grovbrød/);

  const storedBeforeResult = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storedBeforeResult).not.toContain("origin");
  await page.getByRole("link", { name: /Finn beste handleplan/ }).click();

  await expect(page).toHaveTitle("Resultat | Handleplan");
  await expect(page.getByRole("heading", { name: "Handleliste fordelt på rute" })).toBeVisible();
  await expect(page.getByText(/Komplett kurv basert på 4 nødvendige varer/)).toBeVisible();
  await expect(page.getByText(/logg inn|opprett konto/i)).toHaveCount(0);

  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(3);
  const labels = await radios.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? "").join(" | "));
  expect(labels).toContain("Bunnpris");
  expect(labels).toContain("REMA 1000");
  expect(labels).toContain("Extra");
  expect(labels).toMatch(/1 butikk/);
  expect(labels).toMatch(/2 butikker/);
  expect(labels).toMatch(/3 butikker/);

  const selected = page.getByRole("radio", { checked: true });
  await selected.focus();
  await page.keyboard.press("ArrowDown");
  const keyboardSelection = page.getByRole("radio", { checked: true });
  const persistedPlanId = await keyboardSelection.getAttribute("value");
  expect(persistedPlanId).toBeTruthy();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("handleplan:basket:v1"))).toContain(`"selectedPlanId":"${persistedPlanId}"`);

  await page.reload();
  await expect(page.locator(`input[type="radio"][value="${persistedPlanId}"]`)).toBeChecked();
  await expectNoSeriousAccessibilityViolations(page);

  const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(JSON.stringify(storage)).not.toContain("origin");
  await evidence.settle();
  expect(evidence.records.join("\n")).not.toContain("KASSAL_API_KEY");
});

test("an intentionally stale fixture cannot produce a recommendation", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/planlegg");
  await addExactProduct(page, "stale", /Stale testvare/);
  await page.getByRole("link", { name: /Finn beste handleplan/ }).click();

  await expect(page.getByRole("heading", { name: "Ingen komplett handleplan" })).toBeVisible();
  await expect(page.getByText("Ingen delvis plan blir anbefalt.")).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await evidence.settle();
  expect(evidence.records.join("\n")).not.toContain("KASSAL_API_KEY");
});
