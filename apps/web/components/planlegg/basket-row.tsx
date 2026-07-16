"use client";

import type { MatchRule, Need, Product } from "@handleplan/domain";
import { useState } from "react";

import {
  BASKET_QUANTITY_MAX,
  BASKET_QUANTITY_MIN,
  type BrowserFamilyConfirmation,
} from "../../lib/browser-basket";

interface BasketRowProps {
  need: Need;
  rule: MatchRule;
  product?: Product;
  familyConfirmation?: BrowserFamilyConfirmation;
  onQuantityChange: (quantity: number) => void;
  onRemove: () => void;
}

export function BasketRow({
  need,
  rule,
  product,
  familyConfirmation,
  onQuantityChange,
  onRemove,
}: BasketRowProps) {
  const [quantityDraft, setQuantityDraft] = useState(String(need.quantity));

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

  function commitQuantity(): void {
    const quantity = Number(quantityDraft);
    if (
      Number.isSafeInteger(quantity) &&
      quantity >= BASKET_QUANTITY_MIN &&
      quantity <= BASKET_QUANTITY_MAX
    ) {
      onQuantityChange(quantity);
    } else {
      setQuantityDraft(String(need.quantity));
    }
  }

  return (
    <li className="basket-row" aria-label={label}>
      <input
        className="row-quantity"
        type="number"
        min={BASKET_QUANTITY_MIN}
        max={BASKET_QUANTITY_MAX}
        step="1"
        inputMode="numeric"
        aria-label={`Antall ${label}`}
        value={quantityDraft}
        onChange={(event) => setQuantityDraft(event.target.value)}
        onBlur={commitQuantity}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <div className="basket-row-copy">
        <strong>{label}</strong>
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
