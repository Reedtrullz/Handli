"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatNok,
  type TripPurchaseTermsV2,
} from "@handleplan/domain";

import {
  createBrowserTripSnapshotRepository,
  type ActiveTripV1,
  type TripSnapshotRepository,
} from "../../../lib/trip-snapshot-repository";
import { membershipOfferConditionCopy } from "../../../lib/membership-presentation";

import styles from "./handle-mode.module.css";

type ViewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error" }
  | { kind: "ready"; active: ActiveTripV1 };

export interface HandleModeProps {
  repository: TripSnapshotRepository;
  now?: () => Date;
}

function itemDetail(active: ActiveTripV1, needId: string): string {
  const assignment = active.snapshot.plan.assignments.find((candidate) =>
    candidate.needId === needId);
  if (assignment === undefined) return "";
  const packages = assignment.fulfilment.packageCount;
  return `${packages} ${packages === 1 ? "pakke" : "pakker"}`;
}

function formatMeasure(measure: TripPurchaseTermsV2["requested"]): string {
  if (measure.unit === "package") {
    return `${measure.amount} ${measure.amount === 1 ? "pakke" : "pakker"}`;
  }
  if (measure.unit === "piece") {
    return `${measure.amount.toLocaleString("nb-NO")} stk`;
  }
  return `${measure.amount.toLocaleString("nb-NO")} ${measure.unit}`;
}

function formatEvidenceTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString("nb-NO", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function offerPricing(purchase: TripPurchaseTermsV2): string | undefined {
  const pricing = purchase.appliedOffer?.pricing;
  if (pricing === undefined) return undefined;
  return pricing.kind === "unit"
    ? `${formatNok(pricing.unitPriceOre)} per pakke`
    : `${pricing.quantity} for ${formatNok(pricing.totalOre)}`;
}

function offerConditions(purchase: TripPurchaseTermsV2): string | undefined {
  const offer = purchase.appliedOffer;
  if (offer === undefined) return undefined;
  return [...new Set(offer.conditions.map((condition) => {
    if (condition.kind === "public") return "offentlig tilbud";
    if (condition.kind === "minimum-quantity") return `minst ${condition.quantity} pakker`;
    return membershipOfferConditionCopy(offer.chainId);
  }))].join(" · ");
}

function offerScope(purchase: TripPurchaseTermsV2): string | undefined {
  const scope = purchase.appliedOffer?.applicability.geographicScope;
  if (scope === undefined) return undefined;
  switch (scope.kind) {
    case "national":
      return `nasjonalt (${scope.countryCode})`;
    case "regions":
      return `regioner: ${scope.regionCodes.join(", ")}`;
    case "stores":
      return `butikker: ${scope.storeIds.join(", ")}`;
    case "unknown":
      return `ukjent område: ${scope.reason}`;
  }
}

function PurchaseDetail({ active, needId }: { active: ActiveTripV1; needId: string }) {
  if (active.snapshot.contractVersion !== 2) {
    return <small>{itemDetail(active, needId)}</small>;
  }
  const purchase = active.snapshot.checklistItems.find((item) => item.needId === needId)?.purchase;
  if (purchase === undefined) return null;

  const offer = purchase.appliedOffer;
  const pricing = offerPricing(purchase);
  const conditions = offerConditions(purchase);
  const channels = offer?.applicability.channels.map((channel) =>
    channel === "in-store" ? "i butikk" : "på nett").join(" og ");
  return (
    <span className={styles.purchaseDetails}>
      <small>
        Behov {formatMeasure(purchase.requested)} · kjøp {formatMeasure(purchase.purchased)}
        {" "}({purchase.packageCount} {purchase.packageCount === 1 ? "pakke" : "pakker"} à {formatMeasure(purchase.packageMeasure)})
        {" "}· {formatMeasure(purchase.surplus)} til overs
      </small>
      <small>
        Forventet {formatNok(purchase.checkoutTotalOre)} · ordinært {formatNok(purchase.ordinaryTotalOre)}
        {purchase.savedOre > 0 ? ` · ${formatNok(purchase.savedOre)} spart` : " · ingen tilbudssparing"}
      </small>
      <small>
        Ordinær pris observert {formatEvidenceTime(purchase.observedAt)} fra {purchase.ordinaryPrice.sourceId}
        {purchase.freshness === "eligible" ? " · kvalifisert ved planlegging" : ""}
      </small>
      {offer !== undefined && (
        <>
          <small>Tilbud: {pricing} · {conditions}</small>
          <small>
            Gjelder {formatEvidenceTime(offer.applicability.startsAt)}–{formatEvidenceTime(offer.applicability.endsAt)}
            {" "}· {channels} · {offerScope(purchase)}
          </small>
          <small>
            Tilbud observert {formatEvidenceTime(offer.capturedAt)} fra {offer.sourceId}
            {offer.beforePriceOre === undefined
              ? ""
              : ` · oppgitt førpris ${formatNok(offer.beforePriceOre)}`}
          </small>
        </>
      )}
    </span>
  );
}

function ReviewedSelectionDetail({
  active,
  needId,
}: {
  active: ActiveTripV1;
  needId: string;
}) {
  if (active.snapshot.contractVersion !== 2) return null;
  const reviewed = active.snapshot.reviewedFamilyEvidence;
  if (reviewed === undefined) return null;
  const match = reviewed.needMatches.find((candidate) => candidate.needId === needId);
  if (match?.kind !== "reviewed-family") return null;
  const assignment = active.snapshot.plan.assignments.find((candidate) =>
    candidate.needId === needId);
  const membership = assignment === undefined
    ? undefined
    : reviewed.memberships.find((candidate) =>
        candidate.familyId === match.familyId
        && candidate.canonicalProductId === assignment.canonicalProductId);
  if (membership === undefined) return null;
  const method = membership.method === "human-review"
    ? "menneskelig kontroll uten lagret identitet"
    : `kontrollregel ${membership.ruleVersion}`;
  return (
    <small>
      Godkjent varebytte: {match.family.labelNo} · {method}
      {" "}· taksonomi {reviewed.taxonomy.versionId}
    </small>
  );
}

export function HandleMode({ repository, now = () => new Date() }: HandleModeProps) {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    setActionError(false);
    try {
      const active = await repository.getActive();
      setView(active === undefined ? { kind: "empty" } : { kind: "ready", active });
    } catch {
      setView({ kind: "error" });
    }
  }, [repository]);

  useEffect(() => {
    let current = true;
    void repository.getActive().then(
      (active) => {
        if (current) setView(active === undefined ? { kind: "empty" } : { kind: "ready", active });
      },
      () => {
        if (current) setView({ kind: "error" });
      },
    );
    return () => {
      current = false;
    };
  }, [repository]);

  const toggle = async (itemId: string, completed: boolean) => {
    if (view.kind !== "ready") return;
    setBusy(true);
    setActionError(false);
    try {
      const active = await repository.setCompleted(
        view.active.snapshot.id,
        itemId,
        completed,
      );
      setView({ kind: "ready", active });
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (view.kind !== "ready") return;
    setBusy(true);
    setActionError(false);
    try {
      await repository.finish(view.active.snapshot.id);
      setView({ kind: "empty" });
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (view.kind !== "ready") return;
    setBusy(true);
    setActionError(false);
    try {
      await repository.delete(view.active.snapshot.id);
      setView({ kind: "empty" });
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.frame}>
      <header className={styles.header}>
        <a className={styles.wordmark} href="/planlegg" aria-label="Handleplan, Planlegg">
          <span className={styles.mark} aria-hidden="true"><span /></span>
          Handleplan
        </a>
        <nav aria-label="Hovedmeny">
          <a href="/planlegg">Planlegg</a>
          <a href="/oppdag">Oppdag</a>
        </nav>
      </header>

      <main className={styles.main}>
        <div className={styles.titleRow}>
          <div>
            <p className={styles.eyebrow}>Handlemodus</p>
            <h1>Ta handleplanen med i butikken</h1>
          </div>
          {view.kind === "ready" && <span className={styles.offlineBadge}>Lagret på enheten</span>}
        </div>

        {view.kind === "loading" && (
          <section className={styles.stateCard} role="status" aria-live="polite">
            <h2>Åpner handleturen …</h2>
            <p>Den aktive planen leses bare fra denne enheten.</p>
          </section>
        )}

        {view.kind === "error" && (
          <section className={styles.stateCard} role="alert">
            <h2>Handlemodus kunne ikke åpnes</h2>
            <p>Ingen uverifisert eller skadet tur vises. Prøv igjen når lokal lagring er tilgjengelig.</p>
            <button type="button" onClick={() => void load()}>Prøv igjen</button>
          </section>
        )}

        {view.kind === "empty" && (
          <section className={styles.stateCard} aria-labelledby="empty-trip-title">
            <h2 id="empty-trip-title">Ingen aktiv handletur</h2>
            <p>Velg en verifisert plan før du starter Handlemodus.</p>
            <a className={styles.primaryLink} href="/planlegg">Gå til Planlegg</a>
          </section>
        )}

        {view.kind === "ready" && (() => {
          const { active } = view;
          const completed = new Set(active.completedItemIds);
          const total = active.snapshot.checklistItems.length;
          const done = completed.size;
          const stale = now().getTime() > Date.parse(active.snapshot.expiresAt);
          const groups = active.snapshot.navigation.stops.map((stop) => ({
            chainId: stop.chainId,
            name: stop.name,
            items: active.snapshot.checklistItems.filter(({ chainId }) => chainId === stop.chainId),
          }));
          return (
            <>
              <section className={styles.progressCard} aria-labelledby="trip-progress-title">
                <div>
                  <h2 id="trip-progress-title">
                    {done} av {total} {total === 1 ? "vare" : "varer"}
                  </h2>
                  <p>Avkrysning lagres lokalt på denne enheten.</p>
                </div>
                <progress
                  aria-label={`${done} av ${total} ${total === 1 ? "vare" : "varer"} fullført`}
                  max={total}
                  value={done}
                />
              </section>

              {stale && (
                <div className={styles.warning} role="status">
                  <strong>Prisgrunnlaget kan være utdatert.</strong>
                  <span>Planen utløp {new Date(active.snapshot.expiresAt).toLocaleString("nb-NO")}.</span>
                </div>
              )}

              {active.snapshot.navigation.kind === "route" && (
                <p className={styles.routeSummary}>
                  Estimert reise{active.snapshot.navigation.aggregate.mode === undefined
                    ? ""
                    : active.snapshot.navigation.aggregate.mode === "car"
                      ? " med bil"
                      : " med sykkel"}: {Math.ceil(active.snapshot.navigation.aggregate.durationSeconds / 60)} min,
                  {" "}{(active.snapshot.navigation.aggregate.distanceMeters / 1_000).toLocaleString("nb-NO", {
                    maximumFractionDigits: 1,
                  })} km. Startstedet er ikke lagret.
                  {active.snapshot.navigation.aggregate.sourceId === "valhalla-openstreetmap-self-hosted" ? (
                    <> Rutedata: <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap-bidragsytere</a>.</>
                  ) : null}
                </p>
              )}

              <div className={styles.storeList}>
                {groups.map((group) => {
                  const headingId = `store-${group.chainId}`;
                  return (
                    <section className={styles.storeCard} key={group.chainId} aria-labelledby={headingId}>
                      <div className={styles.storeHeading}>
                        <h2 id={headingId}>{group.name}</h2>
                        <span>{group.items.filter(({ id }) => completed.has(id)).length}/{group.items.length}</span>
                      </div>
                      <ul>
                        {group.items.map((item) => (
                          <li key={item.id}>
                            <label>
                              <input
                                checked={completed.has(item.id)}
                                disabled={busy}
                                onChange={(event) => void toggle(item.id, event.currentTarget.checked)}
                                type="checkbox"
                              />
                              <span>
                                <strong>{item.label}</strong>
                                <ReviewedSelectionDetail active={active} needId={item.needId} />
                                <PurchaseDetail active={active} needId={item.needId} />
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>

              <details className={styles.caveats}>
                <summary>Forbehold for turen</summary>
                <ul>{active.snapshot.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
              </details>

              {actionError && (
                <p className={styles.actionError} role="alert">
                  Endringen kunne ikke lagres. Den viste planen er ikke endret.
                </p>
              )}

              <div className={styles.actions}>
                <button
                  className={styles.finishButton}
                  disabled={busy || done !== total}
                  onClick={() => void finish()}
                  type="button"
                >
                  Fullfør og slett turen
                </button>
                <button disabled={busy} onClick={() => void remove()} type="button">
                  Slett tur
                </button>
              </div>
            </>
          );
        })()}
      </main>
    </div>
  );
}

export default function HandlePage() {
  const repository = useMemo(() => createBrowserTripSnapshotRepository(), []);
  return <HandleMode repository={repository} />;
}
