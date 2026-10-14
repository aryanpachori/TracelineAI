import { inr, pct } from "./format";
import { groupOf } from "./groups";
import type {
  Facility,
  FacilityFit,
  FlowReport,
  MonthPoint,
  Policy,
  RecurringSeries,
  SeriesKind,
  Txn,
} from "./types";

const RAILS = ["UPI", "NACH", "NEFT", "IMPS", "RTGS", "Cash", "Other"] as const;

export function railOf(description: string) {
  const text = description.toUpperCase();
  if (text.includes("UPI/") || text.includes("/UPI") || text.startsWith("UPI-") || text.startsWith("UPI ") || text.includes("@") || text.includes("PHONEPE") || text.includes("GPAY") || text.includes("GOOGLE PAY")) return "UPI";
  if (/^(NACH|ECS|ACH)\b/.test(text)) return "NACH";
  if (text.startsWith("NEFT")) return "NEFT";
  if (text.startsWith("RTGS")) return "RTGS";
  if (text.startsWith("IMPS")) return "IMPS";
  if (text.includes("CASH") || text.includes("ATM")) return "Cash";
  return "Other";
}

export function buildFlows(
  txns: Txn[],
  months: MonthPoint[],
  metrics: {
    months: number;
    medianCashAfterOps: number;
    avgEarned: number;
    bounces6m: number;
    volatility: number;
    obligationRatio: number;
  },
  grade: { letter: "A" | "B" | "C" | "D" | "E"; label: string; points: number },
  policy: Policy,
  businessRates?: [number, number],
  options?: { commitAlreadyInCash?: boolean; receipt?: (txn: Txn) => boolean },
): FlowReport {
  const series = detectSeries(txns, months.map((month) => month.key));
  const rails = detectRails(txns);
  const monthPatterns = detectMonthPatterns(txns, months);
  const upiIn = rails.find((rail) => rail.rail === "UPI")?.inflow ?? 0;
  const isReceipt = options?.receipt ?? ((txn: Txn) => txn.category === "business_in" || txn.category === "salary");
  const earnedCredits = txns.filter((txn) => isReceipt(txn)).reduce((sum, txn) => sum + txn.credit, 0);
  const upiReceipts = txns
    .filter((txn) => isReceipt(txn) && railOf(txn.description) === "UPI")
    .reduce((sum, txn) => sum + txn.credit, 0);
  const upiShare = earnedCredits > 0 ? upiReceipts / earnedCredits : 0;
  const extraCommit = series
    .filter((item) => item.kind === "autopay" || item.kind === "subscription")
    .reduce((sum, item) => sum + item.typical, 0);
  const facilities = buildFacilities({
    series,
    metrics,
    grade,
    policy,
    extraCommit,
    upiShare,
    upiIn,
    monthCount: Math.max(metrics.months, 1),
    businessRates,
    commitAlreadyInCash: options?.commitAlreadyInCash ?? false,
  });
  const reading = writeReading(series, upiShare, extraCommit, facilities, grade);

  return { series, rails, months: monthPatterns, facilities, upiShare, extraCommit, reading };
}

function explicitKind(txn: Txn): SeriesKind | null {
  const text = txn.description.toLowerCase();
  if (txn.category === "emi" || /\bemi\b/.test(text)) return "emi";
  if (/netflix|spotify|hotstar|disney|youtube|google workspace|google one|adobe|microsoft|linkedin|notion|slack|prime video|subscription/.test(text)) {
    return "subscription";
  }
  if (/\b(nach|ecs)\b|\bach[\s/-]|autopay|e-mandate|emandate|\bmandate|standing instruction/.test(text)) {
    return "autopay";
  }
  if (txn.category === "rent") return "standing";
  return null;
}

function detectSeries(txns: Txn[], monthKeys: string[]): RecurringSeries[] {
  const debits = txns.filter(
    (txn) => txn.debit > 0 && txn.category !== "bounce_reversal" && txn.category !== "bounce_charge",
  );
  const byName = new Map<string, Txn[]>();
  debits.forEach((txn) => {
    const name = seriesName(txn);
    const list = byName.get(name) ?? [];
    list.push(txn);
    byName.set(name, list);
  });

  const series: RecurringSeries[] = [];
  byName.forEach((rows, name) => {
    const clusters = clusterByAmount(rows);
    clusters.forEach((cluster) => {
      const kinds = cluster.map((txn) => explicitKind(txn)).filter((kind): kind is SeriesKind => kind != null);
      const kind = pickKind(kinds);
      const amounts = cluster.map((txn) => txn.debit);
      const typical = median(amounts);
      const seen = new Set(cluster.map((txn) => txn.date.slice(0, 7)));
      const variation = typical > 0 ? stdev(amounts) / typical : 0;
      const explicit = kind === "emi" || kind === "autopay" || kind === "subscription" || kind === "standing";
      const habit = cluster.some((txn) => HABIT.has(groupOf(txn).id));
      const dated = daysStable(cluster);
      const repeat =
        !explicit &&
        !habit &&
        dated &&
        seen.size >= 4 &&
        variation <= 0.08 &&
        typical <= 8000 &&
        cluster.every((txn) => txn.category !== "supplier" && txn.category !== "transfer_out" && txn.category !== "personal");
      const resolved: SeriesKind | null = explicit && (kind !== "autopay" || dated || seen.size < 3) ? kind : repeat ? "repeat" : null;
      if (!resolved) return;
      if (seen.size < 2 && resolved !== "emi" && resolved !== "autopay" && resolved !== "subscription") return;
      if (!explicit && seen.size < 4) return;

      const orderedMonths = monthKeys.filter((key) => {
        const first = [...seen].sort()[0];
        const last = [...seen].sort().at(-1) ?? first;
        return key >= first && key <= last;
      });
      const bounced = txns.some(
        (txn) =>
          (txn.category === "bounce_reversal" || txn.category === "bounce_charge") &&
          txn.description.toLowerCase().includes(name.toLowerCase().slice(0, 12)),
      );
      const rails = cluster.map((txn) => railOf(txn.description));
      series.push({
        id: `${resolved}-${slug(name)}-${Math.round(typical)}`,
        name,
        kind: resolved,
        rail: mode(rails),
        typical,
        monthsSeen: seen.size,
        monthsSpan: Math.max(orderedMonths.length, seen.size),
        missed: Math.max(orderedMonths.length - seen.size, 0),
        lastDate: cluster.map((txn) => txn.date).sort().at(-1) ?? "",
        bounced,
        txnIds: cluster.map((txn) => txn.id),
      });
    });
  });

  const order: Record<SeriesKind, number> = { emi: 0, autopay: 1, subscription: 2, standing: 3, repeat: 4 };
  return series.sort((a, b) => order[a.kind] - order[b.kind] || b.typical - a.typical);
}

function seriesName(txn: Txn) {
  if (txn.counterparty && txn.counterparty !== "Unknown") return txn.counterparty;
  if (/atm/i.test(txn.description)) return "ATM";
  return txn.description.split(/[/-]/)[0]?.trim().slice(0, 42) || "Unknown";
}

function pickKind(kinds: SeriesKind[]): SeriesKind | null {
  if (kinds.includes("emi")) return "emi";
  if (kinds.includes("autopay")) return "autopay";
  if (kinds.includes("subscription")) return "subscription";
  if (kinds.includes("standing")) return "standing";
  return null;
}

const HABIT = new Set(["food", "fuel", "shopping", "travel", "healthcare"]);

function daysStable(rows: Txn[]) {
  const days = rows.map((txn) => Number(txn.date.slice(8, 10))).filter((day) => day > 0);
  if (days.length < 2) return true;
  const mid = median(days);
  return days.every((day) => Math.min(Math.abs(day - mid), 31 - Math.abs(day - mid)) <= 3);
}

function clusterByAmount(rows: Txn[]): Txn[][] {
  const sorted = [...rows].sort((a, b) => a.debit - b.debit);
  const clusters: Txn[][] = [];
  sorted.forEach((txn) => {
    const current = clusters.at(-1);
    const anchor = current?.[0]?.debit ?? 0;
    if (!current || Math.abs(txn.debit - anchor) / Math.max(anchor, 1) > 0.1) clusters.push([txn]);
    else current.push(txn);
  });
  return clusters;
}

function detectRails(txns: Txn[]) {
  const map = new Map<string, RailMixSeed>();
  RAILS.forEach((rail) => map.set(rail, { rail, inflow: 0, outflow: 0, inCount: 0, outCount: 0 }));
  txns.forEach((txn) => {
    const rail = map.get(railOf(txn.description));
    if (!rail) return;
    if (txn.credit > 0) {
      rail.inflow += txn.credit;
      rail.inCount += 1;
    }
    if (txn.debit > 0) {
      rail.outflow += txn.debit;
      rail.outCount += 1;
    }
  });
  return [...map.values()].filter((rail) => rail.inflow > 0 || rail.outflow > 0);
}

type RailMixSeed = { rail: string; inflow: number; outflow: number; inCount: number; outCount: number };

function detectMonthPatterns(txns: Txn[], months: MonthPoint[]): FlowReport["months"] {
  return months.map((month) => {
    const rows = txns.filter((txn) => txn.date.startsWith(month.key));
    const sumKind = (kind: SeriesKind) =>
      rows.filter((txn) => txn.debit > 0 && explicitKind(txn) === kind).reduce((total, txn) => total + txn.debit, 0);
    return {
      key: month.key,
      label: month.label,
      inflow: month.totalIn,
      outflow: month.totalOut,
      upiIn: rows.filter((txn) => txn.credit > 0 && railOf(txn.description) === "UPI").reduce((total, txn) => total + txn.credit, 0),
      upiOut: rows.filter((txn) => txn.debit > 0 && railOf(txn.description) === "UPI").reduce((total, txn) => total + txn.debit, 0),
      emi: sumKind("emi"),
      autopay: sumKind("autopay"),
      subscription: sumKind("subscription"),
    };
  });
}

function buildFacilities(input: {
  series: RecurringSeries[];
  metrics: { medianCashAfterOps: number; bounces6m: number; volatility: number; obligationRatio: number };
  grade: { letter: "A" | "B" | "C" | "D" | "E"; label: string; points: number };
  policy: Policy;
  extraCommit: number;
  upiShare: number;
  upiIn: number;
  monthCount: number;
  businessRates?: [number, number];
  commitAlreadyInCash?: boolean;
}): Facility[] {
  const room = Math.max(0, input.metrics.medianCashAfterOps - (input.commitAlreadyInCash ? 0 : input.extraCommit));
  const monthly = room * input.policy.surplusShare;
  const rates =
    input.businessRates ??
    rateBand(input.grade.letter, input.metrics.bounces6m, input.policy.maxBounces6m, input.metrics.volatility);
  const fit = input.commitAlreadyInCash
    ? monthly <= 0
      ? "weak"
      : input.grade.letter === "A" || input.grade.letter === "B"
        ? "strong"
        : "conditional"
    : facilityFit(input.grade.letter, input.metrics.bounces6m > input.policy.maxBounces6m, monthly);
  const business = amountBand(monthly, rates, input.policy.tenureMonths);
  const lineRates: [number, number] = [Math.min(rates[0] + 0.02, 0.3), Math.min(rates[1] + 0.02, 0.34)];
  const line = amountBand(monthly * 0.7, lineRates, 12);
  const emi = input.series.find((item) => item.kind === "emi");
  const emiClean = Boolean(emi && !emi.bounced && emi.monthsSeen / Math.max(emi.monthsSpan, 1) >= 0.75);
  const topupMonthly = emi ? Math.min(monthly, emi.typical * 0.5) : 0;
  const topup = amountBand(topupMonthly, rates, Math.min(input.policy.tenureMonths, 18));
  const upiMonthlyIn = input.upiIn / input.monthCount;
  const upiRates: [number, number] = [Math.min(rates[0] + 0.04, 0.32), Math.min(rates[1] + 0.04, 0.36)];
  const upiAmount = amountBand(monthly, upiRates, 9);
  const upiHigh = Math.min(upiAmount.high, upiMonthlyIn * 1.5);
  const upiLow = Math.min(upiAmount.low, upiHigh);
  const upiFit: FacilityFit =
    fit === "weak" || input.upiShare < 0.1 ? "weak" : input.upiShare >= 0.25 && fit === "strong" ? "strong" : "conditional";

  const businessWhy =
    fit === "strong"
      ? `Cash left covers a new EMI of ${inr(monthly, 0)} after autopays and subscriptions.`
      : fit === "conditional"
        ? `There is room for ${inr(monthly, 0)} a month, with returns or a softer readiness grade to clear first.`
        : "Cash left after commitments does not support a new facility on these terms.";

  return [
    {
      id: "business",
      name: "Unsecured business loan",
      fit,
      amountLow: fit === "weak" ? 0 : business.low,
      amountHigh: fit === "weak" ? 0 : business.high,
      rateLow: rates[0],
      rateHigh: rates[1],
      tenure: `${input.policy.tenureMonths} months`,
      why: businessWhy,
      reading: input.commitAlreadyInCash
        ? `Sized from ${inr(input.metrics.medianCashAfterOps, 0)} left in a typical month after own-account transfers and after spending already on the statement. At ${pct(rates[0])} to ${pct(rates[1])}, the facility is ${inr(business.low, 0)} to ${inr(business.high, 0)} over ${input.policy.tenureMonths} months.`
        : `AI sized this from cash left of ${inr(input.metrics.medianCashAfterOps, 0)}, after ${inr(input.extraCommit, 0)} of autopays and subscriptions. At ${pct(rates[0])} to ${pct(rates[1])}, the facility is ${inr(business.low, 0)} to ${inr(business.high, 0)} over ${input.policy.tenureMonths} months.`,
    },
    {
      id: "line",
      name: "Working capital line",
      fit,
      amountLow: fit === "weak" ? 0 : line.low,
      amountHigh: fit === "weak" ? 0 : line.high,
      rateLow: lineRates[0],
      rateHigh: lineRates[1],
      tenure: "12 months",
      why: "A line drawn against cash left, with interest on the amount used.",
      reading: `AI set this line from the same cash left, kept shorter than a term loan. Interest sits at ${pct(lineRates[0])} to ${pct(lineRates[1])} on what is drawn over 12 months.`,
    },
    {
      id: "upi",
      name: "UPI merchant facility",
      fit: upiFit,
      amountLow: upiFit === "weak" ? 0 : upiLow,
      amountHigh: upiFit === "weak" ? 0 : upiHigh,
      rateLow: upiRates[0],
      rateHigh: upiRates[1],
      tenure: "9 months",
      why:
        input.upiShare >= 0.1
          ? `Mobile payments are ${pct(input.upiShare)} of business receipts, about ${inr(upiMonthlyIn, 0)} a month.`
          : "Mobile payments are a small share of business receipts.",
      reading: `AI separated UPI from NEFT, IMPS, and NACH. A short merchant facility tracks that mobile inflow, at ${pct(upiRates[0])} to ${pct(upiRates[1])} over 9 months.`,
    },
    {
      id: "topup",
      name: "EMI top-up",
      fit: emi && emiClean && fit !== "weak" ? (fit === "strong" ? "strong" : "conditional") : "weak",
      amountLow: emi && emiClean && fit !== "weak" ? topup.low : 0,
      amountHigh: emi && emiClean && fit !== "weak" ? topup.high : 0,
      rateLow: rates[0],
      rateHigh: rates[1],
      tenure: `${Math.min(input.policy.tenureMonths, 18)} months`,
      why: emi
        ? emiClean
          ? `${emi.name} is paid at ${inr(emi.typical, 0)} across ${emi.monthsSeen} months.`
          : `${emi.name} has gaps or a return, so a top-up is a weak fit.`
        : "No EMI mandate was found on the statement.",
      reading: emi
        ? `AI kept the ${emi.name} mandate separate from other autopays. A top-up uses half of that EMI as the new payment, at ${pct(rates[0])} to ${pct(rates[1])}.`
        : "AI did not find a repeating EMI, so a top-up is not available from this statement.",
    },
  ];
}

function facilityFit(letter: "A" | "B" | "C" | "D" | "E", bounceBreach: boolean, monthly: number): FacilityFit {
  if (monthly <= 0 || letter === "D" || letter === "E") return "weak";
  if (letter === "C" || bounceBreach) return "conditional";
  return "strong";
}

function rateBand(
  letter: "A" | "B" | "C" | "D" | "E",
  bounces: number,
  maxBounces: number,
  volatility: number,
): [number, number] {
  if (letter === "D" || letter === "E" || bounces > maxBounces) return [0.24, 0.32];
  if (letter === "C") return [0.24, 0.32];
  if (letter === "A" && bounces === 0 && volatility < 0.25) return [0.16, 0.21];
  return [0.2, 0.26];
}

function amountBand(monthly: number, rates: [number, number], tenure: number) {
  return {
    low: principalFromEmi(monthly, rates[1], tenure),
    high: principalFromEmi(monthly, rates[0], tenure),
  };
}

function principalFromEmi(emi: number, annualRate: number, months: number) {
  if (emi <= 0 || months <= 0) return 0;
  const monthlyRate = annualRate / 12;
  if (monthlyRate === 0) return emi * months;
  const growth = (1 + monthlyRate) ** months;
  return (emi * (growth - 1)) / (monthlyRate * growth);
}

function writeReading(
  series: RecurringSeries[],
  upiShare: number,
  extraCommit: number,
  facilities: Facility[],
  grade: { letter: string; label: string; points: number },
) {
  const count = (kind: SeriesKind) => series.filter((item) => item.kind === kind).length;
  const lead = facilities.find((item) => item.fit === "strong") ?? facilities.find((item) => item.fit === "conditional") ?? facilities[0];
  const option =
    lead.fit === "strong"
      ? `The leading option is ${lead.name.toLowerCase()}.`
      : lead.fit === "conditional"
        ? `The closest option is ${lead.name.toLowerCase()}.`
        : "A new facility is not a fit on this file.";
  return `AI read the narrations and grouped ${count("emi")} EMI mandate${count("emi") === 1 ? "" : "s"}, ${count("autopay")} autopay${count("autopay") === 1 ? "" : "s"}, and ${count("subscription")} subscription${count("subscription") === 1 ? "" : "s"}. Fixed autopays and subscriptions come to ${inr(extraCommit, 0)} a month. Mobile payments are ${pct(upiShare)} of business receipts. Readiness is ${grade.letter}, ${grade.label}. ${option}`;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function mode(values: string[]) {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Other";
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
