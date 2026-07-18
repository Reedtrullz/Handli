"use client";

import {
  currentLocationRequestSchema,
  currentLocationResponseSchema,
  locationSearchRequestSchema,
  locationSearchResponseSchema,
  travelPlanApiRequestSchema,
  travelPlanApiResponseSchemaFor,
  type ExactProductPlanApiRequest,
  type ReviewedFamilyPlanApiRequestV2,
  type TravelCalculationState,
  type TravelPlanApiRequest,
  type TravelPlanApiResponse,
  type TravelMode,
} from "@handleplan/domain";
import { useCallback, useEffect, useRef, useState } from "react";

const MAX_LOCATION_RESPONSE_BYTES = 8 * 1024;
const MAX_TRAVEL_RESPONSE_BYTES = 160 * 1024;

type PlanningRequest = ExactProductPlanApiRequest | ReviewedFamilyPlanApiRequestV2;
type CalculatedTravel = Extract<TravelCalculationState, { kind: "calculated" }>;
type UnavailableTravel = Extract<TravelCalculationState, { kind: "unavailable" }>;
type NotRequestedTravel = Extract<TravelCalculationState, { kind: "not-requested" }>;

export type TravelResultUpdate =
  | {
      planning: TravelPlanApiResponse["planning"];
      travel: CalculatedTravel;
      travelBinding: TravelResultBinding;
    }
  | { planning: TravelPlanApiResponse["planning"]; travel: UnavailableTravel }
  | { travel: UnavailableTravel }
  | { travel: NotRequestedTravel };

export interface TravelResultBinding {
  request: TravelPlanApiRequest;
  response: TravelPlanApiResponse;
}

interface TravelResultControlsProps {
  planningRequest: PlanningRequest;
  onTravelResult: (update: TravelResultUpdate) => void;
}

type BusyState = "idle" | "locating" | "searching" | "calculating";
type OriginState =
  | { kind: "idle" }
  | { kind: "ready"; copy: string }
  | { kind: "error"; copy: string };

interface LocationSelection {
  expiresAt: string;
  token: string;
}

interface AddressCandidate {
  label: string;
  matchQuality: "exact" | "approximate";
  selection: LocationSelection;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Response cleanup is best effort and must not replace the sanitized UI.
  }
}

function isJsonContentType(value: string): boolean {
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const quotedString = '"(?:[^"\\\\\\r\\n]|\\\\[\\t\\x20-\\x7e])*"';
  const parameter = `(?:${token})\\s*=\\s*(?:${token}|${quotedString})`;
  return new RegExp(`^application/json(?:\\s*;\\s*${parameter})*\\s*$`, "i").test(value);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown | undefined> {
  if (!response.ok || !isJsonContentType(response.headers.get("content-type") ?? "")) {
    await cancelBody(response.body);
    return undefined;
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && /^\d+$/u.test(declaredLength)
    && Number(declaredLength) > maxBytes
  ) {
    await cancelBody(response.body);
    return undefined;
  }
  if (response.body === null) return undefined;

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    await cancelBody(response.body);
    return undefined;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return JSON.parse(fragments.join("")) as unknown;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Response cleanup is best effort.
    }
    return undefined;
  }
}

function unavailableCopy(reason: UnavailableTravel["reason"]): string {
  switch (reason) {
    case "branch-data-unavailable":
      return "Butikkadressene er ikke klare for ruteberegning. Prisplanen vises fortsatt.";
    case "invalid-location":
      return "Startpunktet kunne ikke brukes. Prisplanen vises fortsatt.";
    case "no-route":
      return "Vi fant ingen komplett rute for denne planen. Prisplanen vises fortsatt.";
    case "timeout":
      return "Ruten tok for lang tid å beregne. Prisplanen vises fortsatt.";
    case "provider-unavailable":
      return "Rutetjenesten er utilgjengelig. Prisplanen vises fortsatt.";
  }
}

export function TravelResultControls({
  planningRequest,
  onTravelResult,
}: TravelResultControlsProps) {
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<TravelMode>("car");
  const [address, setAddress] = useState("");
  const [addressCandidates, setAddressCandidates] = useState<readonly AddressCandidate[]>([]);
  const [activeAddressCandidateIndex, setActiveAddressCandidateIndex] = useState(0);
  const [selection, setSelection] = useState<LocationSelection | undefined>();
  const [busy, setBusy] = useState<BusyState>("idle");
  const [originState, setOriginState] = useState<OriginState>({ kind: "idle" });
  const [calculationCopy, setCalculationCopy] = useState<string | undefined>();
  const [calculated, setCalculated] = useState(false);
  const operationVersion = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const onTravelResultRef = useRef(onTravelResult);

  useEffect(() => {
    onTravelResultRef.current = onTravelResult;
  }, [onTravelResult]);

  const resetTravel = useCallback((): void => {
    operationVersion.current += 1;
    controller.current?.abort();
    controller.current = undefined;
    setEnabled(false);
    setMode("car");
    setAddress("");
    setAddressCandidates([]);
    setActiveAddressCandidateIndex(0);
    setSelection(undefined);
    setBusy("idle");
    setOriginState({ kind: "idle" });
    setCalculationCopy(undefined);
    setCalculated(false);
    onTravelResultRef.current({ travel: { contractVersion: 1, kind: "not-requested" } });
  }, []);

  useEffect(() => {
    const handlePageHide = (): void => resetTravel();
    const handlePageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) resetTravel();
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      operationVersion.current += 1;
      controller.current?.abort();
      controller.current = undefined;
    };
  }, [resetTravel]);

  function beginOperation(nextBusy: BusyState): { signal: AbortSignal; version: number } {
    operationVersion.current += 1;
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(nextBusy);
    return { signal: controller.current.signal, version: operationVersion.current };
  }

  function isCurrent(version: number): boolean {
    return version === operationVersion.current;
  }

  function clearPresentedTravel(): void {
    setCalculated(false);
    onTravelResult({ travel: { contractVersion: 1, kind: "not-requested" } });
  }

  async function calculateTravel(nextSelection: LocationSelection, nextMode: TravelMode): Promise<void> {
    clearPresentedTravel();
    if (Date.parse(nextSelection.expiresAt) <= Date.now()) {
      setSelection(undefined);
      setBusy("idle");
      setCalculationCopy(undefined);
      setOriginState({
        kind: "error",
        copy: "Startpunktet utløp. Bekreft posisjon eller adresse på nytt.",
      });
      return;
    }

    const outbound = travelPlanApiRequestSchema.safeParse({
      contractVersion: 1,
      locationSelectionToken: nextSelection.token,
      planning: planningRequest,
      travelMode: nextMode,
    });
    if (!outbound.success) {
      setBusy("idle");
      setCalculated(false);
      setCalculationCopy("Ruten kunne ikke beregnes. Prisplanen vises fortsatt.");
      onTravelResult({
        travel: { contractVersion: 1, kind: "unavailable", reason: "provider-unavailable" },
      });
      return;
    }

    const { signal, version } = beginOperation("calculating");
    setCalculationCopy(undefined);
    setCalculated(false);
    try {
      const response = await fetch("/api/plans/travel", {
        body: JSON.stringify(outbound.data),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
      const value = await readBoundedJson(response, MAX_TRAVEL_RESPONSE_BYTES);
      if (!isCurrent(version)) return;
      const parsed = travelPlanApiResponseSchemaFor(outbound.data).safeParse(value);
      if (!parsed.success) {
        setBusy("idle");
        setCalculated(false);
        setCalculationCopy("Rutetjenesten er utilgjengelig. Prisplanen vises fortsatt.");
        onTravelResult({
          travel: { contractVersion: 1, kind: "unavailable", reason: "provider-unavailable" },
        });
        return;
      }
      setBusy("idle");
      if (parsed.data.travel.kind === "unavailable") {
        setCalculationCopy(unavailableCopy(parsed.data.travel.reason));
        setCalculated(false);
        onTravelResult({ planning: parsed.data.planning, travel: parsed.data.travel });
        return;
      }
      if (parsed.data.travel.kind !== "calculated") {
        setCalculationCopy("Rutetjenesten er utilgjengelig. Prisplanen vises fortsatt.");
        setCalculated(false);
        onTravelResult({
          travel: { contractVersion: 1, kind: "unavailable", reason: "provider-unavailable" },
        });
        return;
      }
      setCalculationCopy("Reisetid er beregnet for de komplette planene under.");
      setCalculated(true);
      onTravelResult({
        planning: parsed.data.planning,
        travel: parsed.data.travel,
        travelBinding: { request: outbound.data, response: parsed.data },
      });
    } catch (error) {
      if (!isCurrent(version)) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setBusy("idle");
      setCalculated(false);
      setCalculationCopy("Rutetjenesten er utilgjengelig. Prisplanen vises fortsatt.");
      onTravelResult({
        travel: { contractVersion: 1, kind: "unavailable", reason: "provider-unavailable" },
      });
    }
  }

  async function requestCurrentPosition(): Promise<void> {
    clearPresentedTravel();
    setAddressCandidates([]);
    setActiveAddressCandidateIndex(0);
    setSelection(undefined);
    setOriginState({ kind: "idle" });
    setCalculationCopy(undefined);
    setCalculated(false);
    if (typeof navigator === "undefined" || navigator.geolocation === undefined) {
      setOriginState({
        kind: "error",
        copy: "Nettleseren deler ikke posisjon. Du kan bruke adressefeltet i stedet.",
      });
      return;
    }

    operationVersion.current += 1;
    controller.current?.abort();
    controller.current = undefined;
    const version = operationVersion.current;
    setBusy("locating");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!isCurrent(version)) return;
        const outbound = currentLocationRequestSchema.safeParse({
          contractVersion: 1,
          coordinate: {
            latitudeE6: Math.round(position.coords.latitude * 1_000_000),
            longitudeE6: Math.round(position.coords.longitude * 1_000_000),
          },
        });
        if (!outbound.success) {
          setBusy("idle");
          setOriginState({ kind: "error", copy: "Posisjonen kunne ikke brukes." });
          return;
        }

        controller.current = new AbortController();
        const signal = controller.current.signal;
        void fetch("/api/locations/current", {
          body: JSON.stringify(outbound.data),
          cache: "no-store",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          method: "POST",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal,
        }).then(async (response) => {
          const value = await readBoundedJson(response, MAX_LOCATION_RESPONSE_BYTES);
          if (!isCurrent(version)) return;
          const parsed = currentLocationResponseSchema.safeParse(value);
          if (!parsed.success) {
            setBusy("idle");
            setOriginState({
              kind: "error",
              copy: "Posisjonen kunne ikke bekreftes. Du kan bruke adressefeltet i stedet.",
            });
            return;
          }
          const nextSelection = {
            expiresAt: parsed.data.expiresAt,
            token: parsed.data.selectionToken,
          };
          setSelection(nextSelection);
          setOriginState({ kind: "ready", copy: "Nåværende posisjon er bekreftet." });
          await calculateTravel(nextSelection, mode);
        }).catch((error: unknown) => {
          if (!isCurrent(version)) return;
          if (error instanceof DOMException && error.name === "AbortError") return;
          setBusy("idle");
          setOriginState({
            kind: "error",
            copy: "Posisjonen kunne ikke bekreftes. Du kan bruke adressefeltet i stedet.",
          });
        });
      },
      () => {
        if (!isCurrent(version)) return;
        setBusy("idle");
        setOriginState({
          kind: "error",
          copy: "Posisjonen ble ikke delt. Du kan bruke adressefeltet i stedet.",
        });
      },
      { enableHighAccuracy: false, maximumAge: 0, timeout: 10_000 },
    );
  }

  async function searchAddress(): Promise<void> {
    clearPresentedTravel();
    setAddressCandidates([]);
    setActiveAddressCandidateIndex(0);
    setSelection(undefined);
    const outbound = locationSearchRequestSchema.safeParse({
      contractVersion: 1,
      query: address,
    });
    if (!outbound.success) {
      setOriginState({ kind: "error", copy: "Skriv inn en full adresse og et poststed." });
      return;
    }

    const { signal, version } = beginOperation("searching");
    setOriginState({ kind: "idle" });
    setCalculationCopy(undefined);
    setCalculated(false);
    try {
      const response = await fetch("/api/locations/search", {
        body: JSON.stringify(outbound.data),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
      const value = await readBoundedJson(response, MAX_LOCATION_RESPONSE_BYTES);
      if (!isCurrent(version)) return;
      const parsed = locationSearchResponseSchema.safeParse(value);
      const candidates = parsed.success ? parsed.data.candidates : [];
      if (!parsed.success || candidates.length === 0) {
        setBusy("idle");
        setSelection(undefined);
        setOriginState({
          kind: "error",
          copy: "Vi fant ingen adresseforslag. Skriv inn full adresse og poststed.",
        });
        return;
      }
      setBusy("idle");
      setAddressCandidates(candidates.map((candidate) => ({
        label: candidate.label,
        matchQuality: candidate.matchQuality,
        selection: {
          expiresAt: parsed.data.expiresAt,
          token: candidate.selectionToken,
        },
      })));
      setActiveAddressCandidateIndex(0);
      setOriginState({
        kind: "ready",
        copy: candidates.length === 1
          ? "Ett adresseforslag ble funnet. Velg forslaget før ruten beregnes."
          : `${candidates.length} adresseforslag ble funnet. Velg riktig adresse før ruten beregnes.`,
      });
    } catch (error) {
      if (!isCurrent(version)) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setBusy("idle");
      setOriginState({
        kind: "error",
        copy: "Adressen kunne ikke bekreftes nå. Prisplanen vises fortsatt.",
      });
    }
  }

  function confirmAddress(next: AddressCandidate): void {
    setAddress(next.label);
    setAddressCandidates([]);
    setActiveAddressCandidateIndex(0);
    setSelection(next.selection);
    setOriginState({ kind: "ready", copy: "Adressen er bekreftet for denne beregningen." });
    void calculateTravel(next.selection, mode);
  }

  function changeMode(nextMode: TravelMode): void {
    setMode(nextMode);
    if (selection !== undefined) void calculateTravel(selection, nextMode);
  }

  const interactionBusy = busy !== "idle";

  return (
    <section className="result-travel" aria-labelledby="result-travel-title">
      <div className="travel-toggle-row">
        <div>
          <h2 id="result-travel-title">Reisetid</h2>
          <p>Valgfritt og kun for denne siden</p>
        </div>
        <label htmlFor="result-travel-enabled">Beregn</label>
        <input
          id="result-travel-enabled"
          type="checkbox"
          role="switch"
          checked={enabled}
          onChange={(event) => {
            if (event.currentTarget.checked) {
              setEnabled(true);
            } else {
              resetTravel();
            }
          }}
        />
      </div>

      {enabled ? (
        <div className="travel-details">
          <fieldset className="travel-mode-options">
            <legend>Transportmiddel</legend>
            <label>
              <input
                type="radio"
                name="travel-mode"
                value="car"
                checked={mode === "car"}
                disabled={interactionBusy}
                onChange={() => changeMode("car")}
              />
              Bil
            </label>
            <label>
              <input
                type="radio"
                name="travel-mode"
                value="bike"
                checked={mode === "bike"}
                disabled={interactionBusy}
                onChange={() => changeMode("bike")}
              />
              Sykkel
            </label>
          </fieldset>

          <button
            className="secondary-button travel-current-button"
            type="button"
            disabled={interactionBusy}
            onClick={() => void requestCurrentPosition()}
          >
            {busy === "locating" ? "Henter posisjon …" : "Bruk min posisjon"}
          </button>

          <form
            className="travel-address-form"
            onSubmit={(event) => {
              event.preventDefault();
              void searchAddress();
            }}
          >
            <label htmlFor="result-travel-address">Eller skriv inn adresse og poststed</label>
            <div>
              <input
                id="result-travel-address"
                type="text"
                role="combobox"
                aria-activedescendant={addressCandidates.length === 0
                  ? undefined
                  : `result-travel-address-option-${activeAddressCandidateIndex}`}
                aria-autocomplete="list"
                aria-controls={addressCandidates.length === 0
                  ? undefined
                  : "result-travel-address-options"}
                aria-expanded={addressCandidates.length > 0}
                autoComplete="off"
                inputMode="text"
                maxLength={160}
                value={address}
                disabled={interactionBusy}
                onChange={(event) => {
                  const hadCandidates = addressCandidates.length > 0;
                  setAddress(event.currentTarget.value);
                  setAddressCandidates([]);
                  setActiveAddressCandidateIndex(0);
                  if (hadCandidates || selection !== undefined) {
                    setOriginState({ kind: "idle" });
                  }
                  if (selection !== undefined) {
                    setSelection(undefined);
                    setCalculationCopy(undefined);
                    clearPresentedTravel();
                  }
                }}
                onKeyDown={(event) => {
                  if (addressCandidates.length === 0) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const candidate = addressCandidates[activeAddressCandidateIndex];
                    if (candidate !== undefined) confirmAddress(candidate);
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveAddressCandidateIndex((index) =>
                      (index + 1) % addressCandidates.length);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveAddressCandidateIndex((index) =>
                      (index - 1 + addressCandidates.length) % addressCandidates.length);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setAddressCandidates([]);
                    setActiveAddressCandidateIndex(0);
                    setOriginState({ kind: "idle" });
                  }
                }}
              />
              <button className="secondary-button" type="submit" disabled={interactionBusy}>
                {busy === "searching" ? "Søker …" : "Finn adresse"}
              </button>
            </div>
            {addressCandidates.length === 0 ? null : (
              <div
                aria-label="Adresseforslag"
                className="travel-address-options"
                id="result-travel-address-options"
                role="listbox"
              >
                {addressCandidates.map((candidate, index) => (
                  <button
                    aria-selected={index === activeAddressCandidateIndex}
                    id={`result-travel-address-option-${index}`}
                    key={candidate.selection.token}
                    onClick={() => confirmAddress(candidate)}
                    onMouseEnter={() => setActiveAddressCandidateIndex(index)}
                    role="option"
                    tabIndex={-1}
                    type="button"
                  >
                    <strong>{candidate.label}</strong>
                    <small>{candidate.matchQuality === "exact" ? "Eksakt treff" : "Mulig treff"} fra Kartverket</small>
                  </button>
                ))}
              </div>
            )}
          </form>

          <div className="travel-feedback" aria-live="polite" aria-atomic="true">
            {originState.kind !== "idle" ? (
              <p className={originState.kind === "error" ? "travel-error" : "travel-confirmation"}>
                {originState.copy}
              </p>
            ) : null}
            {busy === "calculating" ? <p>Beregner rute …</p> : null}
            {calculationCopy !== undefined ? <p className="travel-calculation-copy">{calculationCopy}</p> : null}
          </div>
          {calculated ? (
            <p className="travel-attribution">
              Rutedata: <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap-bidragsytere</a>
            </p>
          ) : null}
          <p className="travel-privacy-copy">
            Startpunktet og den midlertidige nøkkelen lagres ikke i nettleseren og brukes bare til denne beregningen.
          </p>
        </div>
      ) : null}
    </section>
  );
}
