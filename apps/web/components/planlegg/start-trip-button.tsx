"use client";

import {
  type ExactProductPlanApiRequest,
  type ExactProductPlanApiResponse,
  type PlanResultV2,
  type ReviewedFamilyPlanApiRequestV2,
  type ReviewedFamilyPlanApiResponseV2,
} from "@handleplan/domain";
import { useMemo, useState } from "react";

import {
  createLocalTripId,
  createStrictResultTripSnapshot,
  StrictResultTripError,
  type StrictTravelPlanBinding,
} from "../../lib/strict-result-trip";
import { ensureHandleModeOfflineReady } from "../../lib/handle-mode-offline-readiness";
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
  | "offline-error"
  | "storage-error";

interface StartTripButtonCommonProps {
  plan: PlanResultV2;
  repository?: TripSnapshotRepository;
  travelBinding?: StrictTravelPlanBinding;
  ensureOfflineReady?: () => Promise<void>;
  now?: () => Date;
  createId?: () => string;
}

export type StartTripButtonProps = StartTripButtonCommonProps & (
  | {
      kind?: "exact-product";
      exactRequest: ExactProductPlanApiRequest;
      exactResponse: ExactProductPlanApiResponse;
      reviewedRequest?: never;
      reviewedResponse?: never;
    }
  | {
      kind: "reviewed-family";
      reviewedRequest: ReviewedFamilyPlanApiRequestV2;
      reviewedResponse: ReviewedFamilyPlanApiResponseV2;
      exactRequest?: never;
      exactResponse?: never;
    }
);

export function StartTripButton(props: StartTripButtonProps) {
  const {
    createId = createLocalTripId,
    ensureOfflineReady = ensureHandleModeOfflineReady,
    now = () => new Date(),
    plan,
    repository,
    travelBinding,
  } = props;
  const tripRepository = useMemo(
    () => repository ?? createBrowserTripSnapshotRepository(),
    [repository],
  );
  const [state, setState] = useState<StartState>("idle");

  async function start(): Promise<void> {
    setState("busy");
    let snapshot: ReturnType<typeof createStrictResultTripSnapshot>;
    try {
      const common = {
        now: now(),
        plan,
        travelBinding,
        tripId: createId(),
      };
      snapshot = props.kind === "reviewed-family"
        ? createStrictResultTripSnapshot({
            ...common,
            kind: "reviewed-family",
            reviewedRequest: props.reviewedRequest,
            reviewedResponse: props.reviewedResponse,
          })
        : createStrictResultTripSnapshot({
            ...common,
            exactRequest: props.exactRequest,
            exactResponse: props.exactResponse,
          });
    } catch (error) {
      if (error instanceof StrictResultTripError) {
        setState(error.code === "EXPIRED_EVIDENCE" ? "expired" : "invalid");
      } else {
        setState("invalid");
      }
      return;
    }

    try {
      await ensureOfflineReady();
    } catch {
      setState("offline-error");
      return;
    }

    try {
      await tripRepository.start(snapshot);
      setState("success");
    } catch (error) {
      if (
        error instanceof TripSnapshotRepositoryError
        && error.code === "ACTIVE_TRIP_EXISTS"
      ) {
        setState("existing");
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

      {state === "offline-error" && (
        <div className={styles.error} role="alert">
          <strong>Handlemodus er ikke klart for bruk uten nett.</strong>
          <span>Vent litt og prøv igjen, eller last siden på nytt mens du er tilkoblet.</span>
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
