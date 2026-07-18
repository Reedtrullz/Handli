"use client";

import {
  publicSourceStatusResponseSchema,
  type PublicSourceStatusEntry,
  type PublicSourceStatusOverall,
} from "@handleplan/domain";
import { useEffect, useState } from "react";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; value: ReturnType<typeof publicSourceStatusResponseSchema.parse> }
  | { kind: "unavailable" };

const OVERALL_LABELS: Record<PublicSourceStatusOverall, string> = {
  degraded: "Degradert",
  "no-approved-sources": "Ingen godkjente kilder",
  operational: "Operativ",
  unknown: "Ukjent",
};

const HEALTH_LABELS = {
  degraded: "Degradert",
  disabled: "Deaktivert",
  failed: "Feilet",
  healthy: "Frisk",
} as const;

const INGESTION_LABELS = {
  cancelled: "Avbrutt",
  completed: "Fullført",
  degraded: "Degradert",
  failed: "Feilet",
} as const;

const SOURCE_KIND_LABELS = {
  catalog: "Produktkatalog",
  geocoder: "Geokoding",
  legacy: "Eldre dataløp",
  offer: "Offisielle tilbud",
  "ordinary-price": "Ordinære priser",
  routing: "Reisetid",
  store: "Butikkatalog",
} as const;

const RUNTIME_STATE_LABELS = {
  approved: "Godkjent",
  blocked: "Blokkert",
  conditional: "Betinget",
  revoked: "Tilbakekalt",
} as const;

const dateTimeFormatter = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Oslo",
});

function formatTimestamp(timestamp: string): string {
  return dateTimeFormatter.format(new Date(timestamp));
}

function sourceKey(entry: PublicSourceStatusEntry): string {
  return `${entry.source.id}:${entry.scope?.id ?? "unscoped"}`;
}

function SourceEntry({ entry }: { entry: PublicSourceStatusEntry }) {
  const successes = [
    ["Siste oppdagelse", entry.health?.lastSuccess.discoveryAt],
    ["Siste innhenting", entry.health?.lastSuccess.captureAt],
    ["Siste publisering", entry.health?.lastSuccess.publishAt],
    ["Nyeste kvalifiserte evidens", entry.health?.lastSuccess.eligibleEvidenceAt],
  ] as const;
  return (
    <article>
      <header>
        <div>
          <h3>{entry.source.displayName}</h3>
          <p>{SOURCE_KIND_LABELS[entry.source.kind]} · {entry.scope?.label ?? "Uspesifisert virkeområde"}</p>
        </div>
        <strong>{entry.health === null
          ? "Ikke målt"
          : entry.health.freshness === "stale"
            ? "Utdatert måling"
            : HEALTH_LABELS[entry.health.state]}</strong>
      </header>
      <dl>
        <div>
          <dt>Styringsstatus</dt>
          <dd>{entry.governanceState === "approved" ? "Godkjent" : "Ikke godkjent"}</dd>
        </div>
        <div>
          <dt>Registrert kildestatus</dt>
          <dd>{RUNTIME_STATE_LABELS[entry.source.runtimeState]}</dd>
        </div>
        {entry.scope !== null ? (
          <div>
            <dt>Geografisk avgrensning</dt>
            <dd>{entry.scope.label} ({entry.scope.countryCode}) · {entry.scope.state === "active" ? "aktiv" : "utgått"}</dd>
          </div>
        ) : null}
        {entry.health !== null ? (
          <div>
            <dt>Helse målt</dt>
            <dd>{formatTimestamp(entry.health.recordedAt)}</dd>
          </div>
        ) : null}
        {successes.flatMap(([label, timestamp]) => timestamp == null ? [] : [(
          <div key={label}>
            <dt>{label}</dt>
            <dd>{formatTimestamp(timestamp)}</dd>
          </div>
        )])}
        {entry.latestTerminalIngestion !== null ? (
          <div>
            <dt>Siste avsluttede kildeinnlesing (alle virkeområder)</dt>
            <dd>{INGESTION_LABELS[entry.latestTerminalIngestion.state]} · {formatTimestamp(entry.latestTerminalIngestion.completedAt)}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}

export function SourceStatusPanel() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/source-status", {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("unavailable");
      const parsed = publicSourceStatusResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("invalid");
      setState({ kind: "ready", value: parsed.data });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ kind: "unavailable" });
    });
    return () => controller.abort();
  }, []);

  return (
    <section className="trust-card source-status-panel" aria-labelledby="source-status-heading">
      <div className="source-status-heading">
        <div>
          <p className="eyebrow">Operativ kildehelse</p>
          <h2 id="source-status-heading">Registrerte dataløp</h2>
        </div>
        {state.kind === "ready" ? <strong>{OVERALL_LABELS[state.value.overall]}</strong> : null}
      </div>
      {state.kind === "loading" ? <p role="status">Henter avgrenset kildehelse …</p> : null}
      {state.kind === "unavailable" ? (
        <p role="status">
          Kildehelse kan ikke leses nå. Det endrer ikke lanseringsporten eller den
          statiske dekningsstatusen over.
        </p>
      ) : null}
      {state.kind === "ready" && state.value.entries.length === 0 ? (
        <p>Ingen registrerte kilder har et publisert helsesnapshot.</p>
      ) : null}
      {state.kind === "ready" && state.value.entries.length > 0 ? (
        <div className="source-status-grid">
          {state.value.entries.map((entry) => (
            <SourceEntry entry={entry} key={sourceKey(entry)} />
          ))}
        </div>
      ) : null}
      {state.kind === "ready" && state.value.hasMore ? (
        <p>Listen er avgrenset. Flere registrerte dataløp finnes enn det som vises her.</p>
      ) : null}
      <p className="source-status-boundary">
        Dette er en delvis, tillatt visning av siste registrerte driftshelse. Den
        dokumenterer ikke aktiv kildekobling, prisdekning, rett til offentlig rangering
        eller lagerstatus.
        Feildetaljer, køinnhold og forespørselsdata publiseres ikke.
      </p>
    </section>
  );
}
