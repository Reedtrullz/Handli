import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request, type Response } from "@playwright/test";
import { createServer } from "node:http";

const BASE_ORIGIN = "http://127.0.0.1:3109";
const FORBIDDEN_VALUES = ["KASSAL_API_KEY", process.env.HANDLEPLAN_E2E_SENTINEL].filter(
  (value): value is string => Boolean(value),
);
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);
const BODYLESS_STATUSES = new Set([101, 103, 204, 205, 304]);

interface PublicEvidence {
  settle(): Promise<void>;
  stats: {
    bodyReadFailures: Array<{ message: string; status: number; url: string }>;
    bodylessSameOriginResponses: number;
    consoleErrors: number;
    crossOriginBodiesNotInspected: number;
    forbiddenMatches: number;
    frameworkFontBodiesNotInspected: number;
    headerReadFailures: Array<{ sameOrigin: boolean; surface: "request" | "response" }>;
    pageErrors: number;
    sameOriginBodiesInspected: number;
    surfacesInspected: number;
    observedSensitiveHeaderNames: string[];
  };
}

function collectPublicEvidence(page: Page): PublicEvidence {
  const stats = {
    bodyReadFailures: [],
    bodylessSameOriginResponses: 0,
    consoleErrors: 0,
    crossOriginBodiesNotInspected: 0,
    forbiddenMatches: 0,
    frameworkFontBodiesNotInspected: 0,
    headerReadFailures: [],
    pageErrors: 0,
    sameOriginBodiesInspected: 0,
    surfacesInspected: 0,
    observedSensitiveHeaderNames: [],
  };
  const pending: Promise<void>[] = [];

  function inspect(value: string): void {
    stats.surfacesInspected += 1;
    if (FORBIDDEN_VALUES.some((forbidden) => value.includes(forbidden))) {
      stats.forbiddenMatches += 1;
    }
  }

  function inspectHeader(name: string, value: string): void {
    const normalizedName = name.toLowerCase();
    if (SENSITIVE_HEADERS.has(normalizedName) && !stats.observedSensitiveHeaderNames.includes(normalizedName)) {
      stats.observedSensitiveHeaderNames.push(normalizedName);
      stats.observedSensitiveHeaderNames.sort();
    }
    inspect(`${normalizedName}:${value}`);
  }

  function inspectHeaders(headers: Record<string, string>): void {
    for (const [name, value] of Object.entries(headers)) inspectHeader(name, value);
  }

  function inspectHeaderEntries(headers: Array<{ name: string; value: string }>): void {
    for (const { name, value } of headers) inspectHeader(name, value);
  }

  async function inspectResponse(response: Response): Promise<void> {
    inspect(response.url());
    const sameOrigin = new URL(response.url()).origin === BASE_ORIGIN;
    try {
      const [headers, headerEntries] = await Promise.all([response.allHeaders(), response.headersArray()]);
      inspectHeaders(headers);
      inspectHeaderEntries(headerEntries);
    } catch {
      stats.headerReadFailures.push({ sameOrigin, surface: "response" });
    }
    if (!sameOrigin) {
      stats.crossOriginBodiesNotInspected += 1;
      return;
    }
    const responseUrl = new URL(response.url());
    const contentType = response.headers()["content-type"]?.split(";", 1)[0]?.toLowerCase();
    if (
      response.request().resourceType() === "font" &&
      contentType === "font/woff2" &&
      /^\/__nextjs_font\/[^/]+\.woff2$/.test(responseUrl.pathname)
    ) {
      // Chromium on Linux does not expose Next's virtual development font body
      // through Network.getResponseBody. Its URL and complete headers are still
      // inspected above; application, script, RSC, and API bodies remain required.
      stats.frameworkFontBodiesNotInspected += 1;
      return;
    }
    if (BODYLESS_STATUSES.has(response.status()) || (response.status() >= 300 && response.status() < 400)) {
      stats.bodylessSameOriginResponses += 1;
      return;
    }
    try {
      const body = await response.body();
      stats.sameOriginBodiesInspected += 1;
      inspect(Buffer.from(body).toString("latin1"));
    } catch (error) {
      stats.bodyReadFailures.push({
        message: error instanceof Error ? error.message : String(error),
        status: response.status(),
        url: response.url(),
      });
    }
  }

  async function inspectRequest(request: Request): Promise<void> {
    inspect(request.url());
    inspect(request.postData() ?? "");
    const sameOrigin = new URL(request.url()).origin === BASE_ORIGIN;
    try {
      inspectHeaders(await request.allHeaders());
    } catch {
      stats.headerReadFailures.push({ sameOrigin, surface: "request" });
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
    pending.push(inspectRequest(request));
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
  expect(evidence.stats.bodyReadFailures).toEqual([]);
  expect(evidence.stats.headerReadFailures).toEqual([]);
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

const expectedPackages = [
  "Bakehuset · 750 g per pakke",
  "Evergood · 500 g per pakke",
  "TINE · 1 000 ml per pakke",
].sort();

const expectedPlans = [
  { name: "Enklest", total: "98,00 kr", totalOre: 9_800, stores: 1 },
  { name: "Balansert", total: "85,00 kr", totalOre: 8_500, stores: 2 },
  { name: "Mest spart", total: "80,00 kr", totalOre: 8_000, stores: 3 },
] as const;

test("the leak detector sees authorization, cookie, and set-cookie values", async ({ context, page }) => {
  const sentinel = process.env.HANDLEPLAN_E2E_SENTINEL;
  expect(typeof sentinel === "string" && sentinel.length > 20).toBe(true);
  if (!sentinel) throw new Error("Runtime leak sentinel was unavailable");

  const probeServer = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": `header-probe=${sentinel}; Path=/; HttpOnly`,
    });
    response.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    probeServer.once("error", reject);
    probeServer.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = probeServer.address();
    if (!address || typeof address === "string") throw new Error("Header probe address was unavailable");
    await context.addCookies([{ name: "header-probe", value: sentinel, domain: "127.0.0.1", path: "/" }]);
    await context.setExtraHTTPHeaders({ authorization: `Bearer ${sentinel}` });

    const evidence = collectPublicEvidence(page);
    await page.goto(`http://127.0.0.1:${address.port}/header-probe`);
    await evidence.settle();

    expect(evidence.stats.observedSensitiveHeaderNames).toEqual(["authorization", "cookie", "set-cookie"]);
    expect(evidence.stats.forbiddenMatches).toBeGreaterThanOrEqual(3);
    expect(evidence.stats.headerReadFailures).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => probeServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("Planlegg reflows without horizontal overflow at 320 pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/planlegg");

  await expect(page.getByRole("heading", { name: "Hva skal du handle?" })).toBeVisible();
  const reflow = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          className: element.className,
          left: box.left,
          right: box.right,
          tagName: element.tagName,
        };
      })
      .filter(({ left, right }) => left < -0.5 || right > window.innerWidth + 0.5)
      .slice(0, 12),
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(reflow.scrollWidth, JSON.stringify(reflow)).toBeLessThanOrEqual(reflow.innerWidth);

  const composer = await page.locator(".need-composer").boundingBox();
  expect(composer).not.toBeNull();
  expect(composer!.x).toBeGreaterThanOrEqual(0);
  expect(composer!.x + composer!.width).toBeLessThanOrEqual(320);
});

test("anonymous shopper approves matching and chooses every complete frontier plan", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/");

  await expect(page).toHaveURL(`${BASE_ORIGIN}/planlegg`);
  await expect(page).toHaveTitle("Handleplan");
  await expect(page.getByRole("heading", { name: "Hva skal du handle?" })).toBeVisible();
  await expect(page.getByText("Ingen konto nødvendig.")).toBeVisible();
  await expect(page.getByText(/logg inn|opprett konto/i)).toHaveCount(0);
  await expectWcag22AandAA(page);

  await addExactProduct(page, "lettmelk", /TINE Lettmelk/);
  await addExactProduct(page, "kaffe", /Evergood Kaffe/);
  await addExactProduct(page, "brød", /Norsk grovbrød/);

  const storedBeforeResult = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storedBeforeResult).not.toContain("origin");
  expect(JSON.parse(JSON.parse(storedBeforeResult)["handleplan:basket:v2"])).toMatchObject({
    version: 2,
    needs: [{ query: "TINE Lettmelk 1 % 1 l" }, { query: "Evergood Kaffe 500 g" }, { query: "Norsk grovbrød 750 g" }],
    products: expect.arrayContaining([expect.objectContaining({ ean: "7038010000010" })]),
  });
  // Drain response bodies before a client navigation can cancel an in-flight
  // development-server response on slower CI runners.
  await evidence.settle();
  await page.getByRole("link", { name: /Finn handleplan/ }).click();

  await expect(page).toHaveTitle("Resultat | Handleplan");
  await expect(page.getByRole("heading", { name: "Handleliste fordelt på butikker" })).toBeVisible();
  await expect(page.getByText(/Komplett kurv basert på 3 nødvendige varer/)).toBeVisible();
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
    await expect(page.locator(".result-store-row")).toHaveCount(3);
    const packages = (await page.locator(".result-store-row > div > small:first-of-type").allTextContents())
      .map((value) => value.replace(/\s+/g, " "))
      .sort();
    expect(packages).toEqual(expectedPackages);
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
  const selectedPlanId = await page.getByRole("radio", { checked: true }).getAttribute("value");
  expect(selectedPlanId).toBeTruthy();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("handleplan:basket:v2"))).toContain('"convenienceWeightBasisPoints":0');

  await evidence.settle();
  await page.reload();
  await expect(page.locator(`input[type="radio"][value="${selectedPlanId}"]`)).toBeChecked();
  await expectWcag22AandAA(page);

  const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(JSON.stringify(storage)).not.toContain("origin");
  await expectCleanPublicEvidence(evidence);
});

test("an intentionally stale fixture cannot produce a recommendation", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/planlegg");
  await addExactProduct(page, "stale", /Stale testvare/);
  await page.getByRole("link", { name: /Finn handleplan/ }).click();

  await expect(page.getByRole("heading", { name: "Ingen komplett handleplan" })).toBeVisible();
  await expect(page.getByText("Ingen delvis plan blir anbefalt.")).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expectWcag22AandAA(page);
  await expectCleanPublicEvidence(evidence);
});

test("a shopper discovers a fresh price and carries the exact product into Planlegg", async ({ page }) => {
  const evidence = collectPublicEvidence(page);
  await page.goto("/oppdag");

  await expect(page).toHaveTitle("Oppdag | Handleplan");
  await expect(page.getByRole("heading", { name: "Oppdag" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Varekatalog og prisgrunnlag" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
  await expect(page.getByText("Laveste viste ordinærpris • Bunnpris")).toBeVisible();
  await expect(page.getByText(/Deterministic fake price fixture/).first()).toBeVisible();
  await page.getByRole("button", { name: "Extra" }).click();
  await expect(page.getByRole("heading", { name: "Prisgrunnlag hos Extra" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "TINE Lettmelk 1 % 1 l" })).toBeVisible();
  await expectWcag22AandAA(page);

  const milkCard = page.getByRole("heading", { name: "TINE Lettmelk 1 % 1 l" }).locator("xpath=ancestor::article");
  await milkCard.getByRole("button", { name: "Legg til i handlelisten" }).click();
  await expect(milkCard.getByRole("button", { name: "I handlelisten" })).toBeDisabled();
  await expect(page.getByText("1 vare")).toBeVisible();

  await page.getByRole("link", { name: /Gå til Planlegg/ }).click();
  await expect(page).toHaveURL(`${BASE_ORIGIN}/planlegg`);
  await expect(page.getByRole("listitem", { name: /TINE Lettmelk 1 % 1 l/ })).toBeVisible();
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("handleplan:basket:v2") ?? "{}"));
  expect(persisted).toMatchObject({
    needs: [{ query: "TINE Lettmelk 1 % 1 l" }],
    matchingRules: [{ mode: "exact", exactEan: "7038010000010" }],
  });

  await expectCleanPublicEvidence(evidence);
});
