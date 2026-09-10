/** Business-day helpers for America/New_York campaign windows. */

const ET = "America/New_York";

export function ymdInTimeZone(date: Date, timeZone = ET): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Parse YYYY-MM-DD as a UTC noon anchor (stable weekday calc with ET calendar). */
export function parseYmd(ymd: string): Date {
  const parts = ymd.split("-").map((x) => Number(x));
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (y == null || m == null || d == null || ![y, m, d].every(Number.isFinite)) {
    throw new Error(`invalid ymd: ${ymd}`);
  }
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

export function addCalendarDaysYmd(ymd: string, days: number): string {
  const dt = parseYmd(ymd);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function isWeekendYmd(ymd: string): boolean {
  const dow = parseYmd(ymd).getUTCDay(); // 0 Sun .. 6 Sat (UTC noon ≈ ET date)
  return dow === 0 || dow === 6;
}

export function isBusinessDayYmd(ymd: string): boolean {
  return !isWeekendYmd(ymd);
}

/** Inclusive list of business days from startYmd through endYmd. */
export function listBusinessDaysInclusive(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  let cur = startYmd;
  while (cur <= endYmd) {
    if (isBusinessDayYmd(cur)) out.push(cur);
    cur = addCalendarDaysYmd(cur, 1);
  }
  return out;
}

/** Add N business days to a YMD (N>=0). N=0 returns start if business, else next business day. */
export function addBusinessDaysYmd(startYmd: string, businessDays: number): string {
  let cur = startYmd;
  if (!isBusinessDayYmd(cur)) {
    while (!isBusinessDayYmd(cur)) cur = addCalendarDaysYmd(cur, 1);
  }
  let left = businessDays;
  while (left > 0) {
    cur = addCalendarDaysYmd(cur, 1);
    if (isBusinessDayYmd(cur)) left -= 1;
  }
  return cur;
}

/** 10:00 America/New_York on the given YMD, as a Date (instant). */
export function etWallTimeToDate(ymd: string, hour = 10, minute = 0): Date {
  // Interpret YMD + time as ET via temporal offset probe
  const guessUtc = new Date(`${ymd}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const asEt = ymdInTimeZone(guessUtc, ET);
  // Adjust if calendar day drifted
  let dt = guessUtc;
  if (asEt !== ymd) {
    const deltaDays = (parseYmd(ymd).getTime() - parseYmd(asEt).getTime()) / 86_400_000;
    dt = new Date(guessUtc.getTime() + deltaDays * 86_400_000);
  }
  // Fine-tune hour in ET
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: ET,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(dt);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const gotYmd = `${String(get("year")).padStart(4, "0")}-${String(get("month")).padStart(2, "0")}-${String(get("day")).padStart(2, "0")}`;
    const gotH = get("hour");
    const gotM = get("minute");
    if (gotYmd === ymd && gotH === hour && gotM === minute) break;
    const dayDelta = (parseYmd(ymd).getTime() - parseYmd(gotYmd).getTime()) / 86_400_000;
    const minuteDelta = hour * 60 + minute - (gotH * 60 + gotM);
    dt = new Date(dt.getTime() + dayDelta * 86_400_000 + minuteDelta * 60_000);
  }
  return dt;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic ET wall-clock inside business hours, avoiding :00 and :30.
 * Default window: 09:00–16:59 America/New_York (last send minute in the 4pm hour).
 */
export function pickEtBusinessSendTime(
  seed: string,
  opts?: { startHourEt?: number; endHourEtExclusive?: number },
): { hour: number; minute: number } {
  const startHour = opts?.startHourEt ?? 9;
  const endHourExclusive = opts?.endHourEtExclusive ?? 17;
  if (endHourExclusive <= startHour) {
    throw new Error(`invalid ET business hours ${startHour}..${endHourExclusive}`);
  }
  const h = hashSeed(seed);
  const hourSpan = endHourExclusive - startHour;
  const hour = startHour + (h % hourSpan);
  const minuteChoices: number[] = [];
  for (let m = 1; m <= 59; m += 1) {
    if (m === 30) continue;
    minuteChoices.push(m);
  }
  const minute = minuteChoices[(h >>> 10) % minuteChoices.length]!;
  return { hour, minute };
}
