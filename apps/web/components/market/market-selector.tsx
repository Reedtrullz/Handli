"use client";

import type { MarketContextV1 } from "@handleplan/domain";

import {
  allowedLaunchMarketFromQueryValue,
  launchMarketIsCandidateUnverified,
  launchMarketLabel,
  launchMarketOptions,
  marketContextQueryValue,
} from "../../lib/launch-markets";

interface MarketSelectorProps {
  id: string;
  marketContext: MarketContextV1 | null;
  onChange: (marketContext: MarketContextV1) => void;
}

export function MarketSelector({
  id,
  marketContext,
  onChange,
}: MarketSelectorProps) {
  const candidateUnverified = marketContext === null
    ? false
    : launchMarketIsCandidateUnverified(marketContext);
  return (
    <section className="market-selector">
      <label id={`${id}-label`} htmlFor={id}>Prisområde</label>
      <select
        id={id}
        value={marketContext === null ? "" : marketContextQueryValue(marketContext)}
        onChange={(event) => {
          const next = allowedLaunchMarketFromQueryValue(event.target.value);
          if (next !== undefined) onChange(next);
        }}
      >
        {marketContext === null ? <option value="">Velg prisområde på nytt</option> : null}
        {launchMarketOptions.map((option) => (
          <option
            key={marketContextQueryValue(option.marketContext)}
            value={marketContextQueryValue(option.marketContext)}
          >
            {option.label}{option.candidateUnverified ? " — kandidat, ikke verifisert" : ""}
          </option>
        ))}
      </select>
      <small role="status">
        {marketContext === null
          ? "Det tidligere prisområdet er ikke lenger tilgjengelig. Handlelisten er bevart, men ingen prisforespørsel sendes før du velger et tilgjengelig område."
          : candidateUnverified
          ? `${launchMarketLabel(marketContext)} er en kandidatregion i beskyttet alfa, ikke lanseringsklar. Handleplan bruker nasjonale og uttrykkelig matchende regiondata; butikkspesifikke data holdes utenfor.`
          : "Bruker bare data med nasjonalt omfang. Dette betyr ikke at prisdekningen er landsdekkende. Velg en kandidatregion eksplisitt for å ta med matchende regiondata."}
      </small>
    </section>
  );
}
