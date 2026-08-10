"use client";

import {
  BASKET_COUNT_QUANTITY_MAX,
  BASKET_MEASURE_QUANTITY_MAX,
  basketQuantityAmountAfterUnitChange,
  basketQuantityAmountForInputUnit,
  parseBasketQuantityInput,
  type BasketQuantityInputUnit,
} from "../../lib/basket-quantity";

interface QuantityControlProps {
  amount: string;
  disabled?: boolean;
  label: string;
  onAmountChange: (amount: string) => void;
  onInputUnitChange: (unit: BasketQuantityInputUnit, amount: string) => void;
  inputUnit: BasketQuantityInputUnit;
}

const QUANTITY_UNITS: ReadonlyArray<{
  label: string;
  value: BasketQuantityInputUnit;
}> = [
  { label: "pakker", value: "package" },
  { label: "stk.", value: "piece" },
  { label: "g", value: "g" },
  { label: "kg", value: "kg" },
  { label: "ml", value: "ml" },
  { label: "l", value: "l" },
];

function canonicalStep(inputUnit: BasketQuantityInputUnit): number {
  return inputUnit === "kg" || inputUnit === "l" ? 100 : 1;
}

function canonicalMaximum(inputUnit: BasketQuantityInputUnit): number {
  return inputUnit === "piece" || inputUnit === "package"
    ? BASKET_COUNT_QUANTITY_MAX
    : BASKET_MEASURE_QUANTITY_MAX;
}

export function QuantityControl({
  amount,
  disabled = false,
  label,
  onAmountChange,
  onInputUnitChange,
  inputUnit,
}: QuantityControlProps) {
  const parsed = parseBasketQuantityInput(amount, inputUnit);
  const step = canonicalStep(inputUnit);
  const canDecrease = parsed !== undefined && parsed.quantity > step;
  const canIncrease = parsed !== undefined
    && parsed.quantity + step <= canonicalMaximum(inputUnit);

  function adjust(direction: -1 | 1): void {
    const current = parseBasketQuantityInput(amount, inputUnit);
    if (current === undefined) return;
    const next = current.quantity + direction * step;
    if (next < 1 || next > canonicalMaximum(inputUnit)) return;
    onAmountChange(basketQuantityAmountForInputUnit(next, inputUnit));
  }

  return (
    <div className="quantity-control" role="group" aria-label={label}>
      <button
        type="button"
        aria-label={`Reduser mengde for ${label}`}
        disabled={disabled || !canDecrease}
        onClick={() => adjust(-1)}
      >−</button>
      <label>
        <span className="sr-only">Mengde for {label}</span>
        <input
          aria-invalid={parsed === undefined}
          autoComplete="off"
          disabled={disabled}
          inputMode="decimal"
          maxLength={12}
          onChange={(event) => onAmountChange(event.target.value)}
          type="text"
          value={amount}
        />
      </label>
      <label>
        <span className="sr-only">Enhet for {label}</span>
        <select
          disabled={disabled}
          onChange={(event) => {
            const nextInputUnit = event.target.value as BasketQuantityInputUnit;
            onInputUnitChange(
              nextInputUnit,
              basketQuantityAmountAfterUnitChange(amount, inputUnit, nextInputUnit),
            );
          }}
          value={inputUnit}
        >
          {QUANTITY_UNITS.map((unit) => (
            <option key={unit.value} value={unit.value}>{unit.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-label={`Øk mengde for ${label}`}
        disabled={disabled || !canIncrease}
        onClick={() => adjust(1)}
      >+</button>
    </div>
  );
}
