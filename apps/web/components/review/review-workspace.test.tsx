// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { createHash } from "node:crypto";

import type { ReviewQueueCandidateV1 } from "@handleplan/domain";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkspace } from "./review-workspace";

const entry: ReviewQueueCandidateV1 = {
  approvalEvidence: {
    cropGeometry: "unavailable",
    presentation: "full_capture",
    state: "render_required",
  },
  anomalyCodes: ["OCR_REVIEW_REQUIRED"],
  candidate: {
    anomalyCodes: ["OCR_REVIEW_REQUIRED"],
    channels: ["in-store"],
    contractVersion: 1,
    eligibility: { kind: "public" },
    package: { amount: 1_000, state: "parsed", unit: "ml", unitsPerPack: 1 },
    pricing: { beforePriceOre: 3_990, kind: "unit", offerPriceOre: 2_990 },
    product: { kind: "exact-identifier", scheme: "gtin", value: "7038010000010" },
    provenance: {
      confidence: 92,
      evidenceLocator: `review-evidence:${"c".repeat(64)}`,
      method: "ocr",
    },
    validity: {
      endsAt: "2026-07-20T00:00:00.000Z",
      startsAt: "2026-07-13T00:00:00.000Z",
      state: "parsed",
    },
  },
  candidateId: "review-candidate:42",
  capture: {
    cropReference: `review-crop:${"a".repeat(64)}`,
    mimeType: "image/png",
    retrievedAt: "2026-07-12T12:00:30.000Z",
    rightsClassification: "private_review",
  },
  chain: "extra",
  confidence: 92,
  createdAt: "2026-07-12T12:01:01.000Z",
  extractionMethod: "ocr",
  extractionDisposition: "review-required",
  publication: {
    title: "Synthetic local edition",
    validFrom: "2026-07-13T00:00:00.000Z",
    validUntil: "2026-07-20T00:00:00.000Z",
  },
  scope: { id: "review-scope:9", kind: "postal_set", label: "Synthetic local" },
  sourceId: "synthetic-rights-cleared-feed",
  version: 0,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReviewWorkspace", () => {
  it("browses the private queue and places rights metadata beside immutable typed fields", async () => {
    const fetcher = vi.fn(async () => Response.json({ contractVersion: 1, items: [entry] }));
    vi.stubGlobal("fetch", fetcher);
    render(<ReviewWorkspace />);

    expect(await screen.findByRole("heading", { name: "Tilbud til vurdering" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Privat kildebevis" })).toBeVisible();
    expect(screen.getByText(/hele den verifiserte kildefilen vises/i)).toBeVisible();
    expect(screen.getByText(/ikke et beskåret utsnitt/i)).toBeVisible();
    expect(screen.getByText("Kun privat vurdering")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Godkjenning er sperret");
    const typed = screen.getByRole("region", { name: "Uttrekte felter" });
    expect(within(typed).getByText("29,90 kr")).toBeVisible();
    expect(within(typed).getByText("39,90 kr")).toBeVisible();
    expect(within(typed).getByText("OCR_REVIEW_REQUIRED")).toBeVisible();
    expect(document.body.textContent).not.toContain("official-offers/private");
    expect(document.body.textContent).not.toContain("checksum");
  });

  it("unlocks approval only after the full image is read, decoded, and acknowledged", async () => {
    const proofToken = `review-proof:v1.${Date.parse("2099-07-17T12:02:00.000Z").toString(36)}.${"a".repeat(22)}.${"b".repeat(64)}.${"c".repeat(64)}`;
    const challengeToken = `review-challenge:v1.${Date.parse("2099-07-17T12:01:00.000Z").toString(36)}.${"d".repeat(22)}.${"e".repeat(64)}.${"f".repeat(64)}`;
    const privateBytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]);
    const digestSha256 = createHash("sha256").update(privateBytes).digest("hex");
    const acknowledgementBodies: unknown[] = [];
    const actionBodies: unknown[] = [];
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async (_algorithm: string, input: ArrayBuffer) =>
          Uint8Array.from(createHash("sha256").update(new Uint8Array(input)).digest()).buffer),
      },
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:https://handle.reidar.tech/synthetic-evidence"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/evidence")) {
        return new Response(privateBytes, {
          headers: {
            "content-length": String(privateBytes.byteLength),
            "content-type": "image/png",
            "x-handleplan-review-evidence-challenge": challengeToken,
            "x-handleplan-review-evidence-expires": "2099-07-17T12:01:00.000Z",
            "x-handleplan-review-evidence-presentation": "full_capture",
          },
        });
      }
      if (url.endsWith("/evidence/ack")) {
        acknowledgementBodies.push(JSON.parse(String(init?.body)) as unknown);
        return Response.json({
          candidateId: entry.candidateId,
          contractVersion: 1,
          expiresAt: "2099-07-17T12:02:00.000Z",
          presentation: "full_capture",
          proofToken,
          renderedAt: "2099-07-17T12:00:01.000Z",
        });
      }
      if ((init?.method ?? "GET") === "POST") {
        actionBodies.push(JSON.parse(String(init?.body)) as unknown);
        return Response.json({
          actedAt: "2099-07-17T12:00:01.000Z",
          actionId: "review-action:7",
          candidateId: entry.candidateId,
          contractVersion: 1,
          newVersion: 1,
          offerId: "review-offer:8",
          state: "approved",
        });
      }
      return Response.json({ contractVersion: 1, items: [entry] });
    }));
    const user = userEvent.setup();
    render(<ReviewWorkspace />);

    await screen.findByRole("heading", { name: "Vurder kandidat" });
    await user.click(screen.getByRole("button", { name: "Vis verifisert full kildefil" }));
    const image = await screen.findByRole("img", { name: /verifisert full kildefil/i });
    expect(screen.getByRole("button", { name: "Godkjenn som uttrekt" })).toBeDisabled();
    fireEvent.load(image);
    await user.type(screen.getByLabelText("Begrunnelse"), "Kontrollert mot hele kildefilen.");
    const approve = screen.getByRole("button", { name: "Godkjenn som uttrekt" });
    await waitFor(() => expect(approve).toBeEnabled());
    await user.click(approve);

    await waitFor(() => expect(screen.getByText("Kandidaten er godkjent.")).toBeVisible());
    expect(acknowledgementBodies).toEqual([{
      candidateId: entry.candidateId,
      challenge: challengeToken,
      contractVersion: 1,
      digestSha256,
      presentation: "full_capture",
    }]);
    expect(actionBodies).toEqual([expect.objectContaining({
      action: "approve",
      approvalEvidence: { presentation: "full_capture", token: proofToken },
      candidateId: entry.candidateId,
    })]);
    expect(document.body.textContent).not.toContain(proofToken);
    expect(document.body.textContent).not.toContain("official-offers/private");
  });

  it("keeps PDF evidence read-only even when its iframe loads", async () => {
    const pdfEntry: ReviewQueueCandidateV1 = {
      ...entry,
      capture: { ...entry.capture, mimeType: "application/pdf" },
    };
    const challengeToken = `review-challenge:v1.${Date.parse("2099-07-17T12:01:00.000Z").toString(36)}.${"d".repeat(22)}.${"e".repeat(64)}.${"f".repeat(64)}`;
    const pdfBytes = new TextEncoder().encode("%PDF-truncated synthetic fixture");
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async (_algorithm: string, input: ArrayBuffer) =>
          Uint8Array.from(createHash("sha256").update(new Uint8Array(input)).digest()).buffer),
      },
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:https://handle.reidar.tech/synthetic-pdf"),
      revokeObjectURL: vi.fn(),
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/evidence")) {
        return new Response(pdfBytes, {
          headers: {
            "content-length": String(pdfBytes.byteLength),
            "content-type": "application/pdf",
            "x-handleplan-review-evidence-challenge": challengeToken,
            "x-handleplan-review-evidence-expires": "2099-07-17T12:01:00.000Z",
            "x-handleplan-review-evidence-presentation": "full_capture",
          },
        });
      }
      return Response.json({ contractVersion: 1, items: [pdfEntry] });
    });
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<ReviewWorkspace />);

    await screen.findByRole("heading", { name: "Vurder kandidat" });
    await user.click(screen.getByRole("button", { name: "Vis verifisert full kildefil" }));
    const frame = await screen.findByTitle("Verifisert full kildefil i PDF-format");
    fireEvent.load(frame);

    expect(screen.getByText(/PDF-filen kan leses, men godkjenning er sperret/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Godkjenn som uttrekt" })).toBeDisabled();
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/evidence/ack"))).toBe(false);
  });

  it("blocks approval without renderable evidence while keeping rejection usable", async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      if (method === "POST") {
        return Response.json({
          actedAt: "2026-07-17T12:00:00.000Z",
          actionId: "review-action:7",
          candidateId: entry.candidateId,
          contractVersion: 1,
          newVersion: 1,
          state: "rejected",
        });
      }
      return Response.json({ contractVersion: 1, items: [entry] });
    });
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<ReviewWorkspace />);

    await screen.findByRole("heading", { name: "Vurder kandidat" });
    await user.type(screen.getByLabelText("Begrunnelse"), "Kildebeviset kan ikke kontrolleres.");
    const approve = screen.getByRole("button", { name: "Godkjenn som uttrekt" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute("aria-describedby", "review-approval-evidence-status");
    await user.click(screen.getByText("Korriger felter før godkjenning (sperret)"));
    expect(screen.getByRole("button", { name: "Korriger og godkjenn" })).toBeDisabled();
    expect(screen.getByLabelText("GTIN")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Avvis" }));

    await waitFor(() => expect(screen.getByText("Kandidaten er avvist.")).toBeVisible());
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      method: "POST",
      body: expect.objectContaining({
        action: "reject",
        candidateId: entry.candidateId,
        expectedVersion: 0,
        reason: "Kildebeviset kan ikke kontrolleres.",
      }),
    });
    expect(screen.queryByText("GTIN 7038010000010")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Tilbud til vurdering" }));
  });

  it("refreshes the queue after a stale optimistic write", async () => {
    let queueReads = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return Response.json({ code: "VERSION_CONFLICT" }, { status: 409 });
      }
      queueReads += 1;
      return Response.json({ contractVersion: 1, items: queueReads === 1 ? [entry] : [] });
    });
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<ReviewWorkspace />);

    await screen.findByRole("heading", { name: "Vurder kandidat" });
    await user.type(screen.getByLabelText("Begrunnelse"), "Avvises etter kontroll.");
    await user.click(screen.getByRole("button", { name: "Avvis" }));

    await waitFor(() => expect(queueReads).toBe(2));
    expect(screen.getByText(/annen økt/i)).toBeVisible();
    expect(screen.getByText("Ingen kandidater i dette utvalget.")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/annen økt/i);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Tilbud til vurdering" }));
  });

  it("follows the opaque cursor and appends a second queue page", async () => {
    const secondEntry: ReviewQueueCandidateV1 = {
      ...entry,
      candidate: {
        ...entry.candidate,
        product: { kind: "exact-identifier", scheme: "gtin", value: "7038010000027" },
      },
      candidateId: "review-candidate:43",
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes("cursor=")
        ? Response.json({ contractVersion: 1, items: [secondEntry] })
        : Response.json({
          contractVersion: 1,
          items: [entry],
          nextCursor: "review-cursor:aaaaaaaa",
        });
    });
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<ReviewWorkspace />);

    expect(await screen.findAllByText("GTIN 7038010000010")).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Last flere kandidater" }));

    expect(await screen.findAllByText("GTIN 7038010000027")).not.toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain("cursor=review-cursor%3Aaaaaaaaa");
  });

  it("ignores a slow obsolete page when filters start a newer generation", async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const filteredEntry: ReviewQueueCandidateV1 = {
      ...entry,
      candidate: {
        ...entry.candidate,
        product: { kind: "exact-identifier", scheme: "gtin", value: "7038010000027" },
      },
      candidateId: "review-candidate:43",
    };
    const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1
      ? first
      : Response.json({ contractVersion: 1, items: [filteredEntry] }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<ReviewWorkspace />);

    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await user.click(screen.getByText("Filtrer køen"));
    await user.selectOptions(screen.getByLabelText("Kjede"), "extra");
    expect(await screen.findAllByText("GTIN 7038010000027")).not.toHaveLength(0);

    resolveFirst(Response.json({ contractVersion: 1, items: [entry] }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.queryAllByText("GTIN 7038010000010")).toHaveLength(0);
    expect(screen.getAllByText("GTIN 7038010000027")).not.toHaveLength(0);
  });

  it("associates the structural approval controls with the evidence blocker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ contractVersion: 1, items: [entry] })));
    const user = userEvent.setup();
    render(<ReviewWorkspace />);

    await screen.findByRole("heading", { name: "Vurder kandidat" });
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("id", "review-approval-evidence-status");
    expect(status).toHaveTextContent("Du kan fortsatt avvise kandidaten");
    const correction = screen.getByText("Korriger felter før godkjenning (sperret)");
    expect(correction).toHaveAttribute("aria-describedby", "review-approval-evidence-status");
    await user.click(screen.getByText("Korriger felter før godkjenning (sperret)"));
    expect(screen.getByRole("button", { name: "Korriger og godkjenn" })).toBeDisabled();
  });
});
