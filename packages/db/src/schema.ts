import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core";

export const priceCache = pgTable(
  "price_cache",
  {
    ean: varchar("ean", { length: 14 }).notNull(),
    chain: varchar("chain", { length: 32 }).notNull(),
    amountOre: integer("amount_ore").notNull(),
    observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ean, table.chain] }),
    check("price_cache_ean_shape", sql`${table.ean} ~ '^([0-9]{8}|[0-9]{13})$'`),
    check(
      "price_cache_chain_supported",
      sql`${table.chain} in ('bunnpris', 'rema-1000', 'extra')`,
    ),
    check("price_cache_amount_ore_nonnegative", sql`${table.amountOre} >= 0`),
  ],
);

export type PriceCacheRow = typeof priceCache.$inferSelect;
export type NewPriceCacheRow = typeof priceCache.$inferInsert;

export * from "./evidence-schema";
