"use client";

import {
  publicProductSearchResponseSchema,
  type Product,
  type PublicCatalogProduct,
} from "@handleplan/domain";
import { useEffect, useId, useRef, useState } from "react";

import { BASKET_QUANTITY_MAX, BASKET_QUANTITY_MIN } from "../../lib/browser-basket";

const MAX_SEARCH_RESPONSE_BYTES = 128 * 1024;

export type ProductSearch = (query: string, signal: AbortSignal) => Promise<Product[]>;

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Cleanup is best effort; callers receive one sanitized search failure.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;.*)?$/i.test(contentType)) {
    await cancelBody(response.body);
    throw new Error("PRODUCT_SEARCH_FAILED");
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_SEARCH_RESPONSE_BYTES
  ) {
    await cancelBody(response.body);
    throw new Error("PRODUCT_SEARCH_FAILED");
  }
  if (response.body === null) throw new Error("PRODUCT_SEARCH_FAILED");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SEARCH_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("PRODUCT_SEARCH_FAILED");
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return JSON.parse(fragments.join("")) as unknown;
  } catch {
    try { await reader.cancel(); } catch { /* Cleanup only. */ }
    throw new Error("PRODUCT_SEARCH_FAILED");
  }
}

function legacyProductFromCatalog(product: PublicCatalogProduct): Product {
  return {
    ean: product.gtin,
    name: product.displayName,
    ...(product.brand === undefined ? {} : { brand: product.brand }),
    packageQuantity: product.packageMeasure.amount,
    packageUnit:
      product.packageMeasure.unit === "g" || product.packageMeasure.unit === "ml"
        ? product.packageMeasure.unit
        : "each",
  };
}

export async function searchProductsFromApi(
  query: string,
  signal: AbortSignal,
): Promise<Product[]> {
  const response = await fetch(`/api/products/search?q=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) {
    await cancelBody(response.body);
    throw new Error("PRODUCT_SEARCH_FAILED");
  }
  const parsed = publicProductSearchResponseSchema.safeParse(await readBoundedJson(response));
  if (!parsed.success) throw new Error("PRODUCT_SEARCH_FAILED");
  return parsed.data.products.map(legacyProductFromCatalog);
}

interface NeedComposerProps {
  onProduct: (product: Product, quantity: number) => void;
  searchProducts: ProductSearch;
  searchDelayMs?: number;
  disabled?: boolean;
}

type SearchState = "idle" | "loading" | "ready" | "empty" | "error";

function optionLabel(product: Product): string {
  const amount = product.packageQuantity
    ? `, ${product.packageQuantity} ${product.packageUnit ?? ""}`
    : "";
  return `${product.name}${amount}`;
}

export function NeedComposer({
  onProduct,
  searchProducts,
  searchDelayMs = 250,
  disabled = false,
}: NeedComposerProps) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [products, setProducts] = useState<Product[]>([]);
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const requestSequence = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const popup = useRef<HTMLDivElement | null>(null);
  const boundary = useRef<HTMLElement | null>(null);

  useEffect(() => {
    return () => {
      requestSequence.current += 1;
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      controller.current?.abort();
    };
  }, []);

  function cancelSearchWork(): void {
    requestSequence.current += 1;
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    controller.current?.abort();
    controller.current = undefined;
  }

  function dismissSearch(): void {
    cancelSearchWork();
    setOpen(false);
    setProducts([]);
    setSearchState("idle");
    setActiveIndex(-1);
  }

  function scheduleSearch(nextQuery: string): void {
    cancelSearchWork();
    const trimmed = nextQuery.trim();
    if (trimmed.length < 2) {
      setOpen(false);
      setSearchState("idle");
      return;
    }

    const sequence = requestSequence.current;
    const nextController = new AbortController();
    controller.current = nextController;
    setOpen(true);
    setSearchState("loading");
    timer.current = window.setTimeout(async () => {
      timer.current = undefined;
      try {
        const nextProducts = await searchProducts(trimmed, nextController.signal);
        if (sequence !== requestSequence.current || nextController.signal.aborted) return;
        setProducts(nextProducts);
        setSearchState(nextProducts.length > 0 ? "ready" : "empty");
        setActiveIndex(-1);
      } catch (error) {
        if (
          sequence !== requestSequence.current ||
          nextController.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        setProducts([]);
        setSearchState("error");
      }
    }, searchDelayMs);
  }

  function reset(): void {
    cancelSearchWork();
    setQuery("");
    setQuantity(1);
    setProducts([]);
    setOpen(false);
    setSearchState("idle");
    setActiveIndex(-1);
  }

  function chooseProduct(product: Product): void {
    onProduct(product, quantity);
    reset();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      dismissSearch();
      return;
    }
    if (!open || products.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % products.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? products.length - 1 : index - 1));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      const product = products[activeIndex];
      if (product) chooseProduct(product);
    }
  }

  const activeOptionId = open && activeIndex >= 0
    ? `${listId}-option-${activeIndex}`
    : undefined;
  return (
    <section
      className="need-composer-section"
      ref={boundary}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        dismissSearch();
      }}
    >
      <h1>Hva skal du handle?</h1>
      <div className="need-composer">
        <div className="need-search-wrap">
          <span className="search-mark" aria-hidden="true">⌕</span>
          <label className="sr-only" htmlFor={`${listId}-input`}>Hva skal du handle?</label>
          <input
            id={`${listId}-input`}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={open}
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            placeholder="F.eks. Norvegia eller bare 'ost'..."
            disabled={disabled}
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              setProducts([]);
              setSearchState("idle");
              setActiveIndex(-1);
              scheduleSearch(nextQuery);
            }}
            onKeyDown={onKeyDown}
          />
          <div className="quantity-stepper" aria-label="Antall">
            <button
              type="button"
              aria-label="Reduser antall"
              disabled={quantity <= BASKET_QUANTITY_MIN}
              onClick={() => setQuantity((value) => Math.max(BASKET_QUANTITY_MIN, value - 1))}
            >−</button>
            <output aria-live="polite">{quantity}</output>
            <button
              type="button"
              aria-label="Øk antall"
              disabled={quantity >= BASKET_QUANTITY_MAX}
              onClick={() => setQuantity((value) => Math.min(BASKET_QUANTITY_MAX, value + 1))}
            >+</button>
          </div>
        </div>
      </div>
      {disabled ? <p role="status">Handlekurven kan inneholde maksimalt 50 varebehov.</p> : null}
      {!disabled && searchState === "ready" ? <p role="status">Velg et eksakt produkt fra forslagene. Bruk «Varetype» nedenfor hvis Handleplan skal velge blant gjennomgåtte alternativer.</p> : null}
      <div ref={popup} className="search-popover" hidden={!open}>
        {open ? (
          <>
            {searchState === "loading" ? <p role="status">Henter produkter …</p> : null}
            {searchState === "empty" ? <p role="status">Ingen støttede produkter funnet. Velg et eksakt produkt eller avgrens søket til en støttet varetype.</p> : null}
            {searchState === "error" ? <p role="alert">Kunne ikke hente produkter. Prøv igjen.</p> : null}
          </>
        ) : null}
        <ul id={listId} role="listbox" aria-label="Produktforslag">
          {open && searchState === "ready"
            ? products.map((product, index) => (
              <li
                id={`${listId}-option-${index}`}
                key={product.ean}
                role="option"
                tabIndex={-1}
                aria-selected={activeIndex === index}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseProduct(product)}
              >
                <span>{product.name}</span>
                {product.brand ? <small>{product.brand}</small> : null}
                <span className="sr-only">{optionLabel(product)}</span>
              </li>
            ))
            : null}
        </ul>
      </div>
    </section>
  );
}
