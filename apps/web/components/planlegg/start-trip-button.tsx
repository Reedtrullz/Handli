"use client";

import {
  type ExactProductPlanApiEvidenceEnvelope,
  type ExactProductPlanApiProductSummary,
  type PlanResultV2,
} from "@handleplan/domain";
import { useMemo, useState } from "react";

import {
  createLocalTripId,
  createStrictResultTripSnapshot,
  StrictResultTripError,
} from "../../lib/strict-result-trip";
import {
  createBrowserTripSnapshotRepository,
  TripSnapshotRepositoryError,
  type TripSnapshotRepository,
} from "../../lib/trip-snapshot-repository";

import styles from "./start-trip-button.module.css";

type StartState =
  | "idle"
  | "busy"
  | "success"
  | "existing"
  | "expired"
  | "invalid"
  | "storage-error";

export interface StartTripButtonProps {
  caveats: readonly string[];
  evidence: ExactProductPlanApiEvidenceEnvelope;
  generatedAt: string;
  plan: PlanResultV2;
  products: readonly ExactProductPlanApiProductSummary[];
  repository?: TripSnapshotRepository;
  now?: () => Date;
  createId?: () => string;
}

export function StartTripButton({
  caveats,
  createId = createLocalTripId,
  evidence,
  generatedAt,
  now = () => new Date(),
  plan,
  products,
  repository,
}: StartTripButtonProps) {
  const tripRepository = useMemo(
    () => repository ?? createBrowserTripSnapshotRepository(),
    [repository],
  );
  const [state, setState] = useState<StartState>("idle");

  async function start(): Promise<void> {
    setState("busy");
    try {
      const snapshot = createStrictResultTripSnapshot({
        caveats,
        evidence,
        generatedAt,
        now: now(),
        plan,
        products,
        tripId: createId(),
      });
      await tripRepository.start(snapshot);
      setState("success");
    } catch (error) {
      if (
        error instanceof TripSnapshotRepositoryError
        && error.code === "ACTIVE_TRIP_EXISTS"
      ) {
        setState("existing");
      } else if (error instanceof StrictResultTripError) {
        setState(error.code === "EXPIRED_EVIDENCE" ? "expired" : "invalid");
      } else {
        setState("storage-error");
      }
    }
  }

  return (
    <section className={styles.card} aria-labelledby="start-trip-title">
      <p className={styles.eyebrow}>Handlemodus</p>
      <h2 id="start-trip-title">Ta planen med i butikken</h2>
      <p className={styles.copy}>Lagre denne prisplanen og kryss av varene underveis.</p>

      {(state === "idle" || state === "busy" || state === "storage-error") && (
        <button
          className={styles.button}
          disabled={state === "busy"}
          onClick={() => void start()}
          type="button"
        >
          {state === "busy" ? "Lagrer handletur …" : "Start Handlemodus"}
        </button>
      )}

      {state === "success" && (
        <div className={styles.status} role="status" aria-live="polite">
          <strong>Handleturen er lagret på denne enheten.</strong>
          <a href="/planlegg/handle">Åpne Handlemodus</a>
        </div>
      )}

      {state === "existing" && (
        <div className={styles.status} role="status" aria-live="polite">
          <strong>En aktiv handletur finnes allerede.</strong>
          <span>Den eksisterende turen ble ikke erstattet.</span>
          <a href="/planlegg/handle">Åpne aktiv handletur</a>
        </div>
      )}

      {(state === "expired" || state === "invalid") && (
        <div className={styles.error} role="alert">
          <strong>{state === "expired"
            ? "Prisgrunnlaget er utløpt."
            : "Prisgrunnlaget kunne ikke bekreftes."}</strong>
          <span>Beregn en ny plan før du starter Handlemodus.</span>
          <a href="/planlegg">Gå til Planlegg</a>
        </div>
      )}

      {state === "storage-error" && (
        <p className={styles.error} role="alert">
          Handleturen kunne ikke lagres på denne enheten. Planen ble ikke endret.
        </p>
      )}
    </section>
  );
}
