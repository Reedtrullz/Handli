"use client";

import {
  reviewDecisionResponseV1Schema,
  reviewDecisionRequestV1Schema,
  reviewEvidenceAckRequestV1Schema,
  reviewEvidenceAckResponseV1Schema,
  reviewEvidenceChallengeTokenSchema,
  reviewEvidenceProofTokenSchema,
  reviewQueueResponseV1Schema,
  type ReviewDecisionRequestV1,
  type ReviewOfferDecisionV1,
  type ReviewQueueCandidateV1,
} from "@handleplan/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import styles from "./review-workspace.module.css";

interface QueueFilters {
  anomaly: string;
  chain: string;
  maxAgeHours: string;
  maxConfidence: string;
  minAgeHours: string;
  minConfidence: string;
  scopeKind: string;
}

const EMPTY_FILTERS: QueueFilters = {
  anomaly: "",
  chain: "",
  maxAgeHours: "",
  maxConfidence: "",
  minAgeHours: "",
  minConfidence: "",
  scopeKind: "",
};

function queueUrl(filters: QueueFilters, cursor?: string): string {
  const params = new URLSearchParams({ limit: "25" });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "") params.set(key, value);
  }
  if (cursor !== undefined) params.set("cursor", cursor);
  return `/api/review/candidates?${params}`;
}

interface Feedback {
  kind: "error" | "status";
  text: string;
}

function money(ore: number | undefined): string {
  if (ore === undefined) return "Ikke oppgitt";
  return new Intl.NumberFormat("nb-NO", {
    currency: "NOK",
    style: "currency",
  }).format(ore / 100);
}

function chainLabel(chain: ReviewQueueCandidateV1["chain"]): string {
  if (chain === "rema-1000") return "REMA 1000";
  return chain === "bunnpris" ? "Bunnpris" : "Extra";
}

function productLabel(candidate: ReviewQueueCandidateV1): string {
  const product = candidate.candidate.product;
  return product.kind === "exact-identifier"
    ? `GTIN ${product.value}`
    : product.brand === undefined ? product.label : `${product.brand} ${product.label}`;
}

function pricingLabel(candidate: ReviewQueueCandidateV1): string {
  const pricing = candidate.candidate.pricing;
  return pricing.kind === "unit"
    ? money(pricing.offerPriceOre)
    : `${pricing.quantity} for ${money(pricing.totalOre)}`;
}

function originalDecision(candidate: ReviewQueueCandidateV1): ReviewOfferDecisionV1 | undefined {
  const extracted = candidate.candidate;
  if (extracted.product.kind !== "exact-identifier" || extracted.validity.state !== "parsed") {
    return undefined;
  }
  return {
    channels: [...extracted.channels],
    eligibility: extracted.eligibility,
    pricing: extracted.pricing.kind === "unit"
      ? {
        ...(extracted.pricing.beforePriceOre === undefined
          ? {}
          : { beforePriceOre: extracted.pricing.beforePriceOre }),
        kind: "unit",
        offerPriceOre: extracted.pricing.offerPriceOre,
      }
      : {
        ...(extracted.pricing.beforeUnitPriceOre === undefined
          ? {}
          : { beforeUnitPriceOre: extracted.pricing.beforeUnitPriceOre }),
        kind: "multibuy",
        quantity: extracted.pricing.quantity,
        totalOre: extracted.pricing.totalOre,
      },
    target: { gtin: extracted.product.value, kind: "exact-product" },
    validity: {
      endsAt: extracted.validity.endsAt,
      startsAt: extracted.validity.startsAt,
    },
  };
}

function errorMessage(code: unknown): string {
  switch (code) {
    case "VERSION_CONFLICT": return "Kandidaten ble vurdert i en annen økt. Køen er oppdatert.";
    case "ALREADY_REVIEWED": return "Kandidaten er allerede vurdert. Køen er oppdatert.";
    case "DECISION_MISMATCH": return "Bruk «Korriger og godkjenn» når feltene avviker fra uttrekket.";
    case "EVIDENCE_UNAVAILABLE": return "Godkjenning er sperret til kildebeviset kan vises og bindes sikkert til kandidaten.";
    case "TARGET_NOT_FOUND": return "Produktet finnes ikke som én entydig, verifisert GTIN i den godkjente katalogen.";
    case "REQUEST_TOO_LARGE": return "Vurderingen er større enn tillatt.";
    case "NOT_FOUND": return "Kandidaten finnes ikke lenger i køen.";
    default: return "Vurderingskøen er midlertidig utilgjengelig.";
  }
}

async function responseCode(response: Response): Promise<unknown> {
  try {
    const value = await response.json() as unknown;
    return value !== null && typeof value === "object" && "code" in value
      ? (value as { code: unknown }).code
      : undefined;
  } catch {
    return undefined;
  }
}

interface DecisionEditorProps {
  candidate: ReviewQueueCandidateV1;
  disabled: boolean;
  evidenceProof?: string;
  onSubmit: (request: ReviewDecisionRequestV1) => Promise<void>;
}

type CorrectionField = "eligibility" | "form" | "pricing" | "reason" | "target" | "validity";

interface CorrectionError {
  field: CorrectionField;
  message: string;
}

function correctionError(field: CorrectionField): string {
  switch (field) {
    case "reason": return "Skriv en kort begrunnelse før korrigeringen sendes.";
    case "target": return "Oppgi en gyldig GTIN.";
    case "pricing": return "Prisfeltene må være hele, ikke-negative ørebeløp med gyldig førpris.";
    case "validity": return "Gyldigheten må være to gyldige ISO-tidspunkt der start er før slutt.";
    case "eligibility": return "Medlemsprogrammet har ugyldig format.";
    default: return "Korrigeringen inneholder ugyldige felt.";
  }
}

function DecisionEditor({ candidate, disabled, evidenceProof, onSubmit }: DecisionEditorProps) {
  const extracted = candidate.candidate;
  const initial = originalDecision(candidate);
  const approvalBlocked = evidenceProof === undefined;
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState(initial?.target.gtin ?? "");
  const [offerOre, setOfferOre] = useState(String(
    extracted.pricing.kind === "unit"
      ? extracted.pricing.offerPriceOre
      : extracted.pricing.totalOre,
  ));
  const [beforeOre, setBeforeOre] = useState(String(
    extracted.pricing.kind === "unit"
      ? extracted.pricing.beforePriceOre ?? ""
      : extracted.pricing.beforeUnitPriceOre ?? "",
  ));
  const [startsAt, setStartsAt] = useState(
    extracted.validity.state === "parsed" ? extracted.validity.startsAt : candidate.publication.validFrom,
  );
  const [endsAt, setEndsAt] = useState(
    extracted.validity.state === "parsed" ? extracted.validity.endsAt : candidate.publication.validUntil,
  );
  const [memberProgram, setMemberProgram] = useState(
    extracted.eligibility.kind === "member" ? extracted.eligibility.programId : "",
  );
  const [correctionErrors, setCorrectionErrors] = useState<CorrectionError[]>([]);

  function correctedRequest(): {
    errors: CorrectionError[];
    request?: ReviewDecisionRequestV1;
  } {
    const parsedOffer = /^[0-9]+$/u.test(offerOre) ? Number(offerOre) : Number.NaN;
    const parsedBefore = beforeOre === ""
      ? undefined
      : /^[0-9]+$/u.test(beforeOre) ? Number(beforeOre) : Number.NaN;
    const decisionTarget = { gtin: target.trim(), kind: "exact-product" as const };
    const pricing = extracted.pricing.kind === "unit"
      ? {
        ...(parsedBefore === undefined ? {} : { beforePriceOre: parsedBefore }),
        kind: "unit" as const,
        offerPriceOre: parsedOffer,
      }
      : {
        ...(parsedBefore === undefined ? {} : { beforeUnitPriceOre: parsedBefore }),
        kind: "multibuy" as const,
        quantity: extracted.pricing.quantity,
        totalOre: parsedOffer,
      };
    const parsed = reviewDecisionRequestV1Schema.safeParse({
      action: "correct_and_approve",
      approvalEvidence: {
        presentation: "full_capture",
        token: evidenceProof,
      },
      candidateId: candidate.candidateId,
      contractVersion: 1,
      decision: {
        channels: [...extracted.channels],
        eligibility: memberProgram.trim() === ""
          ? { kind: "public" }
          : { kind: "member", programId: memberProgram.trim() },
        pricing,
        target: decisionTarget,
        validity: { endsAt, startsAt },
      },
      expectedVersion: candidate.version,
      reason: reason.trim(),
    });
    if (parsed.success) {
      if (parsed.data.action !== "correct_and_approve") {
        return { errors: [{ field: "form", message: correctionError("form") }] };
      }
      const startsAtMs = Date.parse(parsed.data.decision.validity.startsAt);
      const endsAtMs = Date.parse(parsed.data.decision.validity.endsAt);
      if (
        startsAtMs < Date.parse(candidate.publication.validFrom)
        || endsAtMs > Date.parse(candidate.publication.validUntil)
      ) {
        return {
          errors: [{
            field: "validity",
            message: "Gyldigheten må ligge innenfor publikasjonens gyldighetsperiode.",
          }],
        };
      }
      return { errors: [], request: parsed.data };
    }
    const fields = new Set<CorrectionField>();
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String);
      if (path.includes("reason")) fields.add("reason");
      else if (path.includes("target")) fields.add("target");
      else if (path.includes("pricing")) fields.add("pricing");
      else if (path.includes("validity")) fields.add("validity");
      else if (path.includes("eligibility")) fields.add("eligibility");
      else fields.add("form");
    }
    return {
      errors: [...fields].map((field) => ({ field, message: correctionError(field) })),
    };
  }

  const invalidFields = new Set(correctionErrors.map(({ field }) => field));

  return (
    <section className={styles.decision} aria-labelledby="review-decision-heading">
      <div className={styles.sectionHeading}>
        <div>
          <p>Append-only handling</p>
          <h2 id="review-decision-heading">Vurder kandidat</h2>
        </div>
        <span>Versjon {candidate.version}</span>
      </div>

      <label className={styles.fieldWide}>
        Begrunnelse
        <textarea
          aria-describedby={invalidFields.has("reason") ? "review-correction-errors" : undefined}
          aria-invalid={invalidFields.has("reason") || undefined}
          disabled={disabled}
          maxLength={1_000}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Kort, etterprøvbar begrunnelse"
          required
          rows={3}
          value={reason}
        />
      </label>

      {approvalBlocked && (
        <div
          aria-live="polite"
          className={styles.approvalUnavailable}
          id="review-approval-evidence-status"
          role="status"
        >
          <strong>Godkjenning er sperret</strong>
          <p>
            En aktuell full kildefil er ikke vist og bundet sikkert til kandidaten ennå.
            Vis hele den verifiserte kildefilen først. Du kan fortsatt avvise kandidaten
            med en etterprøvbar begrunnelse.
          </p>
        </div>
      )}

      <div className={styles.primaryActions}>
        <button
          aria-describedby={approvalBlocked ? "review-approval-evidence-status" : undefined}
          className="primary-button"
          disabled={disabled || approvalBlocked || reason.trim() === "" || initial === undefined}
          onClick={() => {
            if (initial === undefined || evidenceProof === undefined) return;
            void onSubmit({
              action: "approve",
              approvalEvidence: {
                presentation: "full_capture",
                token: evidenceProof,
              },
              candidateId: candidate.candidateId,
              contractVersion: 1,
              decision: initial,
              expectedVersion: candidate.version,
              reason: reason.trim(),
            });
          }}
          type="button"
        >
          Godkjenn som uttrekt
        </button>
        <button
          className={styles.rejectButton}
          disabled={disabled || reason.trim() === ""}
          onClick={() => void onSubmit({
            action: "reject",
            candidateId: candidate.candidateId,
            contractVersion: 1,
            expectedVersion: candidate.version,
            reason: reason.trim(),
          })}
          type="button"
        >
          Avvis
        </button>
      </div>

      <details className={styles.correction}>
        <summary
          aria-describedby={approvalBlocked ? "review-approval-evidence-status" : undefined}
        >
          Korriger felter før godkjenning{approvalBlocked ? " (sperret)" : ""}
        </summary>
        <div className={styles.editorGrid}>
          <label>
            GTIN
            <input
              aria-describedby={invalidFields.has("target") ? "review-correction-errors" : undefined}
              aria-invalid={invalidFields.has("target") || undefined}
              disabled={disabled || approvalBlocked}
              onChange={(event) => setTarget(event.target.value)}
              value={target}
            />
          </label>
          <label>
            {extracted.pricing.kind === "unit" ? "Tilbudspris i øre" : "Gruppepris i øre"}
            <input aria-describedby={invalidFields.has("pricing") ? "review-correction-errors" : undefined} aria-invalid={invalidFields.has("pricing") || undefined} disabled={disabled || approvalBlocked} inputMode="numeric" onChange={(event) => setOfferOre(event.target.value)} value={offerOre} />
          </label>
          <label>
            {extracted.pricing.kind === "unit" ? "Førpris i øre" : "Førpris per enhet i øre"}
            <input aria-describedby={invalidFields.has("pricing") ? "review-correction-errors" : undefined} aria-invalid={invalidFields.has("pricing") || undefined} disabled={disabled || approvalBlocked} inputMode="numeric" onChange={(event) => setBeforeOre(event.target.value)} value={beforeOre} />
          </label>
          <label>
            Gyldig fra (ISO 8601)
            <input aria-describedby={invalidFields.has("validity") ? "review-correction-errors" : undefined} aria-invalid={invalidFields.has("validity") || undefined} disabled={disabled || approvalBlocked} onChange={(event) => setStartsAt(event.target.value)} value={startsAt} />
          </label>
          <label>
            Gyldig til (ISO 8601)
            <input aria-describedby={invalidFields.has("validity") ? "review-correction-errors" : undefined} aria-invalid={invalidFields.has("validity") || undefined} disabled={disabled || approvalBlocked} onChange={(event) => setEndsAt(event.target.value)} value={endsAt} />
          </label>
          <label className={styles.fieldWide}>
            Medlemsprogram (tomt betyr offentlig tilbud)
            <input aria-describedby={invalidFields.has("eligibility") ? "review-correction-errors" : undefined} aria-invalid={invalidFields.has("eligibility") || undefined} disabled={disabled || approvalBlocked} onChange={(event) => setMemberProgram(event.target.value)} value={memberProgram} />
          </label>
        </div>
        {correctionErrors.length > 0 && (
          <div className={styles.validationErrors} id="review-correction-errors" role="alert">
            <strong>Korrigeringen kan ikke sendes:</strong>
            <ul>{correctionErrors.map(({ field, message }) => <li key={field}>{message}</li>)}</ul>
          </div>
        )}
        <button
          className="secondary-button"
          disabled={disabled || approvalBlocked}
          onClick={() => {
            const result = correctedRequest();
            setCorrectionErrors(result.errors);
            if (result.request !== undefined) void onSubmit(result.request);
          }}
          type="button"
        >
          Korriger og godkjenn
        </button>
      </details>
    </section>
  );
}

interface RenderedEvidenceState {
  acknowledging: boolean;
  candidateId: string;
  candidateVersion: number;
  challengeToken: string;
  cropReference: string;
  digestSha256: string;
  expiresAt: string;
  mimeType: string;
  objectUrl: string;
  proofToken: string | undefined;
  rendered: boolean;
}

interface EvidencePanelProps {
  candidate: ReviewQueueCandidateV1;
  disabled: boolean;
  onEvidenceChange: (evidence: RenderedEvidenceState | undefined) => void;
}

function EvidencePanel({ candidate, disabled, onEvidenceChange }: EvidencePanelProps) {
  const [evidence, setEvidence] = useState<RenderedEvidenceState>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const acknowledgementController = useRef<AbortController | null>(null);

  useEffect(() => () => {
    controller.current?.abort();
    acknowledgementController.current?.abort();
  }, []);
  const evidenceObjectUrl = evidence?.objectUrl;
  useEffect(() => () => {
    if (evidenceObjectUrl !== undefined) URL.revokeObjectURL(evidenceObjectUrl);
  }, [evidenceObjectUrl]);

  async function loadEvidence(): Promise<void> {
    controller.current?.abort();
    acknowledgementController.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    if (evidence !== undefined) URL.revokeObjectURL(evidence.objectUrl);
    setEvidence(undefined);
    onEvidenceChange(undefined);
    setFailure(undefined);
    setLoading(true);
    try {
      const response = await fetch(
        `/api/review/candidates/${encodeURIComponent(candidate.candidateId)}/evidence`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: candidate.capture.mimeType },
          signal: requestController.signal,
        },
      );
      if (!response.ok) {
        setFailure(errorMessage(await responseCode(response)));
        return;
      }
      const challengeToken = response.headers.get("x-handleplan-review-evidence-challenge");
      const expiresAt = response.headers.get("x-handleplan-review-evidence-expires");
      const presentation = response.headers.get("x-handleplan-review-evidence-presentation");
      const contentType = response.headers.get("content-type");
      const contentLength = response.headers.get("content-length");
      const blob = await response.blob();
      if (
        !reviewEvidenceChallengeTokenSchema.safeParse(challengeToken).success
        || response.headers.has("x-handleplan-review-evidence-proof")
        || expiresAt === null
        || !Number.isFinite(Date.parse(expiresAt))
        || Date.parse(expiresAt) <= Date.now()
        || presentation !== "full_capture"
        || contentType !== candidate.capture.mimeType
        || contentLength === null
        || !/^[1-9][0-9]*$/u.test(contentLength)
        || Number(contentLength) !== blob.size
        || blob.type !== contentType
      ) {
        setFailure("Kildebeviset returnerte et ugyldig eller utløpt svar.");
        return;
      }
      const digestBuffer = await globalThis.crypto.subtle.digest(
        "SHA-256",
        await blob.arrayBuffer(),
      );
      const digestSha256 = [...new Uint8Array(digestBuffer)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      const objectUrl = URL.createObjectURL(blob);
      setEvidence({
        acknowledging: false,
        candidateId: candidate.candidateId,
        candidateVersion: candidate.version,
        challengeToken: challengeToken!,
        cropReference: candidate.capture.cropReference,
        digestSha256,
        expiresAt,
        mimeType: contentType,
        objectUrl,
        proofToken: undefined,
        rendered: false,
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setFailure("Kildebeviset kunne ikke lastes sikkert.");
      }
    } finally {
      if (controller.current === requestController) {
        controller.current = null;
        setLoading(false);
      }
    }
  }

  async function acknowledgeRenderedImage(): Promise<void> {
    if (
      evidence === undefined
      || evidence.candidateId !== candidate.candidateId
      || evidence.mimeType === "application/pdf"
      || evidence.acknowledging
      || evidence.rendered
    ) return;
    const request = reviewEvidenceAckRequestV1Schema.safeParse({
      candidateId: candidate.candidateId,
      challenge: evidence.challengeToken,
      contractVersion: 1,
      digestSha256: evidence.digestSha256,
      presentation: "full_capture",
    });
    if (!request.success) {
      setFailure("Kildebeviset kunne ikke bindes sikkert til kandidaten.");
      return;
    }
    acknowledgementController.current?.abort();
    const requestController = new AbortController();
    acknowledgementController.current = requestController;
    setEvidence({ ...evidence, acknowledging: true });
    setFailure(undefined);
    try {
      const response = await fetch(
        `/api/review/candidates/${encodeURIComponent(candidate.candidateId)}/evidence/ack`,
        {
          body: JSON.stringify(request.data),
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
          signal: requestController.signal,
        },
      );
      if (!response.ok) {
        setFailure(errorMessage(await responseCode(response)));
        setEvidence((current) => current === undefined
          ? undefined
          : { ...current, acknowledging: false, proofToken: undefined, rendered: false });
        return;
      }
      const parsed = reviewEvidenceAckResponseV1Schema.safeParse(await response.json());
      if (
        !parsed.success
        || parsed.data.candidateId !== candidate.candidateId
        || parsed.data.presentation !== "full_capture"
        || Date.parse(parsed.data.expiresAt) <= Date.now()
        || !reviewEvidenceProofTokenSchema.safeParse(parsed.data.proofToken).success
      ) {
        setFailure("Kildebeviset returnerte en ugyldig eller utløpt bekreftelse.");
        setEvidence((current) => current === undefined
          ? undefined
          : { ...current, acknowledging: false, proofToken: undefined, rendered: false });
        return;
      }
      const next: RenderedEvidenceState = {
        ...evidence,
        acknowledging: false,
        expiresAt: parsed.data.expiresAt,
        proofToken: parsed.data.proofToken,
        rendered: true,
      };
      setEvidence(next);
      onEvidenceChange(next);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setFailure("Kildebeviset kunne ikke bekreftes sikkert etter visning.");
        setEvidence((current) => current === undefined
          ? undefined
          : { ...current, acknowledging: false, proofToken: undefined, rendered: false });
      }
    } finally {
      if (acknowledgementController.current === requestController) {
        acknowledgementController.current = null;
      }
    }
  }

  return (
    <section className={styles.source} aria-labelledby="source-crop-heading">
      <div className={styles.sectionHeading}>
        <div><p>Kildegrunnlag</p><h2 id="source-crop-heading">Privat kildebevis</h2></div>
        <span>{candidate.capture.rightsClassification === "public_display" ? "Offentlig visning tillatt" : "Kun privat vurdering"}</span>
      </div>
      <p className={styles.fullCaptureNotice}>
        Hele den verifiserte kildefilen vises. Det finnes ingen etterprøvbar
        utsnittsgeometri, så visningen er ikke et beskåret utsnitt.
      </p>
      {evidence === undefined ? (
        <div className={styles.cropPlaceholder}>
          <strong>Rettighetsstyrt full kildefil</strong>
          <small>{candidate.capture.mimeType} · hentet {new Date(candidate.capture.retrievedAt).toLocaleString("nb-NO")}</small>
          <button
            className="secondary-button"
            disabled={disabled || loading}
            onClick={() => void loadEvidence()}
            type="button"
          >
            {loading ? "Verifiserer kildebevis…" : "Vis verifisert full kildefil"}
          </button>
          {failure !== undefined && <p className={styles.evidenceFailure} role="alert">{failure}</p>}
          <p>Private kildebytes sendes bare fra den Access-beskyttede vurderingstjenesten.</p>
        </div>
      ) : (
        <div className={styles.evidenceFrame}>
          {evidence.mimeType === "application/pdf" ? (
            <iframe
              sandbox=""
              src={evidence.objectUrl}
              title="Verifisert full kildefil i PDF-format"
            />
          ) : (
            // This is a verified same-session blob URL, never a retailer URL.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt="Verifisert full kildefil for tilbudskandidaten"
              onError={() => {
                URL.revokeObjectURL(evidence.objectUrl);
                setEvidence(undefined);
                onEvidenceChange(undefined);
                setFailure("Nettleseren kunne ikke vise den verifiserte kildefilen.");
              }}
              onLoad={() => void acknowledgeRenderedImage()}
              src={evidence.objectUrl}
            />
          )}
          <p role="status">
            {evidence.mimeType === "application/pdf"
              ? "PDF-filen kan leses, men godkjenning er sperret til en avgrenset PDF-renderer kan bekrefte sidene. Avvisning er fortsatt tilgjengelig."
              : evidence.acknowledging
                ? "Bildet er dekodet. Binder full SHA-256 til kandidaten…"
                : evidence.rendered
                  ? `Hele bildefilen er levert og dekodet. Godkjenningsbeviset utløper ${new Date(evidence.expiresAt).toLocaleTimeString("nb-NO")}.`
                  : "Kildebytes er verifisert. Venter på at nettleseren dekoder hele bildet."}
          </p>
          <button className="secondary-button" disabled={disabled} onClick={() => void loadEvidence()} type="button">
            Verifiser på nytt
          </button>
        </div>
      )}
    </section>
  );
}

type QueueLoadMode = "append" | "replace";

export function ReviewWorkspace() {
  const [filters, setFilters] = useState<QueueFilters>(EMPTY_FILTERS);
  const [items, setItems] = useState<ReviewQueueCandidateV1[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const [renderedEvidence, setRenderedEvidence] = useState<RenderedEvidenceState>();
  const queueController = useRef<AbortController | null>(null);
  const queueGeneration = useRef(0);
  const queueHeading = useRef<HTMLHeadingElement>(null);

  const selected = useMemo(
    () => items.find(({ candidateId }) => candidateId === selectedId) ?? items[0],
    [items, selectedId],
  );

  const load = useCallback(async (
    mode: QueueLoadMode = "replace",
    cursor?: string,
  ): Promise<boolean> => {
    queueController.current?.abort();
    const controller = new AbortController();
    queueController.current = controller;
    const generation = ++queueGeneration.current;
    const current = () => generation === queueGeneration.current && !controller.signal.aborted;
    if (mode === "replace") {
      setItems([]);
      setNextCursor(undefined);
      setSelectedId(undefined);
      setRenderedEvidence(undefined);
    }
    setLoading(true);
    setFeedback(undefined);
    try {
      const response = await fetch(queueUrl(filters, cursor), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!current()) return false;
      if (!response.ok) {
        const text = errorMessage(await responseCode(response));
        if (current()) setFeedback({ kind: "error", text });
        return false;
      }
      const parsed = reviewQueueResponseV1Schema.safeParse(await response.json());
      if (!current()) return false;
      if (!parsed.success) {
        setFeedback({ kind: "error", text: "Vurderingskøen returnerte et ugyldig svar." });
        return false;
      }
      if (mode === "append") {
        setItems((existing) => {
          const known = new Set(existing.map(({ candidateId }) => candidateId));
          return [...existing, ...parsed.data.items.filter(({ candidateId }) => !known.has(candidateId))];
        });
      } else {
        setItems(parsed.data.items);
        setSelectedId((selectedCandidateId) => parsed.data.items.some(
          ({ candidateId }) => candidateId === selectedCandidateId,
        ) ? selectedCandidateId : parsed.data.items[0]?.candidateId);
      }
      setNextCursor(parsed.data.nextCursor);
      return true;
    } catch (error) {
      if (current() && !(error instanceof DOMException && error.name === "AbortError")) {
        setFeedback({ kind: "error", text: "Vurderingskøen er midlertidig utilgjengelig." });
      }
      return false;
    } finally {
      if (current()) {
        setLoading(false);
        queueController.current = null;
      }
    }
  }, [filters]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load("replace");
    }, 0);
    return () => {
      window.clearTimeout(timer);
      queueGeneration.current += 1;
      queueController.current?.abort();
      queueController.current = null;
    };
  }, [load]);

  function focusQueueHeading(): void {
    queueHeading.current?.focus();
  }

  async function submit(request: ReviewDecisionRequestV1) {
    queueGeneration.current += 1;
    queueController.current?.abort();
    queueController.current = null;
    setLoading(false);
    setActing(true);
    setFeedback(undefined);
    try {
      const response = await fetch(
        `/api/review/candidates/${encodeURIComponent(request.candidateId)}/actions`,
        {
          body: JSON.stringify(request),
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
        },
      );
      if (!response.ok) {
        const code = await responseCode(response);
        const nextMessage = errorMessage(code);
        if (code === "VERSION_CONFLICT" || code === "ALREADY_REVIEWED" || code === "NOT_FOUND") {
          await load("replace");
          focusQueueHeading();
        }
        setFeedback({ kind: "error", text: nextMessage });
        return;
      }
      const parsed = reviewDecisionResponseV1Schema.safeParse(await response.json());
      if (!parsed.success) {
        setFeedback({ kind: "error", text: "Vurderingshandlingen returnerte et ugyldig svar." });
        return;
      }
      const remaining = items.filter(({ candidateId }) => candidateId !== request.candidateId);
      setRenderedEvidence(undefined);
      setItems(remaining);
      setSelectedId(remaining[0]?.candidateId);
      setFeedback({
        kind: "status",
        text: parsed.data.state === "approved" ? "Kandidaten er godkjent." : "Kandidaten er avvist.",
      });
      focusQueueHeading();
    } catch {
      setFeedback({ kind: "error", text: "Vurderingshandlingen kunne ikke lagres." });
    } finally {
      setActing(false);
    }
  }

  return (
    <div className={styles.workspace}>
      <aside className={styles.queue} aria-labelledby="review-queue-heading">
        <div className={styles.queueHeading}>
          <div>
            <p>Privat arbeidsflate</p>
            <h1 id="review-queue-heading" ref={queueHeading} tabIndex={-1}>Tilbud til vurdering</h1>
          </div>
          <button className={styles.refresh} disabled={loading || acting} onClick={() => void load("replace")} type="button">
            Oppdater
          </button>
        </div>

        <details className={styles.filters}>
          <summary>Filtrer køen</summary>
          <fieldset className={styles.filterGrid} disabled={acting}>
            <label>Kjede<select onChange={(event) => setFilters((value) => ({ ...value, chain: event.target.value }))} value={filters.chain}><option value="">Alle</option><option value="bunnpris">Bunnpris</option><option value="rema-1000">REMA 1000</option><option value="extra">Extra</option></select></label>
            <label>Omfang<select onChange={(event) => setFilters((value) => ({ ...value, scopeKind: event.target.value }))} value={filters.scopeKind}><option value="">Alle</option><option value="national">Nasjonalt</option><option value="region">Region</option><option value="postal_set">Postnummer</option><option value="store_set">Butikker</option></select></label>
            <label>Min. alder (timer)<input inputMode="numeric" onChange={(event) => setFilters((value) => ({ ...value, minAgeHours: event.target.value }))} value={filters.minAgeHours} /></label>
            <label>Maks. alder (timer)<input inputMode="numeric" onChange={(event) => setFilters((value) => ({ ...value, maxAgeHours: event.target.value }))} value={filters.maxAgeHours} /></label>
            <label>Min. tillit<input inputMode="numeric" onChange={(event) => setFilters((value) => ({ ...value, minConfidence: event.target.value }))} value={filters.minConfidence} /></label>
            <label>Maks. tillit<input inputMode="numeric" onChange={(event) => setFilters((value) => ({ ...value, maxConfidence: event.target.value }))} value={filters.maxConfidence} /></label>
            <label className={styles.fieldWide}>Avvik<select onChange={(event) => setFilters((value) => ({ ...value, anomaly: event.target.value }))} value={filters.anomaly}><option value="">Alle</option><option value="OCR_REVIEW_REQUIRED">OCR må vurderes</option><option value="AMBIGUOUS_PRODUCT">Tvetydig produkt</option><option value="UNREADABLE_DATE">Uleselig dato</option><option value="SCOPE_MISMATCH">Omfang avviker</option><option value="PACKAGE_UNKNOWN">Ukjent pakning</option></select></label>
          </fieldset>
        </details>

        {feedback !== undefined && (
          <p className={styles.feedback} role={feedback.kind === "error" ? "alert" : "status"}>
            {feedback.text}
          </p>
        )}
        {loading && <p className={styles.queueState}>Henter vurderingskø…</p>}
        {!loading && items.length === 0 && <p className={styles.queueState}>Ingen kandidater i dette utvalget.</p>}
        <ul className={styles.queueList}>
          {items.map((item) => (
            <li key={item.candidateId}>
              <button
                aria-current={selected?.candidateId === item.candidateId ? "true" : undefined}
                onClick={() => {
                  setRenderedEvidence(undefined);
                  setSelectedId(item.candidateId);
                }}
                type="button"
              >
                <span>{chainLabel(item.chain)} · {item.scope.label}</span>
                <strong>{productLabel(item)}</strong>
                <small>{pricingLabel(item)} · {item.confidence}% tillit</small>
              </button>
            </li>
          ))}
        </ul>
        {nextCursor !== undefined && (
          <div className={styles.pagination}>
            <button
              className="secondary-button"
              disabled={loading || acting}
              onClick={() => void load("append", nextCursor)}
              type="button"
            >
              Last flere kandidater
            </button>
          </div>
        )}
      </aside>

      <main className={styles.detail}>
        {selected === undefined ? (
          <section className={styles.emptyDetail}>
            <h2>Velg en kandidat</h2>
            <p>Filtrer køen og åpne et tilbud for å sammenligne kildegrunnlag og typedata.</p>
          </section>
        ) : (
          <>
            <EvidencePanel
              candidate={selected}
              disabled={acting}
              key={`${selected.candidateId}:${selected.version}:${selected.capture.cropReference}`}
              onEvidenceChange={setRenderedEvidence}
            />

            <section className={styles.typed} aria-labelledby="typed-fields-heading">
              <div className={styles.sectionHeading}>
                <div><p>Uforanderlig kandidat</p><h2 id="typed-fields-heading">Uttrekte felter</h2></div>
                <span>{selected.extractionMethod.toUpperCase()} · {selected.confidence}%</span>
              </div>
              <dl className={styles.factGrid}>
                <div><dt>Produkt</dt><dd>{productLabel(selected)}</dd></div>
                <div><dt>Kjede</dt><dd>{chainLabel(selected.chain)}</dd></div>
                <div><dt>Tilbudspris</dt><dd>{pricingLabel(selected)}</dd></div>
                <div><dt>Førpris</dt><dd>{selected.candidate.pricing.kind === "unit" ? money(selected.candidate.pricing.beforePriceOre) : money(selected.candidate.pricing.beforeUnitPriceOre)}</dd></div>
                <div><dt>Publikasjon</dt><dd>{selected.publication.title}</dd></div>
                <div><dt>Omfang</dt><dd>{selected.scope.label}</dd></div>
                <div><dt>Gyldighet</dt><dd>{selected.candidate.validity.state === "parsed" ? `${selected.candidate.validity.startsAt} – ${selected.candidate.validity.endsAt}` : `Uleselig: ${selected.candidate.validity.reasonCode}`}</dd></div>
                <div><dt>Kanaler</dt><dd>{selected.candidate.channels.join(", ")}</dd></div>
                <div>
                  <dt>Uttrekksklassifisering</dt>
                  <dd>
                    {selected.extractionDisposition === "exact-match"
                      ? "Eksakt katalogtreff – krever fortsatt kildegodkjenning"
                      : "Avvik funnet – krever kildegodkjenning eller korrigering"}
                  </dd>
                </div>
              </dl>
              {selected.anomalyCodes.length > 0 && <div className={styles.anomalies}><strong>Avvik</strong><ul>{selected.anomalyCodes.map((code) => <li key={code}>{code}</li>)}</ul></div>}
            </section>

            <DecisionEditor
              candidate={selected}
              disabled={acting}
              evidenceProof={
                renderedEvidence?.rendered === true
                && renderedEvidence.candidateId === selected.candidateId
                && renderedEvidence.candidateVersion === selected.version
                && renderedEvidence.cropReference === selected.capture.cropReference
                && renderedEvidence.proofToken !== undefined
                  ? renderedEvidence.proofToken
                  : undefined
              }
              key={selected.candidateId}
              onSubmit={submit}
            />
          </>
        )}
      </main>
    </div>
  );
}
