import type { ProductLine } from "./types.js";

export interface KpCandidateInput {
  pageId: string;
  name: string;
  email: string;
  emailVerifiedStatus: string;
  contactRole: string;
  title: string;
  confidence: string;
  currentEmploymentConfirmed: string;
  contactPriority: string;
  fitScore: number | null;
}

export interface RankedKp {
  pageId: string;
  name: string;
  email: string;
  tier: number;
  contactRole: string;
  title: string;
  contactPriority: string;
  fitScore: number;
}

const VERIFIED = new Set(["Verified", "Icypeas Verified"]);

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, Hold: 9 };

type TierRule = { tier: number; roleExact?: string[]; titleRe: RegExp };

/** Tier rules: Contact Role exact match and/or Title keywords. */
const TIER_RULES: TierRule[] = [
  {
    tier: 1,
    roleExact: ["Lifecycle / CRM / Retention"],
    titleRe: /\b(marketing|lifecycle|crm|retention|growth marketing)\b/i,
  },
  {
    tier: 2,
    roleExact: ["Brand / Marketing / Growth", "DTC / eCommerce / Post-purchase"],
    titleRe: /\b(brand|growth|operations|general manager|\bgm\b|e-?commerce|dtc|digital)\b/i,
  },
  {
    tier: 3,
    roleExact: ["Founder / CEO / COO"],
    titleRe: /\b(founder|ceo|coo|owner|chief executive)\b/i,
  },
];

function roleTier(role: string, productLine: ProductLine): number[] {
  const tiers: number[] = [];
  const r = role.trim();
  if (!r) return tiers;

  if (r === "Amazon / Marketplace Channel Owner") {
    tiers.push(productLine === "ASIN_Plus" ? 1 : 3);
    return tiers;
  }
  if (r === "External Amazon / Marketplace Operator") {
    if (productLine === "ASIN_Plus") tiers.push(4);
    return tiers; // exclude for DTC (no tier)
  }

  for (const rule of TIER_RULES) {
    if (rule.roleExact?.includes(r)) tiers.push(rule.tier);
  }
  // Marketing-leaning Brand/Marketing/Growth → also allow tier 1 via title
  return tiers;
}

function titleTier(title: string): number[] {
  const tiers: number[] = [];
  const t = title.trim();
  if (!t) return tiers;
  for (const rule of TIER_RULES) {
    if (rule.titleRe.test(t)) tiers.push(rule.tier);
  }
  return tiers;
}

export function resolveKpTier(input: KpCandidateInput, productLine: ProductLine): number[] {
  const fromRole = roleTier(input.contactRole, productLine);
  const fromTitle = titleTier(input.title);
  const merged = [...new Set([...fromRole, ...fromTitle])].sort((a, b) => a - b);
  return merged;
}

export function isKpEligible(input: KpCandidateInput): boolean {
  if (!/@/.test(String(input.email || "").trim())) return false;
  if (!VERIFIED.has(String(input.emailVerifiedStatus || "").trim())) return false;
  if (String(input.currentEmploymentConfirmed || "").trim() === "No") return false;
  return true;
}

export function buildKpList(
  candidates: KpCandidateInput[],
  productLine: ProductLine,
): RankedKp[] {
  const ranked: RankedKp[] = [];
  for (const c of candidates) {
    if (!isKpEligible(c)) continue;
    const tiers = resolveKpTier(c, productLine);
    if (tiers.length === 0) continue;
    ranked.push({
      pageId: c.pageId,
      name: c.name,
      email: c.email.trim().toLowerCase(),
      tier: tiers[0]!,
      contactRole: c.contactRole,
      title: c.title,
      contactPriority: c.contactPriority,
      fitScore: c.fitScore ?? 0,
    });
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const pa = PRIORITY_RANK[a.contactPriority] ?? 8;
    const pb = PRIORITY_RANK[b.contactPriority] ?? 8;
    if (pa !== pb) return pa - pb;
    if (b.fitScore !== a.fitScore) return b.fitScore - a.fitScore;
    return a.pageId.localeCompare(b.pageId);
  });

  // Dedupe by email, keep best rank
  const seenEmail = new Set<string>();
  const out: RankedKp[] = [];
  for (const r of ranked) {
    if (seenEmail.has(r.email)) continue;
    seenEmail.add(r.email);
    out.push(r);
  }
  return out;
}
