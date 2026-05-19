/**
 * Microsoft Graph app registrations — one row per mailbox domain (app key).
 * When `GRAPH_APPS_SOURCE=db`, this table replaces `GRAPH_APP_*` env groups.
 */

import { pgTable, serial, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const graphApps = pgTable(
  "graph_apps",
  {
    id: serial("id").primaryKey(),
    /** Lower-case email domain used as lookup key (must match mailbox @domain). */
    domain: text("domain").notNull(),
    tenantId: text("tenant_id").notNull(),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    domainUniq: uniqueIndex("graph_apps_domain_uniq").on(t.domain),
  }),
);

export type GraphAppRow = typeof graphApps.$inferSelect;
export type NewGraphAppRow = typeof graphApps.$inferInsert;
