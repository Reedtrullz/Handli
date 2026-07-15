"use client";

import { productSchema, type Product } from "@handleplan/domain";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";

import { BASKET_QUANTITY_MAX, BASKET_QUANTITY_MIN } from "../../lib/browser-basket";

const searchResponseSchema = z.object({ products: z.array(productSchema) }).strict();

export type ProductSearch = (query: string, signal: AbortSignal) => Promise<Product[]>;

export async function searchProductsFromApi(
  query: string,
  signal: AbortSignal,
): Promise<Product[]> {
  const response = await fetch(`/api/products/search?q=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) throw new Error("PRODUCT_SEARCH_FAILED");
  return searchResponseSchema.parse(await response.json()).products;
}

interface NeedComposerProps {
  onGenericNeed: (query: string, quantity: number) => void;
  onProduct: (product: Product, quantity: number) => void;
  searchProducts: ProductSearch;
  searchDelayMs?: number;
}

type SearchState = "idle" | "loading" | "ready" | "empty" | "error";

function optionLabel(product: Product): string {
  const amount = product.packageQuantity
    ? `, ${product.packageQuantity} ${product.packageUnit ?? ""}`
    : "";
  return `${product.name}${amount}`;
}

export function NeedComposer({
  onGenericNeed,
  onProduct,
  searchProducts,
  searchDelayMs = 250,
}: NeedComposerProps) {
  const popupId = useId();
  const listId = `${popupId}-listbox`;
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

  function addGeneric(): void {
    const trimmed = query.trim();
    if (!trimmed) return;
    onGenericNeed(trimmed, quantity);
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
    <section className="need-composer-section">
      <h1>Hva skal du handle?</h1>
      <div className="need-composer">
        <div className="need-search-wrap">
          <span className="search-mark" aria-hidden="true">⌕</span>
          <label className="sr-only" htmlFor={`${popupId}-input`}>Hva skal du handle?</label>
          <input
            id={`${popupId}-input`}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={popupId}
            aria-expanded={open}
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            placeholder="F.eks. Norvegia eller bare 'ost'..."
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
            onBlur={(event) => {
              const nextTarget = event.relatedTarget;
              if (nextTarget instanceof Node && popup.current?.contains(nextTarget)) return;
              dismissSearch();
            }}
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
        <button className="primary-button composer-add" type="button" onClick={addGeneric} disabled={!query.trim()}>
          Legg til
        </button>
      </div>
      <div id={popupId} ref={popup} className="search-popover" hidden={!open}>
        {open ? (
          <>
          {searchState === "loading" ? <p role="status">Henter produkter …</p> : null}
          {searchState === "empty" ? <p role="status">Ingen produkter funnet. Legg til som et generelt behov.</p> : null}
          {searchState === "error" ? <p role="alert">Kunne ikke hente produkter. Prøv igjen.</p> : null}
          {searchState === "ready" ? (
            <ul id={listId} role="listbox" aria-label="Produktforslag">
              {products.map((product, index) => (
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
              ))}
            </ul>
          ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
