"use client";

import { productSchema, type Product } from "@handleplan/domain";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";

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
  const listId = useId();
  const [query, setQuery] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [products, setProducts] = useState<Product[]>([]);
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const requestSequence = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    const sequence = ++requestSequence.current;
    if (trimmed.length < 2) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchState("loading");
      setOpen(true);
      try {
        const nextProducts = await searchProducts(trimmed, controller.signal);
        if (sequence !== requestSequence.current || controller.signal.aborted) return;
        setProducts(nextProducts);
        setSearchState(nextProducts.length > 0 ? "ready" : "empty");
        setActiveIndex(-1);
      } catch (error) {
        if (
          sequence !== requestSequence.current ||
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        setProducts([]);
        setSearchState("error");
      }
    }, searchDelayMs);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchDelayMs, searchProducts]);

  function reset(): void {
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
      setOpen(false);
      setActiveIndex(-1);
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

  const activeOptionId = activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;

  return (
    <section className="need-composer-section">
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
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              setProducts([]);
              setSearchState("idle");
              setOpen(nextQuery.trim().length >= 2);
              setActiveIndex(-1);
            }}
            onFocus={() => query.trim().length >= 2 && setOpen(true)}
            onKeyDown={onKeyDown}
          />
          <div className="quantity-stepper" aria-label="Antall">
            <button
              type="button"
              aria-label="Reduser antall"
              onClick={() => setQuantity((value) => Math.max(1, value - 1))}
            >−</button>
            <output aria-live="polite">{quantity}</output>
            <button
              type="button"
              aria-label="Øk antall"
              onClick={() => setQuantity((value) => value + 1)}
            >+</button>
          </div>
        </div>
        <button className="primary-button composer-add" type="button" onClick={addGeneric} disabled={!query.trim()}>
          Legg til
        </button>
      </div>
      {open ? (
        <div className="search-popover">
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
        </div>
      ) : null}
    </section>
  );
}
