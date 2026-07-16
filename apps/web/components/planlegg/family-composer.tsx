"use client";

import {
  reviewedFamilyCandidateInspectionRequestSchema,
  type ExactProductPlanApiProductSummary,
  type ReviewedFamilyCandidateInspectionResponse,
} from "@handleplan/domain";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  BASKET_QUANTITY_MAX,
  BASKET_QUANTITY_MIN,
  type AddReviewedFamilyInput,
} from "../../lib/browser-basket";
import {
  inspectReviewedFamilyCandidates,
  ReviewedFamilyCandidateClientError,
  type ReviewedFamilyCandidateInspection,
} from "../../lib/reviewed-family-candidates";
import { REVIEWED_FAMILY_OPTIONS } from "../../lib/reviewed-family-options";

type InspectionState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      response: ReviewedFamilyCandidateInspectionResponse;
      allowedBrands?: string[];
    }
  | { status: "error"; code: ReviewedFamilyCandidateClientError["code"] };

interface FamilyComposerProps {
  disabled?: boolean;
  existingFamilyIds: ReadonlySet<string>;
  inspectCandidates?: ReviewedFamilyCandidateInspection;
  onApprove: (input: AddReviewedFamilyInput) => void;
}

function errorCopy(code: ReviewedFamilyCandidateClientError["code"]): string {
  if (code === "NO_CANDIDATES") {
    return "Vi har ingen komplett, gjennomgått kandidatliste for dette valget ennå.";
  }
  if (code === "STALE_OR_AMBIGUOUS") {
    return "Kandidatgrunnlaget endret seg eller er tvetydig. Be om en ny gjennomgang.";
  }
  if (code === "INVALID_RESPONSE") {
    return "Kandidatgrunnlaget kunne ikke bekreftes som komplett og trygt.";
  }
  return "Kandidatgrunnlaget er utilgjengelig akkurat nå. Prøv igjen senere.";
}

function formatCandidatePackage(product: ExactProductPlanApiProductSummary): string {
  const { amount, unit } = product.packageMeasure;
  const formattedAmount = new Intl.NumberFormat("nb-NO").format(amount);
  const measure = unit === "piece"
    ? `${formattedAmount} stk.`
    : unit === "package"
      ? `${formattedAmount} ${amount === 1 ? "pakke" : "pakker"}`
      : `${formattedAmount} ${unit}`;
  return product.unitsPerPack > 1
    ? `${measure} · ${product.unitsPerPack} enheter per pakke`
    : measure;
}

export function FamilyComposer({
  disabled = false,
  existingFamilyIds,
  inspectCandidates = inspectReviewedFamilyCandidates,
  onApprove,
}: FamilyComposerProps) {
  const [familyId, setFamilyId] = useState(REVIEWED_FAMILY_OPTIONS[0].id);
  const [quantity, setQuantity] = useState(1);
  const [brandDraft, setBrandDraft] = useState("");
  const [state, setState] = useState<InspectionState>({ status: "idle" });
  const requestVersion = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);

  const selectedFamily = REVIEWED_FAMILY_OPTIONS.find(({ id }) => id === familyId)!;
  const alreadyAdded = existingFamilyIds.has(familyId);

  useEffect(() => () => controller.current?.abort(), []);

  const candidateProducts = useMemo(() => {
    if (state.status !== "ready") return [];
    const selectedSet = state.response.candidateSets.find(
      (candidateSet) => candidateSet.familyId === familyId,
    );
    if (selectedSet === undefined) return [];
    const claimsById = new Map(state.response.productClaims.map((claim) => [
      claim.canonicalProductId,
      claim.product,
    ]));
    return selectedSet.candidateProductIds.flatMap((productId) => {
      const product = claimsById.get(productId);
      return product === undefined ? [] : [product];
    });
  }, [familyId, state]);

  function invalidate(): void {
    requestVersion.current += 1;
    controller.current?.abort();
    controller.current = undefined;
    setState({ status: "idle" });
  }

  async function inspect(): Promise<void> {
    if (disabled || alreadyAdded) return;
    const rawBrands = brandDraft
      .split(",")
      .map((brand) => brand.trim())
      .filter(Boolean);
    const parsed = reviewedFamilyCandidateInspectionRequestSchema.safeParse({
      contractVersion: 2,
      families: [{
        ...(rawBrands.length === 0 ? {} : { allowedBrands: rawBrands }),
        familyId,
      }],
    });
    if (!parsed.success) {
      setState({ status: "error", code: "NO_CANDIDATES" });
      return;
    }

    const version = ++requestVersion.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setState({ status: "loading" });
    try {
      const response = await inspectCandidates(parsed.data, nextController.signal);
      if (version !== requestVersion.current || nextController.signal.aborted) return;
      const allowedBrands = parsed.data.families[0]?.allowedBrands;
      setState({
        status: "ready",
        response,
        ...(allowedBrands === undefined ? {} : { allowedBrands: [...allowedBrands] }),
      });
    } catch (error) {
      if (version !== requestVersion.current || nextController.signal.aborted) return;
      const code = error instanceof ReviewedFamilyCandidateClientError
        ? error.code
        : "UNAVAILABLE";
      if (code !== "CANCELLED") setState({ status: "error", code });
    }
  }

  function approve(): void {
    if (state.status !== "ready") return;
    const candidateSet = state.response.candidateSets.find(
      (candidate) => candidate.familyId === familyId,
    );
    if (candidateSet === undefined || candidateProducts.length === 0) return;
    onApprove({
      ...(state.allowedBrands === undefined
        ? {}
        : { allowedBrands: state.allowedBrands }),
      candidateCount: candidateSet.candidateProductIds.length,
      confirmation: {
        candidateSetId: candidateSet.candidateSetId,
        taxonomyVersionId: candidateSet.taxonomyVersionId,
        userApproved: true,
      },
      family: candidateSet.family,
      quantity,
    });
    setBrandDraft("");
    setQuantity(1);
    setState({ status: "idle" });
  }

  return (
    <section className="family-composer" aria-labelledby="family-composer-title">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">Varetype</p>
          <h2 id="family-composer-title">La Handleplan velge produkt</h2>
        </div>
      </div>
      <p>
        Velg en publisert varetype. Du får se den komplette, gjennomgåtte
        kandidatlisten før du godkjenner den.
      </p>
      <div className="family-composer-controls">
        <label>
          Varetype
          <select
            disabled={disabled}
            value={familyId}
            onChange={(event) => {
              invalidate();
              setFamilyId(event.target.value as typeof familyId);
              setBrandDraft("");
            }}
          >
            {REVIEWED_FAMILY_OPTIONS.map((family) => (
              <option key={family.id} value={family.id}>{family.labelNo}</option>
            ))}
          </select>
        </label>
        <label>
          Merker (valgfritt)
          <input
            disabled={disabled}
            value={brandDraft}
            onChange={(event) => {
              invalidate();
              setBrandDraft(event.target.value);
            }}
            placeholder="F.eks. TINE, Q"
          />
        </label>
        <label>
          Antall
          <input
            aria-label={`Antall ${selectedFamily.labelNo}`}
            disabled={disabled}
            inputMode="numeric"
            max={BASKET_QUANTITY_MAX}
            min={BASKET_QUANTITY_MIN}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (
                Number.isSafeInteger(next)
                && next >= BASKET_QUANTITY_MIN
                && next <= BASKET_QUANTITY_MAX
              ) setQuantity(next);
            }}
            type="number"
            value={quantity}
          />
        </label>
        <button
          className="secondary-button"
          disabled={disabled || alreadyAdded || state.status === "loading"}
          onClick={() => void inspect()}
          type="button"
        >
          {state.status === "loading" ? "Kontrollerer …" : "Se gjennom alternativer"}
        </button>
      </div>

      {alreadyAdded ? (
        <p role="status">{selectedFamily.labelNo} finnes allerede i kurven. Endre antallet der.</p>
      ) : null}
      {state.status === "error" ? <p role="alert">{errorCopy(state.code)}</p> : null}
      {state.status === "ready" ? (
        <div className="family-candidate-review" role="group" aria-label={`Godkjenn alternativer for ${state.response.candidateSets[0]?.family.labelNo ?? selectedFamily.labelNo}`}>
          <h3>{state.response.candidateSets[0]?.family.labelNo}</h3>
          <p>
            {candidateProducts.length} {candidateProducts.length === 1 ? "gjennomgått produkt" : "gjennomgåtte produkter"}
            {state.allowedBrands === undefined
              ? " · valgfritt merke"
              : ` · ${state.allowedBrands.join(" eller ")}`}.
          </p>
          <details open>
            <summary>Vis alle kandidatene</summary>
            <ul>
              {candidateProducts.map((product) => (
                <li key={product.gtin}>
                  <strong>{product.displayName}</strong>
                  {product.brand === undefined ? null : <span> · {product.brand}</span>}
                  <span> · {formatCandidatePackage(product)}</span>
                </li>
              ))}
            </ul>
          </details>
          <p className="plan-note">
            Medlemskapene er publisert med gjennomgangsbevis. Pris og lagerstatus
            avgjør ikke om et produkt får tilhøre varetypen.
          </p>
          <button className="primary-button" onClick={approve} type="button">
            Godkjenn kandidatlisten og legg til
          </button>
        </div>
      ) : null}
    </section>
  );
}
