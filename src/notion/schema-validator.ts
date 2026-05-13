/**
 * Verify that the configured Notion database has all required columns
 * with compatible types. Run at startup so misconfigurations fail loudly,
 * not silently at runtime.
 */

import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { retrieveDatabase } from "./client.js";

interface FieldSpec {
  /** Semantic key from config.notion.property_names */
  semanticKey: string;
  /** Allowed Notion property types */
  allowedTypes: string[];
}

const REQUIRED_FIELDS: FieldSpec[] = [
  { semanticKey: "Status", allowedTypes: ["status", "select"] },
  { semanticKey: "Action", allowedTypes: ["select"] },
  { semanticKey: "Platform", allowedTypes: ["select"] },
  { semanticKey: "InNOut", allowedTypes: ["select"] },
  { semanticKey: "sender_email", allowedTypes: ["rich_text", "email", "title"] },
  { semanticKey: "subject", allowedTypes: ["rich_text", "title"] },
  { semanticKey: "body", allowedTypes: ["rich_text"] },
  { semanticKey: "payload", allowedTypes: ["rich_text"] },
  { semanticKey: "completion_time", allowedTypes: ["date"] },
  { semanticKey: "result_remark", allowedTypes: ["rich_text"] },
  { semanticKey: "reply_status", allowedTypes: ["status", "select"] },
  { semanticKey: "reply_body", allowedTypes: ["rich_text"] },
  { semanticKey: "reply_email", allowedTypes: ["email", "rich_text"] },
  { semanticKey: "last_reply_time", allowedTypes: ["date"] },
  { semanticKey: "trigger_time", allowedTypes: ["date"] },
];

export interface SchemaIssue {
  semanticKey: string;
  configuredColumn: string;
  reason: "missing" | "wrong_type";
  actualType?: string;
  allowedTypes?: string[];
}

export async function validateNotionSchema(): Promise<SchemaIssue[]> {
  const cfg = loadConfig();
  const db = await retrieveDatabase(cfg.notion.database_id);
  const issues: SchemaIssue[] = [];
  const propertyNames = cfg.notion.property_names as Record<string, string>;

  for (const f of REQUIRED_FIELDS) {
    const colName = propertyNames[f.semanticKey];
    if (!colName) {
      issues.push({
        semanticKey: f.semanticKey,
        configuredColumn: "(unset)",
        reason: "missing",
      });
      continue;
    }
    const prop = db.properties[colName];
    if (!prop) {
      issues.push({ semanticKey: f.semanticKey, configuredColumn: colName, reason: "missing" });
      continue;
    }
    if (!f.allowedTypes.includes(prop.type)) {
      issues.push({
        semanticKey: f.semanticKey,
        configuredColumn: colName,
        reason: "wrong_type",
        actualType: prop.type,
        allowedTypes: f.allowedTypes,
      });
    }
  }

  if (issues.length === 0) {
    logger.info({ database_id: cfg.notion.database_id }, "notion schema OK");
  } else {
    logger.error({ issues }, "notion schema validation failed");
  }
  return issues;
}
