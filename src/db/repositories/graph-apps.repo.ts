import { asc, eq } from "drizzle-orm";
import { db } from "../client.js";
import { graphApps, type GraphAppRow, type NewGraphAppRow } from "../schema/graph_apps.js";

export async function listGraphApps(): Promise<GraphAppRow[]> {
  return db.select().from(graphApps).orderBy(asc(graphApps.domain));
}

export async function insertGraphApp(row: NewGraphAppRow): Promise<GraphAppRow> {
  const [r] = await db.insert(graphApps).values(row).returning();
  return r!;
}

export async function updateGraphApp(
  id: number,
  patch: Partial<Pick<GraphAppRow, "domain" | "tenantId" | "clientId" | "clientSecret" | "enabled">>,
): Promise<GraphAppRow | undefined> {
  const [r] = await db
    .update(graphApps)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(graphApps.id, id))
    .returning();
  return r;
}

export async function deleteGraphApp(id: number): Promise<void> {
  await db.delete(graphApps).where(eq(graphApps.id, id));
}
