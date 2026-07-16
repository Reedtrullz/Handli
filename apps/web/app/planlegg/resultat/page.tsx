"use client";

import {
  exactProductPlanApiResponseSchemaFor,
  type ExactProductPlanApiRequest,
  type ExactProductPlanApiResponse,
} from "@handleplan/domain";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import {
  planIdForPreference,
  PlanSelector,
} from "../../../components/planlegg/plan-selector";
import { PlanSummary } from "../../../components/planlegg/plan-summary";
import { PriceProvenance } from "../../../components/planlegg/price-provenance";
import { StartTripButton } from "../../../components/planlegg/start-trip-button";
import { StoreAssignment } from "../../../components/planlegg/store-assignment";
import {
  loadBasket,
  saveBasket,
  strictPlanRequestReadiness,
  type BrowserBasket,
} from "../../../lib/browser-basket";

const MAX_RESPONSE_BYTES = 128 * 1024;
type ResultState =
  | { status: "loading" }
  | { status: "ready"; response: ExactProductPlanApiResponse }
  | { status: "empty" }
  | { status: "unavailable" }
  | { status: "reapproval" }
  | { status: "invalid" };

const subscribeToClient = () => () => {};

async function cancelResponseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Cleanup is best effort and must not replace the sanitized UI state.
  }
}

async function readSafeResponse(
  response: Response,
  request: ExactProductPlanApiRequest,
): Promise<ExactProductPlanApiResponse | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const quotedString = '"(?:[^"\\\\\\r\\n]|\\\\[\\t\\x20-\\x7e])*"';
  const parameter = `(?:${token})\\s*=\\s*(?:${token}|${quotedString})`;
  if (!new RegExp(`^application/json(?:\\s*;\\s*${parameter})*\\s*$`, "i").test(contentType)) {
    await cancelResponseBody(response.body);
    return undefined;
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response.body);
    return undefined;
  }
  if (response.body === null) return undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    await cancelResponseBody(response.body);
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
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
  } catch {
    try { await reader.cancel(); } catch { /* Cleanup only. */ }
    return undefined;
  }
  const body = fragments.join("");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  const parsed = exactProductPlanApiResponseSchemaFor(request).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function ResultWorkspaceClient() {
  const [basket] = useState<BrowserBasket>(() => loadBasket());
  const [state, setState] = useState<ResultState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>();
  const requestVersion = useRef(0);
  const readiness = useMemo(() => strictPlanRequestReadiness(basket), [basket]);
  const request = readiness.state === "ready" ? readiness.request : undefined;
  const requiredItems = request?.needs.length ?? 0;
  const requestBody = useMemo(() => {
    if (request === undefined) return undefined;
    const serialized = JSON.stringify(request);
    return new TextEncoder().encode(serialized).byteLength <= 64 * 1024
      ? serialized
      : undefined;
  }, [request]);

  useEffect(() => {
    if (request === undefined || requestBody === undefined) {
      return;
    }
    const version = ++requestVersion.current;
    const controller = new AbortController();
    void fetch("/api/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
      signal: controller.signal,
    }).then(async (response) => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      if (response.status === 503) {
        setState({ status: "unavailable" });
        return;
      }
      if (response.status === 422) {
        setState({ status: "reapproval" });
        return;
      }
      if (!response.ok) {
        setState({ status: "invalid" });
        return;
      }
      const safe = await readSafeResponse(response, request);
      if (controller.signal.aborted || version !== requestVersion.current) return;
      if (!safe) {
        setState({ status: "invalid" });
        return;
      }
      if (safe.plans.length === 0) {
        setState({ status: "empty" });
        return;
      }
      const nextSelection = planIdForPreference(
        safe.plans,
        basket.convenienceWeightBasisPoints,
      );
      if (!nextSelection) {
        setState({ status: "invalid" });
        return;
      }
      setSelectedPlanId(nextSelection);
      setState({ status: "ready", response: safe });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState({ status: "unavailable" });
    });

    return () => controller.abort();
  // The basket is intentionally snapshotted once for this calculation page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, requestBody, retry]);

  if (readiness.state === "empty") {
    return <ResultMessage title="Handlekurven er tom" copy="Legg til varer før du beregner en handleplan." />;
  }
  if (readiness.state === "requires-exact-approval") {
    return (
      <ResultMessage
        title="Velg eksakte varer på nytt"
        copy="Fleksible eller begrensede varevalg kan ikke beregnes trygt ennå. Gå tilbake og godkjenn et eksakt produkt for hver vare. Ingen eldre prisberegning ble brukt."
      />
    );
  }
  if (requestBody === undefined) {
    return <ResultMessage title="Kunne ikke vise handleplanen" copy="Handlekurven er for stor eller ugyldig. Gå tilbake og kontroller varene." />;
  }
  if (state.status === "loading") {
    return <div className="result-loading" role="status">Beregner komplette handleplaner …</div>;
  }
  if (state.status === "empty") {
    return <ResultMessage title="Ingen komplett handleplan" copy="Prisgrunnlaget dekker ikke alle nødvendige varer. Ingen delvis plan blir anbefalt." />;
  }
  if (state.status === "unavailable") {
    return (
      <ResultMessage title="Prisdata er utilgjengelig" copy="Vi kan ikke lage en trygg, komplett anbefaling akkurat nå.">
        <button
          className="secondary-button"
          type="button"
          onClick={() => {
            setState({ status: "loading" });
            setRetry((value) => value + 1);
          }}
        >Prøv igjen</button>
      </ResultMessage>
    );
  }
  if (state.status === "reapproval") {
    return <ResultMessage title="Varen må godkjennes på nytt" copy="Minst én vare finnes ikke lenger som det eksakte produktet du valgte. Gå tilbake og velg varen på nytt. Ingen eldre prisberegning ble brukt." />;
  }
  if (state.status === "invalid") {
    return <ResultMessage title="Kunne ikke vise handleplanen" copy="Svaret kunne ikke bekreftes som en komplett og trygg plan." />;
  }

  const ordered = state.response.plans;
  const selected = ordered.find(({ id }) => id === selectedPlanId) ?? ordered[0]!;
  const convenience = ordered[0]!;

  function selectPlan(planId: string): void {
    setSelectedPlanId(planId);
  }

  return (
    <main className="result-main" data-layout="result-workspace">
      <div className="result-grid">
        <div className="result-assignments">
          <header className="result-heading">
            <p>Handleplan</p>
            <h1>Handleliste fordelt på butikker</h1>
            <span>Komplett kurv basert på {requiredItems} nødvendige varer.</span>
          </header>
          {selected.chains.map((selectedChain, index) => (
            <StoreAssignment
              key={selectedChain}
              chain={selectedChain}
              order={index + 1}
              assignments={selected.assignments.filter(({ chain: assignmentChain }) => assignmentChain === selectedChain)}
              products={state.response.products}
            />
          ))}
        </div>
        <aside className="result-rail">
          <PlanSummary
            plan={selected}
            convenienceTotalOre={convenience.totalOre}
            requiredItems={requiredItems}
          />
          <StartTripButton
            key={`${state.response.generatedAt}:${selected.id}`}
            caveats={state.response.caveats}
            evidence={state.response.evidence}
            generatedAt={state.response.generatedAt}
            plan={selected}
            products={state.response.products}
          />
          <PlanSelector
            plans={ordered}
            selectedPlanId={selected.id}
            onSelect={selectPlan}
            onPreferenceChange={(convenienceWeightBasisPoints) => {
              saveBasket({ ...basket, convenienceWeightBasisPoints });
            }}
          />
          <PriceProvenance
            generatedAt={state.response.generatedAt}
            caveats={state.response.caveats}
            assignments={selected.assignments}
            evidence={state.response.evidence}
            priceDataSource={state.response.priceDataSource}
          />
        </aside>
      </div>
    </main>
  );
}

function ResultMessage({ title, copy, children }: { title: string; copy: string; children?: ReactNode }) {
  return (
    <main className="result-main">
      <section className="result-message">
        <h1>{title}</h1>
        <p>{copy}</p>
        {children}
        <a className="primary-button" href="/planlegg">Tilbake til Planlegg</a>
      </section>
    </main>
  );
}

function ResultWorkspace() {
  const isClient = useSyncExternalStore(subscribeToClient, () => true, () => false);
  return isClient ? <ResultWorkspaceClient /> : null;
}

export default function ResultPage() {
  return (
    <div className="app-frame">
      <header className="site-header">
        <div className="header-inner">
          <a className="wordmark" href="/planlegg" aria-label="Handleplan, Planlegg">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            Handleplan
          </a>
          <nav aria-label="Hovedmeny">
            <a className="active" href="/planlegg" aria-current="page">Planlegg</a>
            <a href="/oppdag">Oppdag</a>
          </nav>
        </div>
      </header>
      <ResultWorkspace />
      <footer className="site-footer">
        <div>
          <p>© 2026 Handleplan • Uavhengig prissammenligning</p>
          <nav aria-label="Om Handleplan">
            <a href="/status">Datadekning</a>
            <a href="/om">Offentlig gode og rettelser</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
