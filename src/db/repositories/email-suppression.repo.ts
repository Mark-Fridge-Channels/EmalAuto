import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { emailSuppressions } from "../schema/email_suppressions.js";

export async function recordEmailSuppression(params: {
  email: string;
  notionPageId?: string | null;
  source?: string;
}): Promise<{ inserted: boolean; id: number }> {
  const email = params.email.trim().toLowerCase();
  const source = params.source?.trim() || "list_unsubscribe_one_click";

  const rows = await db
    .insert(emailSuppressions)
    .values({
      email,
      notionPageId: params.notionPageId?.trim() || null,
      source,
    })
    .onConflictDoNothing({ target: emailSuppressions.email })
    .returning({ id: emailSuppressions.id });

  if (rows[0]) return { inserted: true, id: rows[0].id };

  const [existing] = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(eq(emailSuppressions.email, email))
    .limit(1);

  return { inserted: false, id: existing?.id ?? 0 };
}
