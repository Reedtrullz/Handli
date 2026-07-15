import { integer, pgTable, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core";

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
  (table) => [primaryKey({ columns: [table.ean, table.chain] })],
);

export type PriceCacheRow = typeof priceCache.$inferSelect;
export type NewPriceCacheRow = typeof priceCache.$inferInsert;
