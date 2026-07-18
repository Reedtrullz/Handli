import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

export const WCAG_22_A_AA_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
] as const;

/**
 * Keep the scan whole-page and unfiltered. A failure is evidence to fix, not
 * a reason to exclude a selector or disable a rule.
 */
export async function expectNoAutomatedWcag22Violations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags([...WCAG_22_A_AA_TAGS])
    .analyze();
  expect(result.violations).toEqual([]);
}

export async function expectSemanticHeadingOrder(page: Page): Promise<void> {
  const headings = await page.locator("h1, h2, h3, h4, h5, h6").evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const element = node as HTMLElement;
        const style = window.getComputedStyle(element);
        return style.display !== "none"
          && style.visibility !== "hidden"
          && element.getClientRects().length > 0;
      })
      .map((node) => ({
        level: Number(node.tagName.slice(1)),
        text: node.textContent?.replace(/\s+/gu, " ").trim() ?? "",
      })),
  );

  expect(headings.filter(({ level }) => level === 1), JSON.stringify(headings)).toHaveLength(1);
  for (let index = 1; index < headings.length; index += 1) {
    expect(
      headings[index]!.level,
      `Heading level skipped near ${JSON.stringify(headings[index])}: ${JSON.stringify(headings)}`,
    ).toBeLessThanOrEqual(headings[index - 1]!.level + 1);
  }
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const active = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const activeBox = active?.getBoundingClientRect();
    const activeStyle = active === undefined ? undefined : window.getComputedStyle(active);
    const activeAncestors: Array<{ className: string; left: number; right: number; tagName: string; width: number }> = [];
    for (let element = active?.parentElement; element !== null && element !== undefined; element = element.parentElement) {
      const box = element.getBoundingClientRect();
      activeAncestors.push({
        className: typeof element.className === "string" ? element.className : "",
        left: box.left,
        right: box.right,
        tagName: element.tagName,
        width: box.width,
      });
      if (activeAncestors.length >= 8) break;
    }
    return {
      activeElement: active === undefined || activeBox === undefined ? undefined : {
        className: active.className,
        left: activeBox.left,
        outlineOffset: activeStyle?.outlineOffset,
        outlineWidth: activeStyle?.outlineWidth,
        right: activeBox.right,
        tagName: active.tagName,
        text: active.textContent?.replace(/\s+/gu, " ").trim().slice(0, 80) ?? "",
      },
      activeAncestors,
      clientWidth: document.documentElement.clientWidth,
      innerWidth: window.innerWidth,
      offenders: [...document.querySelectorAll<HTMLElement>("body *")]
        .map((element) => {
          const box = element.getBoundingClientRect();
          return {
            className: typeof element.className === "string" ? element.className : "",
            left: Math.round(box.left * 10) / 10,
            right: Math.round(box.right * 10) / 10,
            tagName: element.tagName,
            text: element.textContent?.replace(/\s+/gu, " ").trim().slice(0, 80) ?? "",
            width: Math.round(box.width * 10) / 10,
          };
        })
        .filter(({ left, right }) => left < -0.5 || right > document.documentElement.clientWidth + 0.5)
        .slice(0, 12),
      scrollWidth: document.documentElement.scrollWidth,
      scrollX: window.scrollX,
    };
  });
  expect(layout.offenders, JSON.stringify(layout)).toEqual([]);
  expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.clientWidth + 1);
}

export interface ZoomEquivalentReflowEvidence {
  baselineCssPixels: number;
  effectiveCssPixels: number;
  method: "viewport-equivalent";
  zoomPercent: 400;
}

/**
 * WCAG reflow at 400% is represented by the standards-equivalent 320 CSS px
 * viewport produced when a 1280 CSS px baseline is zoomed four times. This is
 * deterministic across Playwright's three engines, but it is not evidence that
 * the native browser zoom control itself was exercised.
 */
export async function expectFourHundredPercentZoomEquivalentReflow(
  page: Page,
): Promise<ZoomEquivalentReflowEvidence> {
  const baselineCssPixels = 1_280;
  const zoomPercent = 400 as const;
  const effectiveCssPixels = baselineCssPixels / (zoomPercent / 100);
  expect(Number.isInteger(effectiveCssPixels)).toBe(true);
  expect(effectiveCssPixels).toBe(320);

  const startingViewport = page.viewportSize();
  expect(startingViewport?.width).toBe(baselineCssPixels);
  const currentHeight = startingViewport?.height ?? 900;
  await page.setViewportSize({ height: currentHeight, width: effectiveCssPixels });
  expect(page.viewportSize()).toEqual({ height: currentHeight, width: effectiveCssPixels });
  await expectNoHorizontalOverflow(page);

  return {
    baselineCssPixels,
    effectiveCssPixels,
    method: "viewport-equivalent",
    zoomPercent,
  };
}

export async function expectMinimumTargetSize(
  locator: Locator,
  minimumCssPixels = 24,
): Promise<void> {
  const offenders = await locator.evaluateAll((nodes, minimum) =>
    nodes.flatMap((node) => {
      const element = node as HTMLElement;
      const style = window.getComputedStyle(element);
      if (
        style.display === "none"
        || style.visibility === "hidden"
        || element.getClientRects().length === 0
        || element.matches(":disabled")
      ) return [];
      const box = element.getBoundingClientRect();
      return box.width + 0.01 < minimum || box.height + 0.01 < minimum
        ? [{
            height: box.height,
            label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName,
            width: box.width,
          }]
        : [];
    }), minimumCssPixels);
  expect(offenders).toEqual([]);
}

/**
 * Deliberately bounded privacy evidence: this inspects the current URL,
 * localStorage, and sessionStorage only. It does not prove absence from
 * cookies, the Cache API, IndexedDB, browser traces, server logs, routing
 * providers, or edge infrastructure.
 */
export async function expectTravelStateAbsentFromWebStorageAndUrl(
  page: Page,
  privateFragments: readonly string[],
): Promise<void> {
  const browserState = await page.evaluate(() => ({
    localStorage: JSON.stringify(Object.fromEntries(Object.entries(localStorage))),
    sessionStorage: JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))),
    url: location.href,
  }));
  for (const fragment of privateFragments) {
    expect(browserState.localStorage).not.toContain(fragment);
    expect(browserState.sessionStorage).not.toContain(fragment);
    expect(browserState.url).not.toContain(fragment);
  }
}
