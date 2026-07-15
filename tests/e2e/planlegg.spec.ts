import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Response } from "@playwright/test";

const BASE_ORIGIN = "http://127.0.0.1:3109";
const FORBIDDEN_VALUES = ["KASSAL_API_KEY", "sentinel-review-only-7f42"] as const;
const BODYLESS_STATUSES = new Set([101, 103, 204, 205, 304]);

interface PublicEvidence {
  settle(): Promise<void>;
  stats: {
    bodyReadErrors: number;
    bodylessSameOriginResponses: number;
    consoleErrors: number;
    crossOriginBodiesNotInspected: number;
    forbiddenMatches: number;
    pageErrors: number;
    sameOriginBodiesInspected: number;
    surfacesInspected: number;
  };
}

function collectPublicEvidence(page: Page): PublicEvidence {
  const stats = {
    bodyReadErrors: 0,
    bodylessSameOriginResponses: 0,
    consoleErrors: 0,
    crossOriginBodiesNotInspected: 0,
    forbiddenMatches: 0,
    pageErrors: 0,
    sameOriginBodiesInspected: 0,
    surfacesInspected: 0,
  };
  const pending: Promise<void>[] = [];

  function inspect(value: string): void {
    stats.surfacesInspected += 1;
    if (FORBIDDEN_VALUES.some((forbidden) => value.includes(forbidden))) {
      stats.forbiddenMatches += 1;
    }
  }

  async function inspectResponse(response: Response): Promise<void> {
    inspect(response.url());
    inspect(JSON.stringify(response.headers()));
    const sameOrigin = new URL(response.url()).origin === BASE_ORIGIN;
    if (!sameOrigin) {
      stats.crossOriginBodiesNotInspected += 1;
      return;
    }
    if (BODYLESS_STATUSES.has(response.status())) {
      stats.bodylessSameOriginResponses += 1;
      return;
    }
    try {
      const body = await response.body();
      stats.sameOriginBodiesInspected += 1;
      inspect(Buffer.from(body).toString("latin1"));
    } catch {
      stats.bodyReadErrors += 1;
    }
  }

  page.on("console", (message) => {
    inspect(message.text());
    if (message.type() === "error") stats.consoleErrors += 1;
  });
  page.on("pageerror", (error) => {
    inspect(error.message);
    stats.pageErrors += 1;
  });
  page.on("request", (request) => {
    inspect(request.url());
    inspect(JSON.stringify(request.headers()));
    inspect(request.postData() ?? "");
  });
  page.on("response", (response) => {
    pending.push(inspectResponse(response));
  });

  return {
    stats,
    settle: async () => {
      await page.waitForTimeout(100);
      let completed = 0;
      let stableChecks = 0;
      while (stableChecks < 2) {
        if (completed < pending.length) {
          const batch = pending.slice(completed);
          completed = pending.length;
          await Promise.all(batch);
          stableChecks = 0;
        } else {
          stableChecks += 1;
        }
        await page.waitForTimeout(25);
      }
    },
  };
}

async function expectCleanPublicEvidence(evidence: PublicEvidence): Promise<void> {
  await evidence.settle();
  expect(evidence.stats.sameOriginBodiesInspected).toBeGreaterThan(0);
  expect(evidence.stats.surfacesInspected).toBeGreaterThan(0);
  expect(evidence.stats.bodyReadErrors).toBe(0);
  expect(evidence.stats.consoleErrors).toBe(0);
  expect(evidence.stats.pageErrors).toBe(0);
  expect(evidence.stats.forbiddenMatches).toBe(0);
}

async function expectWcag22AandAA(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

async function addExactProduct(page: Page, query: string, productName: RegExp): Promise<void> {
  const composer = page.getByLabel("Hva skal du handle?");
  await composer.fill(query);
  await page.getByRole("option", { name: productName }).click();
}

const expectedCoverage = [
  "Bakehuset · Dekker «Norsk grovbrød 750 g»",
  "Evergood · Dekker «Evergood Kaffe 500 g»",
  "TINE · Dekker «TINE Lettmelk 1 % 1 l»",
  "TINE · Dekker «lettmelk»",
].sort();

const expectedPlans = [
  { name: "Enklest", total: "124,00 kr", totalOre: 12_400, stores: 1 },
  { name: "Balansert", total: "110,00 kr", totalOre: 11_000, stores: 2 },
  { name: "Mest spart", total: "100,00 kr", totalOre: 10_000, stores: 3 },
] as const;

test("anonymous shopper approves matching and chooses every complete frontier plan", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/planlegg");

  await expect(page).toHaveTitle("Handleplan");
  await expect(page.getByRole("heading", { name: "Hva skal du handle?" })).toBeVisible();
  await expect(page.getByText("Ingen konto nødvendig.")).toBeVisible();
  await expect(page.getByText(/logg inn|opprett konto/i)).toHaveCount(0);
  await expectWcag22AandAA(page);

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
  await expect(radios).toHaveCount(expectedPlans.length);
  const radioLabels = await radios.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
  expect(radioLabels.map((label) => label.split(",")[0])).toEqual(expectedPlans.map(({ name }) => name));

  for (const plan of expectedPlans) {
    const radio = page.getByRole("radio", { name: new RegExp(`^${plan.name}, ${plan.total.replace(".", "\\.")}`) });
    await radio.check();
    await expect(page.locator(".result-total")).toHaveText(plan.total);
    await expect(page.locator(".result-store")).toHaveCount(plan.stores);
    await expect(page.locator(".result-store-row")).toHaveCount(4);
    const coverage = (await page.locator(".result-store-row small").allTextContents()).sort();
    expect(coverage).toEqual(expectedCoverage);
  }

  for (const left of expectedPlans) {
    for (const right of expectedPlans) {
      if (left === right) continue;
      const leftDominatesRight = left.totalOre <= right.totalOre && left.stores <= right.stores &&
        (left.totalOre < right.totalOre || left.stores < right.stores);
      expect(leftDominatesRight).toBe(false);
    }
  }

  const balanced = page.getByRole("radio", { name: /^Balansert/ });
  await balanced.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: /^Mest spart/ })).toBeChecked();
  const persistedPlanId = await page.getByRole("radio", { checked: true }).getAttribute("value");
  expect(persistedPlanId).toBeTruthy();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("handleplan:basket:v1"))).toContain(`"selectedPlanId":"${persistedPlanId}"`);

  await page.reload();
  await expect(page.locator(`input[type="radio"][value="${persistedPlanId}"]`)).toBeChecked();
  await expectWcag22AandAA(page);

  const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(JSON.stringify(storage)).not.toContain("origin");
  await expectCleanPublicEvidence(evidence);
});

test("an intentionally stale fixture cannot produce a recommendation", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/planlegg");
  await addExactProduct(page, "stale", /Stale testvare/);
  await page.getByRole("link", { name: /Finn beste handleplan/ }).click();

  await expect(page.getByRole("heading", { name: "Ingen komplett handleplan" })).toBeVisible();
  await expect(page.getByText("Ingen delvis plan blir anbefalt.")).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expectWcag22AandAA(page);
  await expectCleanPublicEvidence(evidence);
});
