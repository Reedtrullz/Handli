"use client";

import {
  matchProducts,
  type MatchRule,
  type Need,
  type PlanResult,
  type Product,
} from "@handleplan/domain";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { z } from "zod";

import { balancedPlanId, compareConvenience, projectPlanFrontier, PlanSelector } from "../../../components/planlegg/plan-selector";
import { PlanSummary } from "../../../components/planlegg/plan-summary";
import { PriceProvenance } from "../../../components/planlegg/price-provenance";
import { StoreAssignment } from "../../../components/planlegg/store-assignment";
import { loadBasket, saveBasket, SELECTED_PLAN_ID_MAX, type BrowserBasket } from "../../../lib/browser-basket";

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_PLANS = 24;
const publicText = z.string().trim().min(1).max(300);
const planId = z.string().trim().min(1).max(SELECTED_PLAN_ID_MAX);
const ean = z.string().regex(/^(?:\d{8}|\d{13})$/);
const chain = z.enum(["bunnpris", "rema-1000", "extra"]);
const moneyOre = z.number().int().nonnegative().safe().max(100_000_000);
const assignment = z.object({
  needId: publicText,
  ean,
  chain,
  quantity: z.number().int().positive().safe().max(10_000),
  costOre: moneyOre,
  observedAt: z.iso.datetime({ offset: false, precision: 3 }),
  source: z.literal("kassalapp"),
}).strict();
const plan = z.object({
  id: planId,
  assignments: z.array(assignment).min(1).max(50),
  totalOre: moneyOre,
  chains: z.array(chain).min(1).max(3),
  substitutions: z.array(publicText).max(50),
  coverage: z.literal(1),
  freshness: z.record(publicText, z.literal("eligible")),
}).strict();
const responseSchema = z.object({
  caveats: z.array(publicText).max(10),
  generatedAt: z.iso.datetime({ offset: false, precision: 3 }),
  priceDataSource: z.enum(["upstream", "cache"]),
  plans: z.array(plan).max(MAX_PLANS),
}).strict();

type ParsedResultResponse = z.infer<typeof responseSchema>;
interface ResultResponse extends Omit<ParsedResultResponse, "plans"> {
  plans: PlanResult[];
}
type ResultState =
  | { status: "loading" }
  | { status: "ready"; response: ResultResponse }
  | { status: "empty" }
  | { status: "unavailable" }
  | { status: "invalid" };

const subscribeToClient = () => () => {};

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
}

function assignmentIdentity(candidate: ParsedResultResponse["plans"][number]): string {
  return [...candidate.assignments]
    .sort((left, right) => left.needId.localeCompare(right.needId))
    .map((row) => `${row.needId}\0${row.ean}\0${row.chain}\0${row.quantity}\0${row.costOre}\0${row.observedAt}\0${row.source}`)
    .join("\u0001");
}

function dominates(
  left: ParsedResultResponse["plans"][number],
  right: ParsedResultResponse["plans"][number],
): boolean {
  const noWorse = left.totalOre <= right.totalOre && left.chains.length <= right.chains.length && left.substitutions.length <= right.substitutions.length;
  return noWorse && (left.totalOre < right.totalOre || left.chains.length < right.chains.length || left.substitutions.length < right.substitutions.length);
}

function isCompleteSafeResponse(response: ParsedResultResponse, basket: BrowserBasket): boolean {
  if (new Set(response.plans.map(({ id }) => id)).size !== response.plans.length) return false;
  if (new Set(response.plans.map(assignmentIdentity)).size !== response.plans.length) return false;
  if (response.plans.some((candidate, index) => response.plans.some((other, otherIndex) => index !== otherIndex && dominates(other, candidate)))) return false;
  const requiredNeeds = basket.needs.filter(({ required }) => required);
  const requiredIds = requiredNeeds.map(({ id }) => id);
  const productsByEan = new Map(basket.products.map((product) => [product.ean, product]));
  const rulesById = new Map(basket.matchingRules.map((rule) => [rule.id, rule]));
  const needsById = new Map(requiredNeeds.map((need) => [need.id, need]));
  const generatedAt = new Date(response.generatedAt).getTime();
  if (!Number.isFinite(generatedAt)) return false;

  return response.plans.every((candidate) => {
    if (!sameMembers(candidate.assignments.map(({ needId }) => needId), requiredIds)) return false;
    if (!sameMembers(candidate.chains, candidate.assignments.map(({ chain: assignmentChain }) => assignmentChain).filter((value, index, all) => all.indexOf(value) === index))) return false;
    if (!sameMembers(Object.keys(candidate.freshness), requiredIds)) return false;
    if (candidate.assignments.reduce((sum, row) => sum + row.costOre, 0) !== candidate.totalOre) return false;
    const expectedSubstitutions = candidate.assignments.flatMap((row) => {
      const need = needsById.get(row.needId);
      const rule = need ? rulesById.get(need.matchRuleId) : undefined;
      return rule?.mode === "exact" ? [] : [row.needId];
    });
    if (!sameMembers(candidate.substitutions, expectedSubstitutions)) return false;

    return candidate.assignments.every((row) => {
      const need = needsById.get(row.needId);
      const product = productsByEan.get(row.ean);
      const rule = need ? rulesById.get(need.matchRuleId) : undefined;
      const observedAt = new Date(row.observedAt).getTime();
      if (!need || !product || !rule || row.quantity !== need.quantity || row.source !== "kassalapp") return false;
      if (!Number.isFinite(observedAt) || observedAt > generatedAt || generatedAt - observedAt > 72 * 60 * 60 * 1000) return false;
      return matchProducts(need as Need, rule as MatchRule, [product as Product]).length === 1;
    });
  });
}

async function cancelResponseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Cleanup is best effort and must not replace the sanitized UI state.
  }
}

async function readSafeResponse(response: Response, basket: BrowserBasket): Promise<ResultResponse | undefined> {
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
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success || !isCompleteSafeResponse(parsed.data, basket)) return undefined;
  return parsed.data as unknown as ResultResponse;
}

function requestForBasket(basket: BrowserBasket): string | undefined {
  const request = JSON.stringify({
    needs: basket.needs,
    matchingRules: basket.matchingRules,
    products: basket.products,
    maxStores: 3,
  });
  return new TextEncoder().encode(request).byteLength <= 64 * 1024 ? request : undefined;
}

function ResultWorkspaceClient() {
  const [basket] = useState<BrowserBasket>(() => loadBasket());
  const [state, setState] = useState<ResultState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>(basket.selectedPlanId);
  const requestVersion = useRef(0);
  const requiredItems = basket.needs.filter(({ required }) => required).length;
  const requestBody = useMemo(() => requestForBasket(basket), [basket]);

  useEffect(() => {
    if (requiredItems === 0 || requestBody === undefined) {
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
      if (!response.ok) {
        setState({ status: "invalid" });
        return;
      }
      const safe = await readSafeResponse(response, basket);
      if (controller.signal.aborted || version !== requestVersion.current) return;
      if (!safe) {
        setState({ status: "invalid" });
        return;
      }
      if (safe.plans.length === 0) {
        setState({ status: "empty" });
        return;
      }
      const representatives = projectPlanFrontier(safe.plans);
      const returnedIds = new Set(representatives.map(({ id }) => id));
      const nextSelection = selectedPlanId && returnedIds.has(selectedPlanId)
        ? selectedPlanId
        : balancedPlanId(representatives);
      if (!nextSelection) {
        setState({ status: "invalid" });
        return;
      }
      setSelectedPlanId(nextSelection);
      saveBasket({ ...basket, selectedPlanId: nextSelection });
      setState({ status: "ready", response: safe });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState({ status: "unavailable" });
    });

    return () => controller.abort();
  // The basket is intentionally snapshotted once for this calculation page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestBody, requiredItems, retry]);

  if (requiredItems === 0) {
    return <ResultMessage title="Handlekurven er tom" copy="Legg til varer før du beregner en handleplan." />;
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
  if (state.status === "invalid") {
    return <ResultMessage title="Kunne ikke vise handleplanen" copy="Svaret kunne ikke bekreftes som en komplett og trygg plan." />;
  }

  const ordered = projectPlanFrontier(state.response.plans);
  const selected = ordered.find(({ id }) => id === selectedPlanId) ?? ordered[0]!;
  const convenience = [...ordered].sort(compareConvenience)[0]!;

  function selectPlan(planId: string): void {
    setSelectedPlanId(planId);
    saveBasket({ ...basket, selectedPlanId: planId });
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
              needs={basket.needs}
              products={basket.products}
            />
          ))}
        </div>
        <aside className="result-rail">
          <PlanSummary
            plan={selected as PlanResult}
            convenienceTotalOre={convenience.totalOre}
            requiredItems={requiredItems}
          />
          <PlanSelector plans={ordered as PlanResult[]} selectedPlanId={selected.id} onSelect={selectPlan} />
          <PriceProvenance
            generatedAt={state.response.generatedAt}
            caveats={state.response.caveats}
            assignments={selected.assignments}
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
            <span>Oppdag kommer senere</span>
          </nav>
        </div>
      </header>
      <ResultWorkspace />
      <footer className="site-footer">
        <div><p>© 2026 Handleplan • Uavhengig prissammenligning</p></div>
      </footer>
    </div>
  );
}
