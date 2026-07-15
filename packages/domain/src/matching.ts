import {
  matchRuleSchema,
  needSchema,
  productSchema,
  type MatchRule,
  type Need,
  type Product,
} from "./contracts";

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("nb-NO");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function matchesConstraints(product: Product, rule: MatchRule): boolean {
  if (rule.mode === "exact") {
    return product.ean === rule.exactEan;
  }

  if (
    rule.productFamily !== undefined &&
    (product.productFamily === undefined ||
      normalize(product.productFamily) !== normalize(rule.productFamily))
  ) {
    return false;
  }

  if (
    rule.mode === "constrained" &&
    rule.allowedBrands !== undefined &&
    (product.brand === undefined ||
      !rule.allowedBrands.some((brand) => normalize(brand) === normalize(product.brand!)))
  ) {
    return false;
  }

  if (rule.mode === "constrained" && rule.sizeRange !== undefined) {
    if (
      product.packageQuantity === undefined ||
      product.packageUnit !== rule.sizeRange.unit ||
      product.packageQuantity < rule.sizeRange.min ||
      product.packageQuantity > rule.sizeRange.max
    ) {
      return false;
    }
  }

  return true;
}

function productKey(product: Product): string {
  return [
    product.ean,
    product.name,
    product.brand ?? "",
    product.packageQuantity?.toString() ?? "",
    product.packageUnit ?? "",
    product.productFamily ?? "",
  ].join("\u0000");
}

export function matchProducts(
  need: Need,
  rule: MatchRule,
  products: readonly Product[],
): Product[] {
  const parsedNeed = needSchema.safeParse(need);
  const parsedRule = matchRuleSchema.safeParse(rule);
  if (
    !parsedNeed.success ||
    !parsedRule.success ||
    parsedNeed.data.matchRuleId !== parsedRule.data.id
  ) {
    return [];
  }

  const validProducts = products.flatMap((product) => {
    const parsedProduct = productSchema.safeParse(product);
    return parsedProduct.success ? [parsedProduct.data] : [];
  });
  const matches = validProducts
    .filter((product) => matchesConstraints(product, parsedRule.data))
    .sort((left, right) => compareText(productKey(left), productKey(right)));

  const uniqueByEan = new Map<string, Product>();
  for (const product of matches) {
    if (!uniqueByEan.has(product.ean)) {
      uniqueByEan.set(product.ean, product);
    }
  }

  return [...uniqueByEan.values()].sort((left, right) => compareText(left.ean, right.ean));
}
