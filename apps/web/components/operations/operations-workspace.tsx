"use client";

import { useEffect, useState } from "react";

import {
  operationsRuntimeSnapshotV1Schema,
  type BoundedOperationalCount,
  type OperationsRuntimeSnapshotV1,
} from "@handleplan/domain";

import styles from "./operations-workspace.module.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; snapshot: OperationsRuntimeSnapshotV1 }
  | { kind: "unavailable" };

function countLabel(count: BoundedOperationalCount): string {
  return count.capped ? "minst 10 000" : count.value.toLocaleString("nb-NO");
}
function timeLabel(value: string | null): string {
  if (value === null) return "Ikke dokumentert";
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

const governanceLabels = {
  "approved-current": "Godkjenning er gjeldende",
  "approval-incomplete": "Godkjenning er ufullstendig",
  blocked: "Blokkert",
  conditional: "Betinget",
  contradictory: "Motstridende styringsdata",
  expired: "Godkjenning er utløpt",
  revoked: "Tilbakekalt",
} as const;

const workerStatusLabels = {
  cancelled: "avbrutt",
  failed: "feilet",
  partial: "delvis",
  succeeded: "fullført",
  "timed-out": "tidsavbrudd",
} as const;

export function OperationsWorkspace() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/internal/operations/snapshot", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("unavailable");
      const parsed = operationsRuntimeSnapshotV1Schema.safeParse(await response.json());
      if (!parsed.success) throw new Error("unavailable");
      setState({ kind: "ready", snapshot: parsed.data });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ kind: "unavailable" });
    });
    return () => controller.abort();
  }, []);

  if (state.kind === "loading") {
    return <main className={styles.workspace}><p role="status">Laster aggregerte driftsdata …</p></main>;
  }
  if (state.kind === "unavailable") {
    return (
      <main className={styles.workspace}>
        <section className={styles.notice} role="alert">
          <h1>Driftsoversikten er utilgjengelig</h1>
          <p>Ingen driftsstatus kan utledes fra denne feilen. Prøv igjen senere.</p>
        </section>
      </main>
    );
  }

  const { snapshot } = state;
  return (
    <main className={styles.workspace}>
      <section className={styles.intro} aria-labelledby="operations-title">
        <p className={styles.eyebrow}>Privat operatørflate</p>
        <h1 id="operations-title">Intern drift</h1>
        <p>
          Et avgrenset øyeblikksbilde av aggregerte databasetilstander. Det inneholder
          ikke handlekurver, søk, adresser, koordinater, rå kildefiler eller vurderingsnotater.
        </p>
        <dl className={styles.metadata}>
          <div><dt>Observert</dt><dd>{timeLabel(snapshot.observedAt)}</dd></div>
          <div><dt>Kildeliste</dt><dd>{snapshot.sourceRoster.version}</dd></div>
          <div><dt>Varsling</dt><dd>Deaktivert</dd></div>
        </dl>
      </section>

      <section className={styles.notice} aria-labelledby="claim-limit-title">
        <h2 id="claim-limit-title">Hva oversikten ikke beviser</h2>
        <p>
          Radene er administrative aggregater. De beviser ikke offentlig tilgjengelighet,
          gjeldende tilbudsrettigheter, historisk rekonstruksjon eller at et varsel er levert.
        </p>
      </section>

      <section aria-labelledby="source-overview-title">
        <div className={styles.sectionHeading}>
          <h2 id="source-overview-title">Kilder</h2>
          <p>{snapshot.sources.length.toLocaleString("nb-NO")} i fast kildeliste</p>
        </div>
        <div className={styles.sourceGrid}>
          {snapshot.sources.map((source) => (
            <article className={styles.sourceCard} key={source.sourceId}>
              <header>
                <h3>{source.sourceId}</h3>
                <p>{governanceLabels[source.governanceState]}</p>
              </header>

              <dl className={styles.metrics}>
                <div>
                  <dt>Arbeidsresultater, 24 t</dt>
                  <dd>{countLabel(source.workerResults24h.total)}</dd>
                </div>
                <div>
                  <dt>Ikke fullført uten avvik, 24 t</dt>
                  <dd>{countLabel(source.workerResults24h.nonSuccessful)}</dd>
                </div>
                <div>
                  <dt>Ventende vurderingsrader</dt>
                  <dd>{countLabel(source.administrativeRows.pendingReviewCandidates)}</dd>
                </div>
                <div>
                  <dt>Publiserte rader, aktive</dt>
                  <dd>{countLabel(source.administrativeRows.activePublishedOffers)}</dd>
                </div>
                <div>
                  <dt>Publiserte rader, utløper innen 48 t</dt>
                  <dd>{countLabel(source.administrativeRows.expiringPublishedOffers)}</dd>
                </div>
                <div>
                  <dt>Publiserte rader, passert sluttdato</dt>
                  <dd>{countLabel(source.administrativeRows.expiredPublishedOffers)}</dd>
                </div>
              </dl>

              <div className={styles.evidenceGroup}>
                <h4>Siste aggregerte signaler</h4>
                <dl>
                  <div>
                    <dt>Kildehelse</dt>
                    <dd>{source.health?.state ?? "Ikke dokumentert"}</dd>
                  </div>
                  <div>
                    <dt>Helsetilstand lagret</dt>
                    <dd>{timeLabel(source.health?.persistedAt ?? null)}</dd>
                  </div>
                  <div>
                    <dt>Ordinær pris observert</dt>
                    <dd>{timeLabel(source.newestOrdinaryPriceAt)}</dd>
                  </div>
                  <div>
                    <dt>Siste tilbudsuttrekk</dt>
                    <dd>{source.latestExtraction === null
                      ? "Ikke dokumentert"
                      : `${source.latestExtraction.state}, ${timeLabel(source.latestExtraction.completedAt)}`}</dd>
                  </div>
                </dl>
              </div>

              <div className={styles.workerGroup}>
                <h4>Siste resultat per jobbtype</h4>
                {source.latestWorkerResults.length === 0 ? (
                  <p>Ingen databaseeide resultater etter operasjonsgrensen.</p>
                ) : (
                  <ul>
                    {source.latestWorkerResults.map((result) => (
                      <li key={result.jobKind}>
                        <span>{result.jobKind}</span>
                        <strong>{workerStatusLabels[result.status]}</strong>
                        <time dateTime={result.persistedAt}>{timeLabel(result.persistedAt)}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
