import { addBusinessDaysYmd, listBusinessDaysInclusive } from "./business-days.js";
import type { ProductLine } from "./types.js";
import type { RankedKp } from "./kp-rank.js";

export interface CampaignInstanceInput {
  instanceKey: string;
  clientPageId: string;
  companyName: string;
  productLine: ProductLine;
  stepCount: number;
  kpList: RankedKp[];
}

export interface ScheduledStep {
  stepIndex: number;
  triggerYmd: string;
}

export interface ScheduledInstance {
  instance: CampaignInstanceInput;
  fcAccount: string;
  steps: ScheduledStep[];
  atRisk: boolean;
  riskReason?: string;
}

export interface ScheduleReport {
  businessDays: string[];
  scheduled: ScheduledInstance[];
  skippedNoKp: number;
  atRiskCount: number;
  dailyLoad: Record<string, Record<string, number>>; // ymd -> email -> count
}

function stepCountFor(productLine: ProductLine): number {
  return productLine === "DTC" ? 4 : 5;
}

export function defaultStepCount(productLine: ProductLine): number {
  return stepCountFor(productLine);
}

/** Stable sticky assignment: hash client+productLine into mailbox index, then light balance. */
export function assignStickyAccounts(
  instances: CampaignInstanceInput[],
  mailboxes: string[],
): Map<string, string> {
  if (mailboxes.length === 0) throw new Error("no sendable mailboxes");
  const sortedBoxes = [...mailboxes].map((e) => e.toLowerCase()).sort();
  const counts = new Map<string, number>(sortedBoxes.map((e) => [e, 0]));
  const assignment = new Map<string, string>();

  const sortedInst = [...instances].sort((a, b) => a.instanceKey.localeCompare(b.instanceKey));
  for (const inst of sortedInst) {
    let best = sortedBoxes[0]!;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const box of sortedBoxes) {
      const load = counts.get(box) ?? 0;
      // Prefer lower load; tie-break by hash distance
      const h = simpleHash(`${inst.instanceKey}:${box}`);
      const score = load * 1_000_000 + (h % 997);
      if (score < bestScore) {
        bestScore = score;
        best = box;
      }
    }
    assignment.set(inst.instanceKey, best);
    counts.set(best, (counts.get(best) ?? 0) + inst.stepCount);
  }
  return assignment;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Rolling day load simulation.
 * Places each instance's E1 as early as possible without exceeding dailyCap per mailbox,
 * with consecutive business-day follow-ups (min gap = 1).
 */
export function scheduleInstances(opts: {
  instances: CampaignInstanceInput[];
  mailboxes: string[];
  windowStart: string;
  windowEnd: string;
  dailyCap: number;
}): ScheduleReport {
  const businessDays = listBusinessDaysInclusive(opts.windowStart, opts.windowEnd);
  if (businessDays.length === 0) {
    throw new Error(`no business days in window ${opts.windowStart}..${opts.windowEnd}`);
  }

  const withKp = opts.instances.filter((i) => i.kpList.length > 0);
  const skippedNoKp = opts.instances.length - withKp.length;
  const sticky = assignStickyAccounts(withKp, opts.mailboxes);

  const dailyLoad: Record<string, Record<string, number>> = {};
  for (const d of businessDays) dailyLoad[d] = {};

  const inc = (ymd: string, email: string, n = 1) => {
    const row = dailyLoad[ymd] ?? (dailyLoad[ymd] = {});
    row[email] = (row[email] ?? 0) + n;
  };
  const loadOf = (ymd: string, email: string) => dailyLoad[ymd]?.[email] ?? 0;

  const scheduled: ScheduledInstance[] = [];

  // Longer sequences first so 5-step ASIN claims early slots
  const ordered = [...withKp].sort((a, b) => b.stepCount - a.stepCount || a.instanceKey.localeCompare(b.instanceKey));

  for (const inst of ordered) {
    const fcAccount = sticky.get(inst.instanceKey)!;
    const need = inst.stepCount;
    let placed: ScheduledStep[] | null = null;
    let riskReason: string | undefined;

    for (const e1 of businessDays) {
      const lastNeeded = addBusinessDaysYmd(e1, need - 1);
      if (lastNeeded > opts.windowEnd) {
        riskReason = `E1=${e1} last step ${lastNeeded} after window end`;
        continue;
      }
      const steps: ScheduledStep[] = [];
      let ok = true;
      for (let s = 0; s < need; s += 1) {
        const ymd = addBusinessDaysYmd(e1, s);
        if (ymd > opts.windowEnd || !businessDays.includes(ymd)) {
          ok = false;
          riskReason = `step ${s + 1} lands on ${ymd} outside window`;
          break;
        }
        if (loadOf(ymd, fcAccount) >= opts.dailyCap) {
          ok = false;
          riskReason = `cap full on ${ymd} for ${fcAccount}`;
          break;
        }
        steps.push({ stepIndex: s + 1, triggerYmd: ymd });
      }
      if (ok) {
        for (const st of steps) inc(st.triggerYmd, fcAccount, 1);
        placed = steps;
        break;
      }
    }

    if (!placed) {
      scheduled.push({
        instance: inst,
        fcAccount,
        steps: [],
        atRisk: true,
        riskReason: riskReason ?? "could not place within window/cap",
      });
      continue;
    }

    scheduled.push({
      instance: inst,
      fcAccount,
      steps: placed,
      atRisk: false,
    });
  }

  return {
    businessDays,
    scheduled,
    skippedNoKp,
    atRiskCount: scheduled.filter((s) => s.atRisk).length,
    dailyLoad,
  };
}

export function buildInstanceKey(campaignKey: string, clientPageId: string, productLine: ProductLine): string {
  const id = clientPageId.replace(/-/g, "");
  return `${campaignKey}:${id}:${productLine}`;
}

export function buildTaskId(campaignKey: string, clientPageId: string, productLine: ProductLine, stepIndex: number): string {
  return `${buildInstanceKey(campaignKey, clientPageId, productLine)}:${stepIndex}`;
}
