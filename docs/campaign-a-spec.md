# Christmas Pilot Email Campaign — Scheme A Spec (Phase 0)

**Status:** Draft for implementation  
**Timezone:** `America/New_York`  
**Send window:** 2026-09-10 → **effective last send day 2026-09-18 ET** (weekends 9/19–9/20 not scheduled)  
**Channel:** Email only (LinkedIn out of scope for this run)

---

## 1. Goal

Run a Scheme-A campaign:

1. **Orchestrator** filters Clients / builds KP lists / sticky-binds mailboxes / simulates daily load / **pre-writes** rows into `CampaignHistoryDB` (Subject/Body may be empty).
2. **Executor** (evolved poller + send worker) runs due Todos: render template when needed, send via Graph, write back body + status.
3. Notion stores config (Campaign + templates), history (tasks), and CRM (ClientDB / KeyPersonDB). Tasks are not “final copy” at write time.

---

## 2. Critical product rules (frozen)

| Topic | Rule |
|-------|------|
| Product lines | ICP Group `A` = DTC only; `B` = ASIN Plus only; `A&B` = **two campaign instances** (may use two sticky mailboxes) |
| Sticky mailbox | One `FCAccount` per `(Client, product_line)` for the whole instance |
| Window | First eligible day 9/10; last send day **9/18 ET**; min gap **1 business day** between steps of the same instance |
| Cadence | DTC 4 steps / ASIN 5 steps; default = consecutive business days from instance E1 (`+1` each); compress not needed below 1bd — if late, **pull E1 earlier** |
| Capacity | ~45 mailboxes × 50 sends/day; simulate **per instance**; no warmup ramp this run |
| Template vs body | Send as-is **only if Subject and Body are both non-empty**; if either empty → render **both** from related template, then write back |
| Reply | Human reply → cancel **all** open email Todos for that **Client** (all product lines) |
| Unsubscribe | Stop that Client’s email campaigns; **do not** switch to another KP |
| Bounce | **Hard Bounce** only → try next KP on list; soft/other ≠ switch |
| Auto-reply | Does **not** stop flow |
| Send success | Graph `sendMail` success counts; later Hard Bounce may still trigger KP switch for remaining / retry policy below |
| No eligible KP | Client excluded at orchestration (never written) |
| List exhausted | Instance → Failed; all later Todos of that instance → Cancelled |
| Auth for Notion writes | Prefer **ntn** token path (more stable bulk writes) |

---

## 3. KP List — advance snapshot (not live re-query)

### Decision

**KP List is created once at orchestration time and frozen on the campaign instance.**

It is **not** re-derived from KeyPersonDB on every send (ordering/membership would drift).

### Lifecycle

```text
Orchestration
  → query KeyPersonDB for Client with eligibility filters
  → sort into ordered list (tiers + Title)
  → if list empty → drop Client (or drop that product line)
  → persist kp_list_json + kp_list_index=0 on instance / every History row of that instance
  → set History.KeyPerson = list[0] (intended first attempt)

Execution (E1 or any step before a successful lock)
  → send to History.KeyPerson (current list cursor)
  → on Hard Bounce → index++ ; if next exists: update KeyPerson on open Todos + retry/reschedule current step policy
  → if list exhausted → Failed + Cancelled remaining

After first non-Hard-Bounce successful send for the instance
  → lock active_key_person = that KP
  → all later steps of this instance use that KP only
  → Hard Bounce on a later step → may advance list and re-bind active KP for remaining steps
  → Unsubscribe → stop Client (no list advance)
```

### What gets updated on History

| Event | Update |
|-------|--------|
| Orchestration | `kp_list` frozen; relation `KeyPerson` = first candidate |
| Hard Bounce + next KP | `kp_list_index`; `KeyPerson` on **current + future** Todos of instance; Payload note |
| First / new successful deliverable KP | `active_key_person` lock; align future Todos’ `KeyPerson` |
| Human reply / unsubscribe | Cancel Client-wide open Todos; do not change list for retry |

### Why not “dynamic find each time”

- Replay/re-run orchestration would otherwise pick different people mid-flight.
- Bounce handling needs a **stable ordered queue**.
- Audit: “we attempted KP A then B” must be reconstructible from History + Payload.

Eligibility at send time still re-checked (DNC, employment, verified status); failure → skip/switch per bounce rules, not silent send.

---

## 4. KP eligibility & sort

### Eligibility (must all pass)

- `Email` present and parseable
- `Email Verified Status` ∈ {`Verified`, `Icypeas Verified`}
- `Current Employment Confirmed` ≠ `No`
- `Email Do Not Contact` on Client = false (and any KP-level DNC if present)
- Client formula **`Has Verified Email` = true** (at least one KP Verified / Icypeas Verified)
- Enough signal from `Contact Role` and/or `Title` to place in a tier (unmapped → lowest tier or exclude — **default: exclude from list** if neither Role nor Title maps)

### Tier order (1 = first)

Use **Contact Role** when present; else / also score **Title** keywords (case-insensitive). Higher tier wins; within tier: prefer higher `Contact Priority` (P0>P1>P2), then higher `Fit Score`, then stable page id.

| Tier | Contact Role (DB) | Title keyword examples (non-exhaustive, config-driven) |
|------|-------------------|--------------------------------------------------------|
| 1 | `Lifecycle / CRM / Retention`; Marketing-leaning from `Brand / Marketing / Growth` if Title matches marketing/lifecycle/crm/retention | marketing, lifecycle, crm, retention, growth marketing |
| 2 | `Brand / Marketing / Growth`; `DTC / eCommerce / Post-purchase` | brand, growth, operations, GM, general manager, ecommerce, e-commerce, DTC, digital |
| 3 | `Founder / CEO / COO` | founder, CEO, COO, owner, chief executive |
| ASIN boost | `Amazon / Marketplace Channel Owner` → treat as **Tier 1–2 for ASIN instances**; for DTC instances place after Tier 2 or exclude External operators | amazon, marketplace, ASIN |
| | `External Amazon / Marketplace Operator` | Prefer **exclude** for DTC; ASIN = last resort after Tier 3 |

Exact keyword lists live in Campaign config (Notion or code constants) so BD can tune without redeploying sort logic.

---

## 5. Flow cadence (this window)

Business days in window: **9/10, 9/11, 9/14, 9/15, 9/16, 9/17, 9/18** (7 days).

| Product | Steps | Default offsets from instance E1 (business days) | Latest E1 so last step ≤ 9/18 |
|---------|-------|--------------------------------------------------|--------------------------------|
| DTC | E1–E4 | 0,1,2,3 | **9/15** |
| ASIN Plus | E1–E5 | 0,1,2,3,4 | **9/14** |

Templates/subjects follow [Campaign Email + LinkedIN](https://app.notion.com/p/3d59166fd9fd8050922dd0af54e39951) Part 2 (Email only).

Variables: `{{First Name}}`, `{{Brand Name}}`, `{{DTC Christmas Pilot Page}}` / `{{ASIN Plus Christmas Pilot Page}}`, `{{Sender Name}}`.

---

## 6. Notion data model

### Created databases (Phase 1)

| DB | URL | Data source |
|----|-----|-------------|
| **FC3.0-CampaignDB** | https://app.notion.com/p/2a8676251be749a0adf147e4e715f919 | `collection://8bc9ad07-b442-4c2f-a181-7d57f70f90d6` |
| **FC3.0-CampaignHistoryDB** | https://app.notion.com/p/936ba4d62bae46f7875ff8413eef1009 | `collection://3d0cfaf4-8d57-4462-bd98-21c86c98df16` |

Parent: [FridgeChannels V3.0](https://app.notion.com/p/3c99166fd9fd8036af38f57c46d354c1) (sibling to ClientDB / KeyPersonDB).

**Integration access:** share both DBs (and ideally parent page) with Notion integration **MarkAPI** (`ntn_` token in `.env`), otherwise EmalAuto API calls return `object_not_found`.

### 6.1 Campaign DB (new) — config + templates

One DB (or parent + template rows). Minimum properties:

| Property | Type | Notes |
|----------|------|-------|
| Name | title | e.g. `Christmas Pilot 2026 / DTC Email 1` |
| Campaign Key | rich_text/select | e.g. `christmas_pilot_2026` |
| Product Line | select | `DTC` \| `ASIN_Plus` |
| Step Index | number | 1..4 or 1..5 |
| Channel | select | `Email` |
| Subject Template | rich_text | with `{{vars}}` |
| Body Template | rich_text/HTML | with `{{vars}}` |
| Min Gap Business Days | number | default `1` |
| Window Start / End | date | 9/10–9/18 effective |
| Daily Cap Per Mailbox | number | default `50` |
| Active | checkbox | |

Orchestration reads all active template rows for the campaign key.

### 6.2 CampaignHistoryDB (new) — task queue + audit

Sibling of FC2.0-ClientDB / FC2.0-KeyPersonDB. Replaces Interaction LOG for this campaign.

| Property | Type | Notes |
|----------|------|-------|
| Name / Task ID | title | idempotent key string |
| OutReach Status | status | Todo / Sending / Success / Failure / Cancelled |
| Action | select | Send Email (inbound reply rows optional later) |
| Platform / InNOut | select | Email / Out |
| Client | relation | → ClientDB |
| KeyPerson | relation | → KeyPersonDB (current attempt / locked) |
| Template | relation | → Campaign DB template row for this step |
| Product Line | select | DTC / ASIN_Plus |
| Step Index | number | |
| Campaign Key | rich_text | |
| FCAccount | email/text | sticky sender |
| Trigger Time | date | ET window |
| Outreach Subject / Body | rich_text | empty until render or manual fill |
| Payload | rich_text | JSON: kp_list, kp_list_index, active_kp, _graph, bounce, … |
| Completion Time / Result Remark | date / text | |
| Reply Status / Body / Email / Last Reply Time | as today | |

**Idempotency key:** `{campaign_key}:{client_page_id}:{product_line}:{step_index}`.

### 6.3 Client / KP

Use FC2.0-ClientDB + FC2.0-KeyPersonDB; filter ICP Group; no eligible KP → omit.

---

## 7. Orchestrator algorithm (summary)

1. Load Campaign config + templates; mailbox list + cap=50.
2. Query Clients by ICP Group; split into instances (A/B/A&B→2).
3. For each instance build **frozen kp_list**; drop if empty.
4. Sticky-assign `FCAccount` (hash/round-robin with balance).
5. Rolling simulation on business days 9/10–9/18:
   - Reserve capacity for already-placed follow-ups per mailbox-day.
   - Place E1 as early as possible without exceeding cap; ensure last step ≤ 9/18 given min gap 1.
   - If impossible → `at_risk` / skip (do not exceed cap).
6. Bulk-create History rows via **ntn** (Subject/Body empty; Template relation set; KP=list[0]; Payload includes kp_list).

Re-run policy: only create missing idempotent keys; or cancel+rewrite **unsent** Todos for a controlled reshuffle.

---

## 8. Executor algorithm (summary)

1. Poll History: Status=Todo, Trigger≤now, Platform=Email, InNOut=Out, FCAccount set.
2. If Subject **and** Body non-empty → use them; else load Template relation → render both → write back before/after send.
3. Resolve recipient from `KeyPerson.Email`; gate verified / DNC.
4. Send via Graph; mark Success + Payload._graph; or Failure.
5. Match inbound:
   - Hard Bounce → advance kp_list or Fail instance; Cancel remaining if exhausted.
   - Unsubscribe → Cancel **all Client** open email Todos.
   - Human reply → Cancel **all Client** open email Todos.
   - Auto-reply → no cancel.

---

## 9. Implementation phases

| Phase | Work | Exit criteria |
|-------|------|----------------|
| **0** | This spec | Product sign-off |
| **1** | Create Campaign DB + CampaignHistoryDB; ntn write/read; seed templates | Manual row CRUD works |
| **2** | Orchestrator job + load simulation report | `npm run campaign:orchestrate` dry-run report; `--write` samples History |
| **3** | Point poller/send at History; template render; cancel-on-reply/unsub; Hard Bounce KP advance | **Implemented** — poll both DBs; send renders Template; soft≠KP switch; human reply / unsub cancel Client Todos |
| **4** | Full orchestration for production set; monitor caps / Failed / Cancelled | Dry-run capacity report → `--write` History; Trigger Time = ET business hours with per-task jitter (avoid :00/:30) |

### Phase 4 trigger time

- Timezone: `America/New_York`
- Window: weekdays in campaign dates; clock **09:00–16:59 ET**
- Minute: deterministic from Task ID; **never** `:00` or `:30`
- Day placement: still rolling load simulation (sticky mailbox + daily cap)

### Phase 3 runtime flags

```bash
CAMPAIGN_POLL_HISTORY=true
CAMPAIGN_POLL_INTERACTION_LOG=true   # keep IL path during transition
CAMPAIGN_DTC_PILOT_PAGE_URL=https://...
CAMPAIGN_ASIN_PILOT_PAGE_URL=https://...
```

### Phase 2 CLI

```bash
# dry-run (default): schedule only, no History writes
npm run campaign:orchestrate -- --limit=50

# write History Todos
npm run campaign:orchestrate -- --write --limit=5

# MarkAPI must be shared on: CampaignDB, CampaignHistoryDB, **ClientDB**, KeyPersonDB
```

---

## 10. Open implementation knobs (non-blocking)

- Title/Role keyword JSON in Campaign config vs code constant for v1.
- After Hard Bounce on step N with next KP: auto-retry same Trigger day vs next business day (recommend **next business day** to protect sender reputation).
- Whether soft bounce ever retries same KP (recommend: no switch; optional one retry same KP next day — **out of scope unless added**).

---

## 11. Sign-off

| Item | Value |
|------|--------|
| Effective last send day | **2026-09-18 America/New_York** |
| KP List | **Frozen at orchestration; History KP updated on send/bounce/lock** |
| Phase 0 | Ready for Phase 1 after confirmation |
