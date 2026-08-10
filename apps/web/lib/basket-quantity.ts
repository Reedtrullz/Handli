export const BASKET_QUANTITY_MIN = 1;

/** Whole packages or pieces stay deliberately bounded for usable basket edits. */
export const BASKET_COUNT_QUANTITY_MAX = 999;

/**
 * Gram and millilitre needs use canonical base units. This admits ordinary
 * household quantities such as 1 kg (1 000 g) and 1.5 l (1 500 ml) without
 * approaching the safe-integer/fulfilment overflow boundary.
 */
export const BASKET_MEASURE_QUANTITY_MAX = 999_999;

/** @deprecated Count-only compatibility name used by existing callers. */
export const BASKET_QUANTITY_MAX = BASKET_COUNT_QUANTITY_MAX;

export type BasketCanonicalQuantityUnit = "piece" | "package" | "g" | "ml";
export type BasketQuantityInputUnit = BasketCanonicalQuantityUnit | "kg" | "l";

export interface BasketQuantity {
  quantity: number;
  quantityUnit: BasketCanonicalQuantityUnit;
}

export interface BasketQuantityDraft {
  amount: string;
  inputUnit: BasketQuantityInputUnit;
  legacyEach: boolean;
}

const WHOLE_AMOUNT = /^(?:0|[1-9]\d*)$/;
const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:[.,](\d{1,3}))?$/;

function parseScaledAmount(rawAmount: string, scale: 1 | 1_000): number | undefined {
  const amount = rawAmount.trim();
  const match = (scale === 1 ? WHOLE_AMOUNT : DECIMAL_AMOUNT).exec(amount);
  if (match === null) return undefined;

  const [wholePart = "", fractionPart = ""] = amount.split(/[.,]/u);
  const canonical = BigInt(wholePart) * BigInt(scale)
    + BigInt(fractionPart.padEnd(scale === 1 ? 0 : 3, "0") || "0");
  if (canonical < BigInt(BASKET_QUANTITY_MIN)) return undefined;
  return Number(canonical);
}

/**
 * Parses a user-facing amount without floating-point rounding. kg/l are
 * explicit input conveniences only; the returned contract is always g/ml.
 */
export function parseBasketQuantityInput(
  rawAmount: string,
  inputUnit: BasketQuantityInputUnit,
): BasketQuantity | undefined {
  const scaled = inputUnit === "kg" || inputUnit === "l";
  const quantity = parseScaledAmount(rawAmount, scaled ? 1_000 : 1);
  if (quantity === undefined) return undefined;

  const quantityUnit = inputUnit === "kg"
    ? "g"
    : inputUnit === "l"
      ? "ml"
      : inputUnit;
  const maximum = quantityUnit === "g" || quantityUnit === "ml"
    ? BASKET_MEASURE_QUANTITY_MAX
    : BASKET_COUNT_QUANTITY_MAX;
  return quantity <= maximum ? { quantity, quantityUnit } : undefined;
}

export function isValidBasketQuantity(
  quantity: number,
  quantityUnit: "each" | BasketCanonicalQuantityUnit,
): boolean {
  if (!Number.isSafeInteger(quantity) || quantity < BASKET_QUANTITY_MIN) return false;
  const maximum = quantityUnit === "g" || quantityUnit === "ml"
    ? BASKET_MEASURE_QUANTITY_MAX
    : BASKET_COUNT_QUANTITY_MAX;
  return quantity <= maximum;
}

function scaledDraft(quantity: number): string {
  const whole = Math.floor(quantity / 1_000);
  const fraction = String(quantity % 1_000).padStart(3, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? String(whole) : `${whole},${fraction}`;
}

export function basketQuantityAmountForInputUnit(
  canonicalQuantity: number,
  inputUnit: BasketQuantityInputUnit,
): string {
  return inputUnit === "kg" || inputUnit === "l"
    ? scaledDraft(canonicalQuantity)
    : String(canonicalQuantity);
}

function physicalDimension(inputUnit: BasketQuantityInputUnit): "mass" | "volume" | "count" {
  if (inputUnit === "g" || inputUnit === "kg") return "mass";
  if (inputUnit === "ml" || inputUnit === "l") return "volume";
  return "count";
}

/**
 * Keeps the exact physical amount when merely changing the display scale
 * (g/kg or ml/l). Switching between package and piece is an explicit semantic
 * choice and therefore keeps the entered whole count while changing its unit.
 */
export function basketQuantityAmountAfterUnitChange(
  amount: string,
  currentInputUnit: BasketQuantityInputUnit,
  nextInputUnit: BasketQuantityInputUnit,
): string {
  const current = parseBasketQuantityInput(amount, currentInputUnit);
  if (
    current === undefined
    || physicalDimension(currentInputUnit) !== physicalDimension(nextInputUnit)
  ) {
    return amount;
  }
  if (physicalDimension(currentInputUnit) === "count") return amount;
  return basketQuantityAmountForInputUnit(current.quantity, nextInputUnit);
}

/**
 * Produces an exact, editable display. Large metric quantities are expressed
 * in kg/l, while legacy `each` is surfaced explicitly as the package meaning
 * used by the public API rather than being hidden from the user.
 */
export function basketQuantityDraft(
  quantity: number,
  quantityUnit: "each" | BasketCanonicalQuantityUnit,
): BasketQuantityDraft {
  if (quantityUnit === "each") {
    return { amount: String(quantity), inputUnit: "package", legacyEach: true };
  }
  if (quantityUnit === "g" && quantity >= 1_000) {
    return { amount: scaledDraft(quantity), inputUnit: "kg", legacyEach: false };
  }
  if (quantityUnit === "ml" && quantity >= 1_000) {
    return { amount: scaledDraft(quantity), inputUnit: "l", legacyEach: false };
  }
  return { amount: String(quantity), inputUnit: quantityUnit, legacyEach: false };
}

export function basketQuantityCopy(
  quantity: number,
  quantityUnit: "each" | BasketCanonicalQuantityUnit,
): string {
  const draft = basketQuantityDraft(quantity, quantityUnit);
  const unit = draft.inputUnit === "piece"
    ? "stk."
    : draft.inputUnit === "package"
      ? quantity === 1 ? "pakke" : "pakker"
      : draft.inputUnit;
  return `${draft.amount} ${unit}`;
}

export function basketQuantityErrorCopy(inputUnit: BasketQuantityInputUnit): string {
  if (inputUnit === "piece" || inputUnit === "package") {
    return `Oppgi et helt antall fra ${BASKET_QUANTITY_MIN} til ${BASKET_COUNT_QUANTITY_MAX}.`;
  }
  if (inputUnit === "kg" || inputUnit === "l") {
    return `Oppgi en positiv mengde under 1 000 ${inputUnit} med maksimalt tre desimaler.`;
  }
  return `Oppgi et helt antall fra ${BASKET_QUANTITY_MIN} til ${BASKET_MEASURE_QUANTITY_MAX}.`;
}
