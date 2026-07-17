"use client";

import type { MatchRule, Need, Product } from "@handleplan/domain";
import { useState } from "react";

import { type BrowserFamilyConfirmation } from "../../lib/browser-basket";
import {
  basketQuantityCopy,
  basketQuantityDraft,
  basketQuantityErrorCopy,
  parseBasketQuantityInput,
  type BasketCanonicalQuantityUnit,
  type BasketQuantityInputUnit,
} from "../../lib/basket-quantity";
import { QuantityControl } from "./quantity-control";

interface BasketRowProps {
  need: Need;
  rule: MatchRule;
  product?: Product;
  familyConfirmation?: BrowserFamilyConfirmation;
  onQuantityChange: (
    quantity: number,
    quantityUnit: BasketCanonicalQuantityUnit,
  ) => void;
  onQuantityValidityChange: (valid: boolean) => void;
  onRemove: () => void;
}

export function BasketRow({
  need,
  rule,
  product,
  familyConfirmation,
  onQuantityChange,
  onQuantityValidityChange,
  onRemove,
}: BasketRowProps) {
  const initialQuantity = basketQuantityDraft(need.quantity, need.quantityUnit);
  const [quantityAmount, setQuantityAmount] = useState(initialQuantity.amount);
  const [quantityInputUnit, setQuantityInputUnit] = useState<BasketQuantityInputUnit>(
    initialQuantity.inputUnit,
  );
  const [legacyEach, setLegacyEach] = useState(initialQuantity.legacyEach);

  const label = product?.name ?? need.query;
  const matchLabel =
    rule.mode === "exact"
      ? "Eksakt produkt"
      : familyConfirmation === undefined
        ? "Må godkjennes på nytt"
        : "Gjennomgått varetype";
  const explanation = rule.mode === "exact"
    ? `Låst til ${product?.name ?? need.query}`
    : familyConfirmation === undefined
      ? "Eldre fleksibelt valg uten publisert kandidatbekreftelse"
      : `${familyConfirmation.candidateCount} ${familyConfirmation.candidateCount === 1 ? "godkjent kandidat" : "godkjente kandidater"}${familyConfirmation.allowedBrands === undefined ? ", valgfritt merke" : `: ${familyConfirmation.allowedBrands.join(" eller ")}`}`;

  const parsedQuantity = parseBasketQuantityInput(quantityAmount, quantityInputUnit);

  function changeAmount(amount: string): void {
    setQuantityAmount(amount);
    const parsed = parseBasketQuantityInput(amount, quantityInputUnit);
    onQuantityValidityChange(parsed !== undefined);
    if (parsed === undefined) return;
    setLegacyEach(false);
    onQuantityChange(parsed.quantity, parsed.quantityUnit);
  }

  function changeInputUnit(inputUnit: BasketQuantityInputUnit, amount: string): void {
    setQuantityInputUnit(inputUnit);
    setQuantityAmount(amount);
    const parsed = parseBasketQuantityInput(amount, inputUnit);
    onQuantityValidityChange(parsed !== undefined);
    if (parsed === undefined) return;
    setLegacyEach(false);
    onQuantityChange(parsed.quantity, parsed.quantityUnit);
  }

  return (
    <li className="basket-row" aria-label={label}>
      <div className="basket-row-quantity">
        <QuantityControl
          amount={quantityAmount}
          inputUnit={quantityInputUnit}
          label={label}
          onAmountChange={changeAmount}
          onInputUnitChange={changeInputUnit}
        />
        {parsedQuantity === undefined ? (
          <small className="quantity-error" role="alert">
            {basketQuantityErrorCopy(quantityInputUnit)}
          </small>
        ) : null}
        {legacyEach ? (
          <small className="quantity-guidance">
            Eldre «antall» vises som pakker, i tråd med den opprinnelige planbetydningen.
          </small>
        ) : null}
      </div>
      <div className="basket-row-copy">
        <strong>{label}</strong>
        <span className="basket-quantity-copy">
          Behov: {parsedQuantity === undefined
            ? "ugyldig mengde"
            : basketQuantityCopy(parsedQuantity.quantity, parsedQuantity.quantityUnit)}
        </span>
        <div className="match-copy">
          <span className="match-badge">{matchLabel}</span>
          {explanation !== matchLabel ? <span>{explanation}</span> : null}
        </div>
      </div>
      <button className="remove-button" type="button" aria-label={`Fjern ${label}`} onClick={onRemove}>
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}
