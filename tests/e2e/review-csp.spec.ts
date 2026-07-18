import { expect, test } from "@playwright/test";

test("the private review route scopes ephemeral image object URLs and blocks document frames", async ({ page }) => {
  const response = await page.goto("/review");
  const policy = response?.headers()["content-security-policy"] ?? "";

  expect(policy).toContain("img-src 'self' data: blob:");
  expect(policy).toContain("frame-src 'none'");
  expect(policy).toContain("frame-ancestors 'none'");

  const result = await page.evaluate(async () => {
    const pngBytes = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ), (character) => character.charCodeAt(0));
    const imageUrl = URL.createObjectURL(new Blob([pngBytes], { type: "image/png" }));
    try {
      const imageLoaded = new Promise<boolean>((resolve) => {
        const image = new Image();
        image.alt = "Ephemeral review evidence";
        image.onload = () => resolve(image.naturalWidth === 1 && image.naturalHeight === 1);
        image.onerror = () => resolve(false);
        image.src = imageUrl;
        document.body.append(image);
      });
      return { imageLoaded: await imageLoaded };
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  });

  expect(result).toEqual({ imageLoaded: true });
});
