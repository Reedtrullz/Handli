import { expect, test } from "@playwright/test";

test("the private review route can render ephemeral image and PDF object URLs", async ({ page }) => {
  const response = await page.goto("/review");
  const policy = response?.headers()["content-security-policy"] ?? "";

  expect(policy).toContain("img-src 'self' data: blob:");
  expect(policy).toContain("frame-src blob:");
  expect(policy).toContain("frame-ancestors 'none'");

  const result = await page.evaluate(async () => {
    const pngBytes = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ), (character) => character.charCodeAt(0));
    const imageUrl = URL.createObjectURL(new Blob([pngBytes], { type: "image/png" }));
    const frameUrl = URL.createObjectURL(new Blob(
      ["<!doctype html><title>Verified PDF preview boundary</title>"],
      { type: "text/html" },
    ));

    try {
      const imageLoaded = new Promise<boolean>((resolve) => {
        const image = new Image();
        image.alt = "Ephemeral review evidence";
        image.onload = () => resolve(image.naturalWidth === 1 && image.naturalHeight === 1);
        image.onerror = () => resolve(false);
        image.src = imageUrl;
        document.body.append(image);
      });
      const frameLoaded = new Promise<boolean>((resolve) => {
        const frame = document.createElement("iframe");
        frame.title = "Ephemeral review document";
        frame.onload = () => resolve(
          frame.contentDocument?.title === "Verified PDF preview boundary",
        );
        frame.onerror = () => resolve(false);
        frame.src = frameUrl;
        document.body.append(frame);
      });

      return {
        frameLoaded: await frameLoaded,
        imageLoaded: await imageLoaded,
      };
    } finally {
      URL.revokeObjectURL(imageUrl);
      URL.revokeObjectURL(frameUrl);
    }
  });

  expect(result).toEqual({ frameLoaded: true, imageLoaded: true });
});
