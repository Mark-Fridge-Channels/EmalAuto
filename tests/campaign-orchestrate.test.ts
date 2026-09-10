import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addBusinessDaysYmd,
  isBusinessDayYmd,
  listBusinessDaysInclusive,
  pickEtBusinessSendTime,
} from "../src/campaign/business-days.js";
import { buildKpList, type KpCandidateInput } from "../src/campaign/kp-rank.js";
import { scheduleInstances, type CampaignInstanceInput } from "../src/campaign/scheduler.js";

describe("business-days", () => {
  it("lists ET window business days for Sep 10-18 2026", () => {
    const days = listBusinessDaysInclusive("2026-09-10", "2026-09-18");
    assert.deepEqual(days, [
      "2026-09-10",
      "2026-09-11",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
    ]);
  });

  it("adds business days skipping weekend", () => {
    assert.equal(addBusinessDaysYmd("2026-09-11", 1), "2026-09-14");
    assert.equal(isBusinessDayYmd("2026-09-12"), false);
  });

  it("pickEtBusinessSendTime avoids :00 and :30 and is deterministic", () => {
    const a = pickEtBusinessSendTime("task-a:1");
    const b = pickEtBusinessSendTime("task-a:1");
    const c = pickEtBusinessSendTime("task-b:2");
    assert.deepEqual(a, b);
    assert.equal(a.minute === 0 || a.minute === 30, false);
    assert.ok(a.hour >= 9 && a.hour <= 16);
    assert.notDeepEqual(a, c);
  });
});

describe("kp-rank", () => {
  it("orders by tier then priority and requires verified email", () => {
    const candidates: KpCandidateInput[] = [
      {
        pageId: "b",
        name: "Founder",
        email: "f@x.com",
        emailVerifiedStatus: "Verified",
        contactRole: "Founder / CEO / COO",
        title: "CEO",
        confidence: "High",
        currentEmploymentConfirmed: "Yes",
        contactPriority: "P0",
        fitScore: 90,
      },
      {
        pageId: "a",
        name: "CRM",
        email: "c@x.com",
        emailVerifiedStatus: "Icypeas Verified",
        contactRole: "Lifecycle / CRM / Retention",
        title: "CRM Lead",
        confidence: "High",
        currentEmploymentConfirmed: "Yes",
        contactPriority: "P1",
        fitScore: 50,
      },
      {
        pageId: "z",
        name: "Bad",
        email: "bad@x.com",
        emailVerifiedStatus: "Risky",
        contactRole: "Lifecycle / CRM / Retention",
        title: "",
        confidence: "High",
        currentEmploymentConfirmed: "Yes",
        contactPriority: "P0",
        fitScore: 99,
      },
    ];
    const list = buildKpList(candidates, "DTC");
    assert.equal(list.length, 2);
    assert.equal(list[0]!.pageId, "a");
    assert.equal(list[1]!.pageId, "b");
  });
});

describe("scheduler", () => {
  it("places DTC 4-step and ASIN 5-step within window under cap", () => {
    const mk = (id: string, productLine: "DTC" | "ASIN_Plus", steps: number): CampaignInstanceInput => ({
      instanceKey: `k:${id}:${productLine}`,
      clientPageId: id,
      companyName: id,
      productLine,
      stepCount: steps,
      kpList: [
        {
          pageId: "kp1",
          name: "N",
          email: "n@x.com",
          tier: 1,
          contactRole: "Lifecycle / CRM / Retention",
          title: "",
          contactPriority: "P0",
          fitScore: 1,
        },
      ],
    });

    const report = scheduleInstances({
      instances: [mk("c1", "DTC", 4), mk("c2", "ASIN_Plus", 5)],
      mailboxes: ["a@fc.com", "b@fc.com"],
      windowStart: "2026-09-10",
      windowEnd: "2026-09-18",
      dailyCap: 50,
    });

    assert.equal(report.atRiskCount, 0);
    const dtc = report.scheduled.find((s) => s.instance.productLine === "DTC")!;
    const asin = report.scheduled.find((s) => s.instance.productLine === "ASIN_Plus")!;
    assert.equal(dtc.steps.length, 4);
    assert.equal(asin.steps.length, 5);
    assert.equal(asin.steps[0]!.triggerYmd, "2026-09-10");
    assert.equal(asin.steps[4]!.triggerYmd, "2026-09-16");
  });
});
