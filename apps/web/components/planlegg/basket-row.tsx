"use client";

import type { MatchRule, Need, Product } from "@handleplan/domain";
import { useState } from "react";

interface BasketRowProps {
  need: Need;
  rule: MatchRule;
  product?: Product;
  onQuantityChange: (quantity: number) => void;
  onRemove: () => void;
}

export function BasketRow({
  need,
  rule,
  product,
  onQuantityChange,
  onRemove,
}: BasketRowProps) {
  const [quantityDraft, setQuantityDraft] = useState(String(need.quantity));

  const label = product?.name ?? need.query;
  const matchLabel =
    rule.mode === "exact"
      ? "Eksakt produkt"
      : rule.mode === "flexible"
        ? "Samme type, valgfritt merke"
        : "Valgfritt merke";
  const explanation = rule.mode === "exact" ? `Låst til ${product?.name ?? need.query}` : rule.explanation;

  function commitQuantity(): void {
    const quantity = Number(quantityDraft);
    if (Number.isInteger(quantity) && quantity >= 1 && quantity <= 999) {
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
        min="1"
        max="999"
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
