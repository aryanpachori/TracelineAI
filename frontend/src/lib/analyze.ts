import { readCharacter } from "./character";
import { categorize, counterparty } from "./categorize";
import { buildCreditSignals, creditSignalReasons, LOAN_APP } from "./credit-signals";
import { buildFlows } from "./flows";
import { buildGroups, groupOf } from "./groups";
import { datasetRate, inr, monthKey, monthLabel, prettyDate, yearsLabel } from "./format";
import type {
  AiReading,
  Analysis,
  Category,
  FlowReport,
  IntegrityCheck,
  MonthPoint,
  Policy,
  Preview,
  Reason,
  BackendMetrics,
  Judgment,
  RuleHit,
  Txn,
  TxnInput,
} from "./types";

const KNOWN: Category[] = [
  "business_in",
  "salary",
  "transfer_in",
  "loan_in",
  "self_in",
  "cash_in",
  "emi",
  "rent",
  "supplier",
  "utilities",
  "tax",
  "bounce_reversal",
  "bounce_charge",
  "cash_out",
  "personal",
  "self_out",
  "transfer_out",
  "other_in",
  "other_out",
];

const EARNED: Category[] = ["business_in", "salary"];

export function analyze(
  inputs: TxnInput[],
  policy: Policy,
  reading?: AiReading | null,
  judgment?: Judgment | null,
  backendMetrics?: BackendMetrics | null,
): Analysis {
  const txns = tag(inputs);
  applyJudgment(txns, judgment);
  const built = buildMonths(txns);
  const cash = buildCashflow(txns, built, policy);
  const months =
    cash.mode === "cashflow"
      ? built.map((month) => {
          const row = cash.byMonth.get(month.key) ?? { work: 0, spent: 0 };
          const left = row.work - row.spent;
          return { ...month, earned: row.work, cashAfterOps: left, surplusAfterObligations: left };
        })
      : built;
  const base = buildMetrics(txns, months);
  const habits = spendHabits(txns, months, cash.mode === "cashflow", policy.surplusShare);
  const metrics = {
    ...(cash.mode === "cashflow"
      ? { ...base, topShare: cash.topShare, topName: cash.topName, nonEarnedShare: cash.asideShare }
      : base),
    obligationRatio: habits.burdenRatio,
  };
  const integrity = buildIntegrity(txns, metrics.months, policy.minMonths, judgment ? judgment.missingMonths : null);
  const local = score(metrics, integrity, policy);
  const grade = cash.mode === "cashflow" ? local : applyReading(local, reading);
  const counterparties = cash.mode === "cashflow" ? cash.payers : buildCounterparties(txns);
  const outflowMix = buildOutflows(months);
  const uncategorizedShare = shareOf(
    txns.filter((txn) => txn.category === "other_in" || txn.category === "other_out"),
    txns,
  );
  const payability = {
    mode: cash.mode,
    workIn: cash.workIn,
    workAvg: cash.workAvg,
    spent: cash.spent,
    spentAvg: cash.spentAvg,
    left: cash.left,
    moved: cash.moved,
  };

  const flows = buildFlows(
    txns,
    months,
    metrics,
    grade,
    policy,
    cash.mode === "cashflow" ? undefined : reading?.rates.business,
    cash.mode === "cashflow" ? { commitAlreadyInCash: true, receipt: (txn) => cash.workIds.has(txn.id) } : undefined,
  );
  const groups = buildGroups(txns, months);
  const binding = judgment?.bindingMonth ? months.find((month) => month.key === judgment.bindingMonth) ?? null : null;
  const capacity = buildCapacity(metrics, policy, flows.extraCommit, habits, binding);
  const creditSignals = buildCreditSignals({
    txns,
    months,
    avgEarned: metrics.avgEarned,
    monthlyDebt: metrics.obligationRatio * Math.max(metrics.avgEarned, 0),
    proposedEmi: capacity.monthly,
    policy,
    flows,
    debtIds: habits.burdenIds,
  });
  const graded = applyCreditHits(grade, creditSignals);
  const reasons = rankReasons([
    ...buildReasons(txns, months, metrics, policy, integrity, flows, payability, habits, judgment),
    ...creditSignalReasons(creditSignals),
  ]);
  const summary =
    cash.mode === "cashflow" || !reading?.summary
      ? writeSummary(metrics, capacity, graded, policy, payability)
      : reading.summary;
  const capable = capacity.monthly > 0 && capacity.principal > 0;
  const character = readCharacter(months, groups, capable, {
    bounces: metrics.bounces6m,
    bounceCap: policy.maxBounces6m,
    obligationRatio: metrics.obligationRatio,
    conduct: judgment?.conduct,
    judgment,
    backendMetrics,
    policyMaxObligation: policy.maxObligationRatio,
    reasons,
    creditSignals,
  });

  return {
    txns,
    months,
    periodLabel: months.length
      ? `${prettyDate(txns[0].date)} – ${prettyDate(txns[txns.length - 1].date)}`
      : "No period",
    start: txns[0]?.date ?? "",
    end: txns[txns.length - 1]?.date ?? "",
    metrics,
    capacity,
    payability,
    grade: graded,
    reasons,
    integrity,
    counterparties,
    outflowMix,
    summary,
    dataConfidence: confidence(txns, integrity, metrics.months),
    uncategorizedShare,
    flows,
    groups,
    character,
    creditSignals,
    backendMetrics: backendMetrics ?? null,
  };
}

export function toPreview(analysis: Analysis): Preview {
  return {
    grade: analysis.grade.letter,
    gradeLabel: analysis.grade.label,
    points: analysis.grade.points,
    capacity: analysis.capacity.monthly,
    bandLow: analysis.capacity.bandLow,
    bandHigh: analysis.capacity.bandHigh,
    avgInflow: analysis.metrics.avgEarned,
    cashAfterOps: analysis.metrics.medianCashAfterOps,
    bounces: analysis.metrics.bounces6m,
    obligationRatio: analysis.metrics.obligationRatio,
    period: analysis.periodLabel,
    summary: analysis.summary,
    topName: analysis.metrics.topName,
    topShare: analysis.metrics.topShare,
  };
}

function applyJudgment(txns: Txn[], judgment?: Judgment | null) {
  if (!judgment) return;
  const partyOf = new Map<string, string>();
  judgment.parties.forEach((party) => {
    party.keys.forEach((key) => partyOf.set(key, party.name));
  });
  const aside = new Set(judgment.asideKeys);
  const debt = new Set(judgment.obligationKeys);
  const self = new Set(judgment.selfKeys || []);
  const people = new Set(judgment.peopleKeys || []);
  const asset = new Set(judgment.investingKeys);
  txns.forEach((txn) => {
    if (!txn.key) return;
    const name = partyOf.get(txn.key);
    if (name) txn.counterparty = name;
    if (aside.has(txn.key) && txn.credit > 0) txn.category = "self_in";
    if (self.has(txn.key) && txn.debit > 0) txn.category = "self_out";
    if (self.has(txn.key) && txn.credit > 0) txn.category = "self_in";
    if (people.has(txn.key) && txn.debit > 0) txn.category = "transfer_out";
    if (people.has(txn.key) && txn.credit > 0) txn.category = "transfer_in";
    // Debt only — never map self/people into EMI burden.
    if (debt.has(txn.key) && txn.debit > 0 && !self.has(txn.key) && !people.has(txn.key)) txn.category = "emi";
    if (asset.has(txn.key) && txn.debit > 0) txn.category = "other_out";
  });
}

function tag(inputs: TxnInput[]): Txn[] {
  return [...inputs]
    .map((txn, index) => ({ txn, index }))
    .sort((a, b) => a.txn.date.localeCompare(b.txn.date) || a.index - b.index)
    .map(({ txn }, index) => ({
      ...txn,
      id: `t${index + 1}`,
      category: txn.category && KNOWN.includes(txn.category) ? txn.category : categorize(txn),
      counterparty: counterparty(txn.description),
    }));
}

function applyReading(
  grade: Analysis["grade"],
  reading?: AiReading | null,
): Analysis["grade"] {
  if (!reading) return grade;
  const letter = KNOWN_LETTERS.has(reading.letter) ? reading.letter : grade.letter;
  return {
    ...grade,
    letter,
    points: Number.isFinite(reading.points) ? reading.points : grade.points,
    label: reading.label || grade.label,
  };
}

const KNOWN_LETTERS = new Set<Analysis["grade"]["letter"]>(["A", "B", "C", "D", "E"]);

function emptyMonth(key: string): MonthPoint {
  return {
    key,
    label: monthLabel(key),
    earned: 0,
    businessCredits: 0,
    cashIn: 0,
    loanIn: 0,
    selfAndTransferIn: 0,
    otherIn: 0,
    reversals: 0,
    emi: 0,
    rent: 0,
    suppliers: 0,
    utilitiesTax: 0,
    bounceCount: 0,
    bounceCharges: 0,
    drawings: 0,
    obligations: 0,
    operating: 0,
    surplusAfterObligations: 0,
    cashAfterOps: 0,
    totalIn: 0,
    totalOut: 0,
  };
}

function buildMonths(txns: Txn[]) {
  const map = new Map<string, MonthPoint>();
  txns.forEach((txn) => {
    const key = monthKey(txn.date);
    const month = map.get(key) ?? emptyMonth(key);
    month.totalIn += txn.credit;
    month.totalOut += txn.debit;

    switch (txn.category) {
      case "business_in":
      case "salary":
        month.businessCredits += txn.credit;
        break;
      case "cash_in":
        month.cashIn += txn.credit;
        break;
      case "loan_in":
        month.loanIn += txn.credit;
        break;
      case "self_in":
      case "transfer_in":
        month.selfAndTransferIn += txn.credit;
        break;
      case "other_in":
        month.otherIn += txn.credit;
        break;
      case "bounce_reversal":
        month.reversals += txn.debit || txn.credit;
        if (txn.debit > 0) month.bounceCount += 1;
        break;
      case "bounce_charge":
        month.bounceCharges += txn.debit;
        break;
      case "emi":
        month.emi += txn.debit;
        break;
      case "rent":
        month.rent += txn.debit;
        break;
      case "supplier":
        month.suppliers += txn.debit;
        break;
      case "utilities":
      case "tax":
        month.utilitiesTax += txn.debit;
        break;
      case "personal":
      case "cash_out":
      case "self_out":
      case "transfer_out":
        month.drawings += txn.debit;
        break;
      default:
        if (txn.debit > 0) month.drawings += txn.debit;
        break;
    }
    map.set(key, month);
  });

  return [...map.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((month) => {
      const earned = month.businessCredits - month.reversals;
      const obligations = month.emi + month.rent;
      const operating = month.suppliers + month.utilitiesTax + month.bounceCharges;
      return {
        ...month,
        earned,
        obligations,
        operating,
        surplusAfterObligations: earned - obligations,
        cashAfterOps: earned - obligations - operating,
      };
    });
}

function buildMetrics(txns: Txn[], months: MonthPoint[]) {
  const earned = months.map((month) => month.earned);
  const avgEarned = mean(earned);
  const medianEarned = median(earned);
  const medianSurplus = median(months.map((month) => month.surplusAfterObligations));
  const medianCashAfterOps = median(months.map((month) => month.cashAfterOps));
  const avgObligations = mean(months.map((month) => month.obligations));
  const obligationRatio = avgEarned > 0 ? avgObligations / avgEarned : 0;
  const volatility = avgEarned > 0 ? stdev(earned) / avgEarned : 0;
  const end = txns[txns.length - 1]?.date ?? "";
  const bounces6m = txns.filter(
    (txn) => txn.category === "bounce_reversal" && txn.debit > 0 && withinMonths(txn.date, end, 6),
  ).length;
  const bounceCharges = sum(months.map((month) => month.bounceCharges));
  const totalEarned = sum(earned);
  const totalCredits = sum(months.map((month) => month.totalIn));
  const nonEarnedShare = totalCredits > 0 ? (totalCredits - sum(months.map((month) => month.businessCredits))) / totalCredits : 0;
  const counterparties = buildCounterparties(txns);
  const recent = months.slice(-3);
  const prior = months.slice(-6, -3);
  const trend = mean(prior.map((month) => month.earned)) > 0
    ? mean(recent.map((month) => month.earned)) / mean(prior.map((month) => month.earned)) - 1
    : 0;

  return {
    months: months.length,
    avgEarned,
    medianEarned,
    medianSurplus,
    medianCashAfterOps,
    obligationRatio,
    volatility,
    bounces6m,
    bounceCharges,
    topShare: counterparties[0]?.share ?? 0,
    topName: counterparties[0]?.name ?? "—",
    nonEarnedShare,
    trend,
    drawingsAvg: mean(months.map((month) => month.drawings)),
    totalEarned,
    totalCredits,
  };
}

const SWEEP_DEBITS = new Set<Category>(["transfer_out", "self_out", "cash_out"]);
const INVEST = /zerodha|groww|upstox|nse clearing|bse limited|mutual fund|\bmfss\b|nseclg/i;
const INTEREST = /\bint\.?\s*pd\b|interest paid|interest credit/i;

type Cashflow = {
  mode: "formal" | "cashflow";
  workIn: number;
  workAvg: number;
  spent: number;
  spentAvg: number;
  left: number;
  moved: number;
  topName: string;
  topShare: number;
  asideShare: number;
  payers: Analysis["counterparties"];
  workIds: Set<string>;
  byMonth: Map<string, { work: number; spent: number }>;
};

function buildCashflow(txns: Txn[], months: MonthPoint[], policy: Policy): Cashflow {
  const formalAvg = mean(months.map((month) => month.earned));
  const mode: Cashflow["mode"] = formalAvg >= policy.minAvgInflow * 0.5 ? "formal" : "cashflow";
  const internal = markInternal(txns);
  const workIds = new Set<string>();
  const byMonth = new Map<string, { work: number; spent: number }>();
  months.forEach((month) => byMonth.set(month.key, { work: 0, spent: 0 }));
  txns.forEach((txn) => {
    const slot = byMonth.get(monthKey(txn.date));
    if (!slot) return;
    if (isWork(txn, internal)) {
      workIds.add(txn.id);
      slot.work += txn.credit;
    }
    if (isSpend(txn, internal)) slot.spent += txn.debit;
  });
  const rows = [...byMonth.values()];
  const payers = payersFrom(txns, workIds);
  const totalCredits = txns.reduce((total, txn) => total + txn.credit, 0);
  const moved = txns.reduce((total, txn) => total + (internal.has(txn.id) && txn.credit > 0 ? txn.credit : 0), 0);
  return {
    mode,
    workIn: median(rows.map((row) => row.work)),
    workAvg: mean(rows.map((row) => row.work)),
    spent: median(rows.map((row) => row.spent)),
    spentAvg: mean(rows.map((row) => row.spent)),
    left: median(rows.map((row) => row.work - row.spent)),
    moved,
    topName: payers[0]?.name ?? "—",
    topShare: payers[0]?.share ?? 0,
    asideShare: totalCredits > 0 ? moved / totalCredits : 0,
    payers: payers.slice(0, 6),
    workIds,
    byMonth,
  };
}

function markInternal(txns: Txn[]) {
  const internal = new Set<string>();
  txns.forEach((txn) => {
    if (txn.category === "self_in" || txn.category === "self_out") internal.add(txn.id);
  });
  const used = new Set<string>();
  const credits = txns
    .filter((txn) => txn.credit >= 2000 && !internal.has(txn.id))
    .sort((a, b) => b.credit - a.credit);
  for (const credit of credits) {
    const day = dayStamp(credit.date);
    let best: Txn | null = null;
    let bestDiff = Infinity;
    for (const debit of txns) {
      if (debit.debit < 2000 || used.has(debit.id) || internal.has(debit.id)) continue;
      if (!SWEEP_DEBITS.has(debit.category)) continue;
      if (Math.abs(dayStamp(debit.date) - day) > 3) continue;
      const diff = Math.abs(credit.credit - debit.debit);
      if (diff <= Math.max(80, credit.credit * 0.02) && diff < bestDiff) {
        best = debit;
        bestDiff = diff;
      }
    }
    if (!best) continue;
    internal.add(credit.id);
    internal.add(best.id);
    used.add(best.id);
  }
  const holders = new Set<string>();
  txns.forEach((txn) => {
    if (!internal.has(txn.id) || txn.credit <= 0) return;
    const key = nameKey(txn.counterparty);
    if (key.length >= 5) holders.add(key);
  });
  txns.forEach((txn) => {
    if (txn.credit <= 0 || internal.has(txn.id)) return;
    const key = nameKey(txn.counterparty);
    if (key.length < 5) return;
    for (const holder of holders) {
      const shorter = Math.min(holder.length, key.length);
      if (holder === key || (shorter >= 6 && (holder.startsWith(key) || key.startsWith(holder)))) {
        internal.add(txn.id);
        break;
      }
    }
  });
  return internal;
}

function isWork(txn: Txn, internal: Set<string>) {
  if (txn.credit <= 0 || internal.has(txn.id)) return false;
  if (txn.category === "loan_in" || txn.category === "self_in" || txn.category === "bounce_reversal" || txn.category === "other_in") {
    return false;
  }
  const group = groupOf(txn).id;
  if (group === "investments_in" || group === "interest") return false;
  if (INVEST.test(txn.description) || INTEREST.test(txn.description)) return false;
  return txn.category === "business_in" || txn.category === "salary" || txn.category === "transfer_in" || txn.category === "cash_in";
}

function isSpend(txn: Txn, internal: Set<string>) {
  if (txn.debit <= 0 || internal.has(txn.id)) return false;
  if (txn.category === "self_out" || txn.category === "bounce_reversal") return false;
  return true;
}

function payersFrom(txns: Txn[], workIds: Set<string>) {
  const map = new Map<string, { amount: number; count: number }>();
  txns.forEach((txn) => {
    if (!workIds.has(txn.id)) return;
    const current = map.get(txn.counterparty) ?? { amount: 0, count: 0 };
    current.amount += txn.credit;
    current.count += 1;
    map.set(txn.counterparty, current);
  });
  const gross = [...map.values()].reduce((total, value) => total + value.amount, 0);
  return [...map.entries()]
    .map(([name, value]) => ({
      name,
      amount: value.amount,
      count: value.count,
      share: gross > 0 ? value.amount / gross : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

function nameKey(name: string) {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

function dayStamp(iso: string) {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : Math.floor(time / 86_400_000);
}

const BASIC_GROUPS = new Set(["rent", "food", "fuel", "utilities", "tax", "healthcare", "insurance", "suppliers"]);
const LIFESTYLE_GROUPS = new Set(["shopping", "travel", "subscriptions", "cards"]);
const UNCOVERED_GROUPS = new Set(["shopping", "travel", "cards"]);
const LENDER = LOAN_APP;
const SKIP_PAYER = new Set(["unknown", "interest", "cash deposit", "atm"]);

type SpendHabits = {
  cashflow: boolean;
  burdenRatio: number;
  burdenIds: string[];
  lifestyleShare: number;
  judged: boolean;
  uncoveredMonthly: number;
  pledge: number;
  factor: number;
  lifestyleIds: string[];
  basicIds: string[];
  repeatIds: string[];
  cashShare: number;
  cashIds: string[];
};

function spendHabits(txns: Txn[], months: MonthPoint[], cashflow: boolean, surplusShare: number): SpendHabits {
  const incomeBase = months.reduce((sum, month) => sum + month.earned, 0);
  const burdenIds: string[] = [];
  let burden = 0;
  let basics = 0;
  let lifestyle = 0;
  let uncovered = 0;
  const lifestyleIds: string[] = [];
  const basicIds: string[] = [];
  let cashOut = 0;
  const cashIds: string[] = [];
  let totalOut = 0;

  txns.forEach((txn) => {
    if (txn.debit <= 0) return;
    totalOut += txn.debit;
    const group = groupOf(txn);
    const lender = LENDER.test(txn.description) && group.id !== "food" && group.id !== "subscriptions" && group.id !== "utilities";
    const debt = group.id === "emi" || group.id === "rent" || group.id === "cards" || txn.category === "emi" || txn.category === "rent" || lender;
    if (debt) {
      burden += txn.debit;
      burdenIds.push(txn.id);
    }
    if (BASIC_GROUPS.has(group.id)) {
      basics += txn.debit;
      basicIds.push(txn.id);
    }
    if (LIFESTYLE_GROUPS.has(group.id)) {
      lifestyle += txn.debit;
      lifestyleIds.push(txn.id);
    }
    const alreadyInCashLeft = txn.category === "supplier" || txn.category === "utilities" || txn.category === "tax" || txn.category === "emi" || txn.category === "rent" || txn.category === "bounce_charge";
    if (UNCOVERED_GROUPS.has(group.id) && !alreadyInCashLeft) uncovered += txn.debit;
    if (group.id === "cash") {
      cashOut += txn.debit;
      cashIds.push(txn.id);
    }
  });

  const judgedTotal = basics + lifestyle;
  const judged = judgedTotal >= 2000;
  const lifestyleShare = judged ? lifestyle / judgedTotal : 0;
  const burdenRatio = incomeBase > 0 ? burden / incomeBase : burden > 0 ? 1 : 0;
  let lifestyleFactor = 1;
  if (judged && lifestyleShare >= 0.55) lifestyleFactor = 0.6;
  else if (judged && lifestyleShare >= 0.35) lifestyleFactor = 0.75;
  else if (judged && lifestyleShare >= 0.2) lifestyleFactor = 0.9;
  let debtFactor = 1;
  if (burdenRatio >= 0.45) debtFactor = 0.6;
  else if (burdenRatio >= 0.3) debtFactor = 0.8;
  const factor = Math.max(0.35, lifestyleFactor * debtFactor);
  const payers = new Map<string, { months: Set<string>; amount: number; ids: string[] }>();
  txns.forEach((txn) => {
    if (txn.credit <= 0) return;
    if (txn.category === "self_in" || txn.category === "loan_in" || txn.category === "bounce_reversal") return;
    const name = txn.counterparty.trim();
    if (!name || SKIP_PAYER.has(name.toLowerCase())) return;
    const slot = payers.get(name) ?? { months: new Set<string>(), amount: 0, ids: [] };
    slot.months.add(txn.date.slice(0, 7));
    slot.amount += txn.credit;
    slot.ids.push(txn.id);
    payers.set(name, slot);
  });
  const repeatIds: string[] = [];
  payers.forEach((slot) => {
    if (slot.months.size >= 2 && slot.amount >= 2000) repeatIds.push(...slot.ids);
  });

  return {
    cashflow,
    burdenRatio,
    burdenIds,
    lifestyleShare,
    judged,
    uncoveredMonthly: uncovered / Math.max(months.length, 1),
    pledge: surplusShare * factor,
    factor,
    lifestyleIds,
    basicIds,
    repeatIds,
    cashShare: totalOut > 0 ? cashOut / totalOut : 0,
    cashIds,
  };
}

function pushHabitFlags(reasons: Reason[], habits: SpendHabits, policy: Policy) {
  if (habits.judged && habits.lifestyleShare < 0.2) {
    reasons.push({
      code: "HABIT_BASICS",
      severity: "good",
      title: "Spending stays on basics",
      detail: habits.cashflow
        ? "Rent, food, fuel, utilities, and suppliers are the spending. Flows are modest, and the new EMI is not cut for lifestyle."
        : "Rent, food, fuel, utilities, and suppliers are the spending. The new EMI is not cut for lifestyle.",
      txnIds: habits.basicIds,
    });
  }
  if (habits.burdenIds.length > 0 && habits.burdenRatio <= 0.2) {
    reasons.push({
      code: "HABIT_DEBT_OK",
      severity: "good",
      title: "Existing debts fit this cashflow",
      detail: `EMI, rent, card payments, and pay-later are ${Math.round(habits.burdenRatio * 100)}% of inflows.`,
      txnIds: habits.burdenIds,
    });
  }
  if (habits.judged && habits.lifestyleShare >= 0.35) {
    reasons.push({
      code: "HABIT_LIFESTYLE",
      severity: "breach",
      title: "Spending leans to shopping and lifestyle",
      detail: `Shopping, travel, subscriptions, and cards are ${Math.round(habits.lifestyleShare * 100)}% of judged spending. The new EMI uses ${Math.round(habits.pledge * 100)}% of cash left instead of ${Math.round(policy.surplusShare * 100)}%.`,
      txnIds: habits.lifestyleIds,
    });
  }
  if (habits.burdenRatio >= 0.3) {
    reasons.push({
      code: "HABIT_DEBT",
      severity: "breach",
      title: "Debts are heavy for this cashflow",
      detail: `EMI, rent, card payments, and pay-later are ${Math.round(habits.burdenRatio * 100)}% of inflows. The facility is cut because those instalments already strain the account.`,
      txnIds: habits.burdenIds,
    });
  }
  if (habits.cashShare >= 0.3) {
    reasons.push({
      code: "HABIT_CASH",
      severity: "watch",
      title: "A large share leaves as cash",
      detail: "ATM withdrawals are at least 30% of outflow, so the spending mix is only partly visible.",
      txnIds: habits.cashIds,
    });
  }
  if (habits.repeatIds.length > 0) {
    reasons.push({
      code: "HABIT_REPEAT",
      severity: "good",
      title: "Receipts from the same names repeat",
      detail: habits.cashflow
        ? "The same payer shows up in two or more months. That stands in for a salary line."
        : "The same payer shows up in two or more months.",
      txnIds: habits.repeatIds,
    });
  }
}

function buildCapacity(
  metrics: Analysis["metrics"],
  policy: Policy,
  extraCommit: number,
  habits: SpendHabits,
  binding?: MonthPoint | null,
) {
  const lifestyleOff = habits.cashflow ? 0 : habits.uncoveredMonthly;
  const cashLeft = binding ? binding.cashAfterOps : metrics.medianCashAfterOps;
  const room = Math.max(0, cashLeft - (habits.cashflow ? 0 : extraCommit) - lifestyleOff);
  const monthly = room * habits.pledge;
  const principal = principalFromEmi(monthly, policy.annualRate, policy.tenureMonths);
  const viable = room > 0 && (habits.cashflow || metrics.avgEarned >= policy.minAvgInflow * 0.5);
  const lead = binding
    ? `The model sized the EMI from ${binding.label}, the month it read as the constraint on this account. Cash left in that month is the base, after the rows it set aside.`
    : habits.cashflow
    ? "There is no salary on this file. The EMI is a share of the cash left in a typical month after own-account transfers are removed and after the spending already on the statement."
    : "Capacity is a share of cash left after EMI, rent, suppliers, utilities, tax, and return charges, with autopays and subscriptions taken off. The band is the loan that payment would carry at the rate and tenure below.";
  const cuts: string[] = [];
  if (lifestyleOff > 0) {
    cuts.push(`Shopping, travel, and card bills of ${inr(lifestyleOff, 0)} a month come off cash left before the EMI is sized.`);
  }
  if (habits.factor < 0.999) {
    cuts.push(`The new EMI uses ${Math.round(habits.pledge * 100)}% of cash left instead of ${Math.round(policy.surplusShare * 100)}%.`);
  }
  return {
    monthly: viable ? monthly : 0,
    principal: viable ? principal : 0,
    bandLow: viable ? principal * 0.75 : 0,
    bandHigh: viable ? principal : 0,
    basis: cuts.length ? `${lead} ${cuts.join(" ")}` : lead,
  };
}

function principalFromEmi(emi: number, annualRate: number, months: number) {
  if (emi <= 0 || months <= 0) return 0;
  const r = annualRate / 12;
  if (r === 0) return emi * months;
  const growth = (1 + r) ** months;
  return emi * ((growth - 1) / (r * growth));
}

function score(metrics: Analysis["metrics"], integrity: IntegrityCheck[], policy: Policy) {
  const rules: RuleHit[] = [];
  const add = (id: string, label: string, hit: boolean, delta: number, note: string) => {
    rules.push({ id, label, hit, delta: hit ? delta : 0, note });
  };

  add(
    "history",
    `At least ${policy.minMonths} months`,
    metrics.months < policy.minMonths,
    -20,
    `${metrics.months} months on file`,
  );
  add(
    "inflow",
    `Average earned inflow ≥ ${policy.minAvgInflow}`,
    metrics.avgEarned < policy.minAvgInflow,
    -15,
    "Compared with the inflow minimum",
  );
  const ratioGap = metrics.obligationRatio - policy.maxObligationRatio;
  add(
    "obligations",
    `Fixed debts within ${Math.round(policy.maxObligationRatio * 100)}% of inflows`,
    metrics.obligationRatio > policy.maxObligationRatio,
    -22,
    `${Math.round(metrics.obligationRatio * 100)}% now. Counts EMI, rent, card payments, and pay-later.`,
  );
  if (ratioGap <= 0 && ratioGap > -0.05 && metrics.obligationRatio > 0) {
    rules.push({
      id: "obligations-near",
      label: "Obligation ratio near the cap",
      hit: true,
      delta: -6,
      note: "Inside the limit, with little room",
    });
  }
  add(
    "bounces",
    `Returned instruments in 6 months ≤ ${policy.maxBounces6m}`,
    metrics.bounces6m > policy.maxBounces6m,
    -20,
    `${metrics.bounces6m} in the last six months`,
  );
  if (metrics.bounces6m > 0 && metrics.bounces6m <= policy.maxBounces6m) {
    rules.push({
      id: "bounces-watch",
      label: "Bounces present, inside the limit",
      hit: true,
      delta: -6,
      note: "Allowed, still visible to the analyst",
    });
  }
  add(
    "concentration",
    `Largest payer ≤ ${Math.round(policy.maxConcentration * 100)}%`,
    metrics.topShare > policy.maxConcentration,
    -14,
    metrics.topName,
  );
  add("volatility", "Inflow volatility under 0.45", metrics.volatility > 0.45, -12, `Coefficient ${metrics.volatility.toFixed(2)}`);
  if (metrics.volatility > 0.3 && metrics.volatility <= 0.45) {
    rules.push({
      id: "volatility-watch",
      label: "Moderate inflow volatility",
      hit: true,
      delta: -5,
      note: `Coefficient ${metrics.volatility.toFixed(2)}`,
    });
  }
  add("trend", "Recent inflow not down more than 20%", metrics.trend < -0.2, -14, "Last 3 months versus the prior 3");
  if (metrics.trend < -0.1 && metrics.trend >= -0.2) {
    rules.push({
      id: "trend-watch",
      label: "Recent inflow softer",
      hit: true,
      delta: -6,
      note: "Last 3 months versus the prior 3",
    });
  }
  add(
    "surplus",
    "Cash left after operations is positive",
    metrics.medianCashAfterOps <= 0,
    -30,
    "Median month",
  );
  add(
    "integrity",
    "Balance continuity holds",
    integrity.some((check) => check.id === "balance" && check.status === "fail"),
    -25,
    "Running balance versus the statement",
  );
  add(
    "nonearned",
    "Non-business credits under 25% of all credits",
    metrics.nonEarnedShare > 0.25,
    -8,
    "Loans, self-transfers, cash deposits and other credits",
  );

  const points = clamp(Math.round(rules.reduce((sum, rule) => sum + rule.delta, 100)), 0, 100);
  return { letter: letterFor(points), points, label: labelFor(points), rules };
}

function letterFor(points: number): Analysis["grade"]["letter"] {
  if (points >= 85) return "A";
  if (points >= 70) return "B";
  if (points >= 55) return "C";
  if (points >= 40) return "D";
  return "E";
}

function labelFor(points: number) {
  if (points >= 85) return "Clear";
  if (points >= 70) return "Acceptable";
  if (points >= 55) return "Watch";
  if (points >= 40) return "Weak";
  return "Thin";
}

const DISCRETIONARY = new Set(["food", "shopping", "travel", "subscriptions", "shops", "fuel", "cards", "people", "cash", "healthcare", "other"]);

function pushSpendFlags(reasons: Reason[], txns: Txn[]) {
  const keys = closedMonthKeys(txns);
  if (keys.length < 2) return;
  const byMonth = new Map<string, Map<string, { name: string; amount: number; ids: string[] }>>();
  txns.forEach((txn) => {
    if (txn.debit <= 0) return;
    const group = groupOf(txn);
    if (group.side !== "out" || !DISCRETIONARY.has(group.id)) return;
    const key = monthKey(txn.date);
    const month = byMonth.get(key) ?? new Map();
    const current = month.get(group.id) ?? { name: group.name, amount: 0, ids: [] as string[] };
    current.amount += txn.debit;
    current.ids.push(txn.id);
    month.set(group.id, current);
    byMonth.set(key, month);
  });

  const last = byMonth.get(keys[keys.length - 1]) ?? new Map();
  const prev = byMonth.get(keys[keys.length - 2]) ?? new Map();
  let jump: { name: string; delta: number; change: number; ids: string[] } | null = null;
  for (const [id, row] of last) {
    const before = prev.get(id)?.amount ?? 0;
    const delta = row.amount - before;
    if (before <= 0 || delta < 5000 || delta / before < 0.2) continue;
    if (!jump || delta > jump.delta) jump = { name: row.name, delta, change: delta / before, ids: row.ids };
  }
  if (jump) {
    const amounts = txns.filter((txn) => jump.ids.includes(txn.id)).map((txn) => txn.debit);
    const peak = amounts.length ? Math.max(...amounts) : 0;
    const monthTotal = amounts.reduce((sum, amount) => sum + amount, 0);
    const oneOff = monthTotal > 0 && peak >= monthTotal * 0.7;
    reasons.push({
      code: "SPEND_JUMP",
      severity: oneOff ? "info" : "watch",
      title: oneOff ? `${jump.name} spiked on one payment` : `${jump.name} jumped against the prior month`,
      detail: oneOff
        ? `${jump.name} was ${inr(jump.delta, 0)} higher than the month before, and one payment is most of that month.`
        : `${jump.name} was ${Math.round(jump.change * 100)}% higher than the month before, up ${inr(jump.delta, 0)}.`,
      txnIds: jump.ids,
    });
  }

  if (keys.length < 6) return;
  const total = (list: string[]) =>
    list.reduce((sum, key) => {
      const month = byMonth.get(key);
      if (!month) return sum;
      return sum + [...month.values()].reduce((inner, row) => inner + row.amount, 0);
    }, 0);
  const recentAvg = total(keys.slice(-3)) / 3;
  const priorAvg = total(keys.slice(-6, -3)) / 3;
  if (priorAvg >= 2000 && recentAvg - priorAvg >= 2000 && (recentAvg - priorAvg) / priorAvg >= 0.15) {
    const recent = new Set(keys.slice(-3));
    reasons.push({
      code: "SPEND_CREEP",
      severity: "watch",
      title: "Day-to-day spending has drifted up",
      detail: `Food, shopping, travel, fuel, and similar spends average ${inr(recentAvg, 0)} over the last three months, ${Math.round(((recentAvg - priorAvg) / priorAvg) * 100)}% above the three months before that.`,
      txnIds: txns.filter((txn) => recent.has(monthKey(txn.date)) && txn.debit > 0 && DISCRETIONARY.has(groupOf(txn).id)).map((txn) => txn.id),
    });
  }
}

function closedMonthKeys(txns: Txn[]) {
  const keys = [...new Set(txns.map((txn) => monthKey(txn.date)))].sort();
  if (keys.length < 3) return keys;
  const last = keys[keys.length - 1];
  const maxDay = Math.max(...txns.filter((txn) => monthKey(txn.date) === last).map((txn) => Number(txn.date.slice(8, 10))));
  return maxDay < 24 ? keys.slice(0, -1) : keys;
}

function buildReasons(
  txns: Txn[],
  months: MonthPoint[],
  metrics: Analysis["metrics"],
  policy: Policy,
  integrity: IntegrityCheck[],
  flows: FlowReport,
  payability: Analysis["payability"],
  habits: SpendHabits,
  judgment?: Judgment | null,
): Reason[] {
  const reasons: Reason[] = [];
  const cashflow = payability.mode === "cashflow";
  const ids = (...categories: Category[]) => txns.filter((txn) => categories.includes(txn.category)).map((txn) => txn.id);
  const idByKey = new Map(txns.filter((txn) => txn.key).map((txn) => [txn.key as string, txn.id]));
  judgment?.notes.forEach((note) => {
    // Skip legacy per-item judge spam; summaries replace the flood.
    if (isLegacyJudgeNote(note.code)) return;
    reasons.push({
      code: note.code,
      title: note.title,
      detail: note.detail,
      severity: note.severity,
      txnIds: note.keys.map((key) => idByKey.get(key)).filter((id): id is string => Boolean(id)),
    });
  });

  if (cashflow) {
    reasons.push({
      code: "CASHFLOW",
      severity: "info",
      title: "Repayment is sized from the cash that stays",
      detail: `No salary on this file. Customers, cash, and transfers that stay average ${inr(payability.workAvg, 0)} a month. The middle month brings in ${inr(payability.workIn, 0)} and ${inr(payability.spent, 0)} goes out, so the EMI follows that quieter month. ${inr(payability.moved, 0)} moved between their own accounts and is left out of both sides.`,
      txnIds: [],
    });
  }

  if (metrics.bounces6m > policy.maxBounces6m) {
    reasons.push({
      code: "BOUNCE_LIMIT",
      severity: "breach",
      title: "Returns are above the limit",
      detail: `${metrics.bounces6m} return events in the last six months. The limit on this file is ${policy.maxBounces6m}.`,
      txnIds: ids("bounce_reversal", "bounce_charge"),
    });
  } else if (metrics.bounces6m > 0) {
    reasons.push({
      code: "BOUNCE_WATCH",
      severity: "watch",
      title: "Returns are inside the limit",
      detail: `${metrics.bounces6m} return events are on the file and still under the cap of ${policy.maxBounces6m}.`,
      txnIds: ids("bounce_reversal", "bounce_charge"),
    });
  }

  if (metrics.obligationRatio > policy.maxObligationRatio) {
    reasons.push({
      code: "OBLIGATION_RATIO",
      severity: "breach",
      title: "Fixed debts are heavy",
      detail: `EMI, rent, card payments, and pay-later are ${Math.round(metrics.obligationRatio * 100)}% of inflows. The cap is ${Math.round(policy.maxObligationRatio * 100)}%.`,
      txnIds: habits.burdenIds,
    });
  }

  if (metrics.topShare > policy.maxConcentration) {
    reasons.push({
      code: "CONCENTRATION",
      severity: "breach",
      title: "Receipts depend on one payer",
      detail: `${metrics.topName} is ${Math.round(metrics.topShare * 100)}% of earned inflow. The cap is ${Math.round(policy.maxConcentration * 100)}%.`,
      txnIds: txns.filter((txn) => txn.counterparty === metrics.topName && EARNED.includes(txn.category)).map((txn) => txn.id),
    });
  } else if (metrics.topShare >= 0.25 && metrics.avgEarned > 0) {
    reasons.push({
      code: "CONCENTRATION_NOTE",
      severity: "watch",
      title: "One payer is a large share of receipts",
      detail: `${metrics.topName} is ${Math.round(metrics.topShare * 100)}% of earned inflow. A single payer above 25% is a concentration risk, even inside the ${Math.round(policy.maxConcentration * 100)}% cap.`,
      txnIds: txns.filter((txn) => txn.counterparty === metrics.topName && EARNED.includes(txn.category)).map((txn) => txn.id),
    });
  }

  if (metrics.trend < -0.1) {
    reasons.push({
      code: "INFLOW_TREND",
      severity: metrics.trend < -0.2 ? "breach" : "watch",
      title: "Recent receipts are softer",
      detail: `The last three months are ${Math.round(metrics.trend * 100)}% versus the three before them.`,
      txnIds: [],
    });
  }

  const weakMonth = [...months].sort((a, b) => a.earned - b.earned)[0];
  if (weakMonth && metrics.avgEarned > 0 && weakMonth.earned < metrics.avgEarned * 0.75) {
    reasons.push({
      code: "WEAK_MONTH",
      severity: "info",
      title: `${weakMonth.label} was a thin month`,
      detail: `Earned inflow was ${Math.round((1 - weakMonth.earned / metrics.avgEarned) * 100)}% below the average month.`,
      txnIds: txns.filter((txn) => monthKey(txn.date) === weakMonth.key).map((txn) => txn.id),
    });
  }

  if (txns.some((txn) => txn.category === "loan_in")) {
    reasons.push({
      code: "LOAN_EXCLUDED",
      severity: "info",
      title: "Loan credits are not income",
      detail: "Disbursements stay out of earned inflow and out of the capacity maths.",
      txnIds: ids("loan_in"),
    });
  }
  if (!cashflow && txns.some((txn) => txn.category === "self_in" || txn.category === "transfer_in")) {
    reasons.push({
      code: "TRANSFER_EXCLUDED",
      severity: "info",
      title: "Self-transfers and inbound transfers are excluded",
      detail: "Money moved from the borrower's own accounts, or from a person rather than a customer, is not treated as business receipts.",
      txnIds: ids("self_in", "transfer_in"),
    });
  }
  const cashIn = txns.filter((txn) => txn.category === "cash_in").reduce((sum, txn) => sum + txn.credit, 0);
  if (!cashflow && cashIn > 0 && metrics.totalCredits > 0) {
    const cashShare = cashIn / metrics.totalCredits;
    reasons.push({
      code: "CASH_EXCLUDED",
      severity: cashShare >= 0.25 ? "watch" : "info",
      title: cashShare >= 0.25 ? "Cash deposits are a large share of credits" : "Cash deposits are excluded",
      detail:
        cashShare >= 0.25
          ? `${inr(cashIn, 0)} of cash deposits is ${Math.round(cashShare * 100)}% of all credits. Branch cash stays out of earned inflow.`
          : "Branch cash deposits are visible and kept out of earned inflow.",
      txnIds: ids("cash_in"),
    });
  }
  if (metrics.medianCashAfterOps <= 0) {
    reasons.push({
      code: "NO_SURPLUS",
      severity: "breach",
      title: cashflow ? "A typical month does not leave cash" : "No cash left after operations",
      detail: cashflow
        ? "After own-account transfers are removed, a typical month spends what comes in. A new EMI is ₹0."
        : "The median month does not cover EMI, rent and operating costs. The indicative band is zero.",
      txnIds: [],
    });
  }
  if (metrics.months < policy.minMonths) {
    reasons.push({
      code: "SHORT_HISTORY",
      severity: "breach",
      title: "The statement is shorter than the minimum",
      detail: `${metrics.months} months are on the file. This assessment asks for ${policy.minMonths}.`,
      txnIds: [],
    });
  }
  if (metrics.avgEarned < policy.minAvgInflow) {
    reasons.push({
      code: "INFLOW_FLOOR",
      severity: cashflow ? "watch" : "breach",
      title: cashflow ? "Work receipts sit under the usual floor" : "Earned inflow is under the floor",
      detail: cashflow
        ? "There is no salary. The EMI follows the cash left after spending, and that cash is below the usual inflow minimum."
        : "Average earned inflow is below the minimum for this file.",
      txnIds: [],
    });
  }
  if (metrics.volatility > 0.3) {
    reasons.push({
      code: "VOLATILITY",
      severity: metrics.volatility > 0.45 ? "breach" : "watch",
      title: "Monthly receipts move around",
      detail: `The coefficient of variation is ${metrics.volatility.toFixed(2)}. A steady file sits under 0.30.`,
      txnIds: [],
    });
  }
  if (metrics.nonEarnedShare > 0.25) {
    reasons.push({
      code: "NON_EARNED",
      severity: "watch",
      title: cashflow ? "A large share of credits moves between their own accounts" : "A large share of credits is not business income",
      detail: cashflow
        ? `${Math.round(metrics.nonEarnedShare * 100)}% of credits are paired with a matching payment out within a few days, so they are not takings.`
        : `${Math.round(metrics.nonEarnedShare * 100)}% of credits are loans, transfers, cash deposits or other non-receipts.`,
      txnIds: cashflow ? [] : ids("loan_in", "self_in", "transfer_in", "cash_in", "other_in"),
    });
  }

  const balance = integrity.find((item) => item.id === "balance");
  if (balance?.status === "fail") {
    reasons.push({
      code: "BALANCE_BREAK",
      severity: "breach",
      title: "The running balance does not tie",
      detail: balance.detail,
      txnIds: [],
    });
  }

  const totalOut = months.reduce((sum, month) => sum + month.totalOut, 0);
  const avgOut = months.length ? totalOut / months.length : 0;
  const avgIn = months.length ? metrics.totalCredits / months.length : 0;
  if (avgOut > avgIn * 1.05 && avgOut - avgIn >= 5000) {
    reasons.push({
      code: "BURN",
      severity: "watch",
      title: "Outflow runs ahead of inflow",
      detail: `A typical month spends ${inr(avgOut, 0)} and receives ${inr(avgIn, 0)}.`,
      txnIds: [],
    });
  }

  const lastBalance = [...txns].reverse().find((txn) => txn.balance != null)?.balance;
  const burn = avgOut - avgIn;
  if (lastBalance != null && burn >= 5000) {
    const runway = lastBalance / burn;
    if (runway < 3) {
      reasons.push({
        code: "RUNWAY",
        severity: runway < 1 ? "breach" : "watch",
        title: runway < 1 ? "Closing balance does not cover a month of burn" : "Cash runway is short",
        detail: `The last balance is ${inr(lastBalance, 0)}. At the recent gap between outflow and inflow, that is about ${runway.toFixed(1)} months.`,
        txnIds: [],
      });
    }
  }

  const personIn = txns.filter((txn) => txn.category === "self_in" || txn.category === "transfer_in").reduce((sum, txn) => sum + txn.credit, 0);
  const personOut = txns.filter((txn) => txn.category === "self_out" || txn.category === "transfer_out").reduce((sum, txn) => sum + txn.debit, 0);
  if (metrics.totalCredits > 0 && totalOut > 0 && personIn > metrics.totalCredits * 0.35 && personOut > totalOut * 0.25 && personIn >= 50000) {
    reasons.push({
      code: "ROUND_TRIP",
      severity: "watch",
      title: "A large share is moving between people and own accounts",
      detail: `${inr(personIn, 0)} came in from people or own accounts, and ${inr(personOut, 0)} went out the same way. Those rows are not treated as customer receipts or supplier payments.`,
      txnIds: ids("self_in", "transfer_in", "self_out", "transfer_out"),
    });
  }

  const subs = flows.series.filter((item) => item.kind === "subscription").reduce((sum, item) => sum + item.typical, 0);
  if (subs >= 8000 && avgOut > 0 && subs > avgOut * 0.08) {
    reasons.push({
      code: "SUBSCRIPTIONS",
      severity: "watch",
      title: "Subscriptions are a steady commitment",
      detail: `Repeating subscriptions add up to ${inr(subs, 0)} in a typical month.`,
      txnIds: flows.series.filter((item) => item.kind === "subscription").flatMap((item) => item.txnIds),
    });
  }

  const otherRows = txns.filter((txn) => txn.category === "other_in" || txn.category === "other_out");
  const otherShare = txns.length ? otherRows.length / txns.length : 0;
  if (otherShare > 0.15) {
    reasons.push({
      code: "UNGROUPED",
      severity: "watch",
      title: "Many rows still sit outside a clear group",
      detail: `${Math.round(otherShare * 100)}% of rows were not matched to a known vendor, person, or payroll pattern.`,
      txnIds: otherRows.map((txn) => txn.id),
    });
  }

  pushSpendFlags(reasons, txns);
  pushHabitFlags(reasons, habits, policy);

  return reasons;
}

function applyCreditHits(
  grade: Analysis["grade"],
  signals: import("./types").CreditSignals,
): Analysis["grade"] {
  const rules = [...grade.rules];
  const add = (id: string, label: string, hit: boolean, delta: number, note: string) => {
    if (!hit) return;
    rules.push({ id, label, hit: true, delta, note });
  };
  add(
    "foir",
    `FOIR within ${Math.round(signals.foirCap * 100)}% of earned inflow`,
    signals.foirBreaks,
    -18,
    `${Math.round(signals.foirWithNew * 100)}% with a new EMI of ${inr(signals.proposedEmi, 0)}`,
  );
  add(
    "emi-day-balance",
    "Balance covers EMI on mandate dates",
    signals.thinOnEmiDays,
    -14,
    `Median on the 1st/5th/15th/25th is ${inr(signals.balanceOnEmiDays, 0)}`,
  );
  if (!signals.thinOnEmiDays && signals.daysBelowEmi >= 4) {
    rules.push({
      id: "days-below-emi",
      label: "Balance stays above existing EMI",
      hit: true,
      delta: -6,
      note: `${signals.daysBelowEmi} days sit under ${inr(signals.monthlyDebt, 0)}`,
    });
  }
  add(
    "loan-stack",
    "Loan-app stacking under control",
    signals.stackCount >= 4 || signals.stackMonthly >= 15000,
    -16,
    `${signals.stackCount} apps, ~${inr(signals.stackMonthly, 0)} a month`,
  );
  if (signals.stackCount >= 3 && signals.stackCount < 4 && signals.stackMonthly < 15000) {
    rules.push({
      id: "loan-stack-watch",
      label: "Loan-app stacking visible",
      hit: true,
      delta: -6,
      note: `${signals.stackCount} digital lenders on the file`,
    });
  }
  add(
    "mandate-stress",
    "EMI mandates clear without bounce",
    signals.mandateBounced,
    -12,
    "At least one mandate return is on the file",
  );
  add(
    "conduct",
    "No material gambling or crypto outflow",
    signals.conductShare >= 0.08 && signals.conductAmount >= 2000,
    -20,
    `${inr(signals.conductAmount, 0)} on betting or crypto narrations`,
  );
  if (signals.windowDressAmount >= 25000) {
    rules.push({
      id: "window-dress",
      label: "Late credits look dressed",
      hit: true,
      delta: -8,
      note: `${inr(signals.windowDressAmount, 0)} leaves again within days`,
    });
  }
  const points = Math.max(0, Math.min(100, 100 + rules.reduce((sum, rule) => sum + rule.delta, 0)));
  return {
    ...grade,
    points,
    letter: letterFor(points),
    label: labelFor(points),
    rules,
  };
}

const LEGACY_JUDGE_PREFIXES = ["judge-party-", "judge-people-", "judge-debt-", "judge-self-", "judge-cash-", "judge-loop-"] as const;

function isLegacyJudgeNote(code: string): boolean {
  if (code.endsWith("-summary") || code === "judge-bind") return false;
  return LEGACY_JUDGE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/** Officer-facing order: blockers first, then watch, strengths, quiet detail last. */
export function rankReasons(reasons: Reason[]): Reason[] {
  const order = { breach: 0, watch: 1, good: 2, info: 3 };
  const seen = new Set<string>();
  const deduped: Reason[] = [];
  for (const item of reasons) {
    if (isLegacyJudgeNote(item.code)) continue;
    const key = `${item.severity}|${item.title}`;
    // Keep summaries; collapse duplicate titles from the same family.
    if (seen.has(key) && !item.code.includes("summary")) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.sort((a, b) => order[a.severity] - order[b.severity] || a.title.localeCompare(b.title));
}

export type ReasonBucket = {
  id: "blocks" | "watch" | "strengths" | "detail";
  label: string;
  hint: string;
  items: Reason[];
};

export function bucketReasons(reasons: Reason[]): ReasonBucket[] {
  const ranked = rankReasons(reasons);
  const blocks = ranked.filter((item) => item.severity === "breach");
  const watch = ranked.filter((item) => item.severity === "watch");
  const strengths = ranked.filter((item) => item.severity === "good");
  const detail = ranked.filter((item) => item.severity === "info");
  const buckets: ReasonBucket[] = [
    { id: "blocks", label: "Blocks the facility", hint: "Fix these before a new EMI", items: blocks },
    { id: "watch", label: "Watch", hint: "Eligible only with these in view", items: watch },
    { id: "strengths", label: "Strengths", hint: "What supports the file", items: strengths },
    { id: "detail", label: "Detail", hint: "Spelling merges and quieter notes", items: detail },
  ];
  return buckets.filter((bucket) => bucket.items.length > 0);
}

function buildIntegrity(txns: Txn[], months: number, minMonths: number, missingMonths: string[] | null): IntegrityCheck[] {
  const withBalance = txns.filter((txn) => txn.balance != null);
  let breaks = 0;
  for (let i = 1; i < txns.length; i += 1) {
    const prev = txns[i - 1];
    const curr = txns[i];
    if (prev.balance == null || curr.balance == null) continue;
    const expected = round2(prev.balance + curr.credit - curr.debit);
    if (Math.abs(expected - curr.balance) > 1.5) breaks += 1;
  }

  const bothSides = txns.filter((txn) => txn.debit > 0 && txn.credit > 0).length;
  const dated = txns.every((txn) => /^\d{4}-\d{2}-\d{2}$/.test(txn.date));

  const checks: IntegrityCheck[] = [
    {
      id: "balance",
      label: "Balance continuity",
      status: withBalance.length < 2 ? "na" : breaks === 0 ? "pass" : "fail",
      detail:
        withBalance.length < 2
          ? "No running balance on the file, so continuity could not be checked."
          : breaks === 0
            ? `Held across ${withBalance.length} rows with a balance.`
            : `${breaks} rows break the running balance.`,
    },
    {
      id: "sides",
      label: "Debit and credit are separate",
      status: bothSides === 0 ? "pass" : "fail",
      detail: bothSides === 0 ? "No row posts both a debit and a credit." : `${bothSides} rows post both.`,
    },
    {
      id: "dates",
      label: "Dates parse",
      status: dated ? "pass" : "fail",
      detail: dated ? "Every row has a calendar date." : "Some dates could not be normalised.",
    },
    {
      id: "span",
      label: "History length",
      status: months >= minMonths ? "pass" : "fail",
      detail: `${months} months against a minimum of ${minMonths}.`,
    },
  ];
  if (missingMonths) {
    checks.push({
      id: "continuity",
      label: "Months are continuous",
      status: missingMonths.length ? "fail" : "pass",
      detail: missingMonths.length ? `Missing ${missingMonths.join(", ")}.` : "No calendar month is missing inside the statement.",
    });
  }
  return checks;
}

function buildCounterparties(txns: Txn[]) {
  const map = new Map<string, { amount: number; count: number }>();
  txns.forEach((txn) => {
    if (!EARNED.includes(txn.category) || txn.credit <= 0) return;
    const current = map.get(txn.counterparty) ?? { amount: 0, count: 0 };
    current.amount += txn.credit;
    current.count += 1;
    map.set(txn.counterparty, current);
  });
  const gross = [...map.values()].reduce((total, value) => total + value.amount, 0);
  return [...map.entries()]
    .map(([name, value]) => ({
      name,
      amount: value.amount,
      count: value.count,
      share: gross > 0 ? value.amount / gross : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);
}

function buildOutflows(months: MonthPoint[]) {
  const rows = [
    { key: "emi", label: "EMI", amount: sum(months.map((month) => month.emi)) },
    { key: "rent", label: "Rent", amount: sum(months.map((month) => month.rent)) },
    { key: "suppliers", label: "Suppliers", amount: sum(months.map((month) => month.suppliers)) },
    { key: "utilities", label: "Utilities and tax", amount: sum(months.map((month) => month.utilitiesTax)) },
    { key: "bounces", label: "Bounce charges", amount: sum(months.map((month) => month.bounceCharges)) },
    { key: "drawings", label: "Drawings and personal", amount: sum(months.map((month) => month.drawings)) },
  ];
  return rows.filter((row) => row.amount > 0);
}

function writeSummary(
  metrics: Analysis["metrics"],
  capacity: Analysis["capacity"],
  grade: Analysis["grade"],
  policy: Policy,
  payability?: Analysis["payability"],
) {
  if (payability?.mode === "cashflow") {
    const left = payability.left;
    const quiet = payability.workAvg > payability.workIn * 1.5 && payability.workAvg - payability.workIn > 5000;
    return `This account has no salary. Customers, cash, and transfers that stay average ${inrWords(payability.workAvg)} a month. ${
      quiet ? `The middle month brings in only ${inrWords(payability.workIn)}, and ${inrWords(payability.spent)} goes out, so the EMI follows that quieter month. ` : `${inrWords(payability.spent)} goes out in the middle month. `
    }${
      left > 0
        ? `${inrWords(left)} is left, so a new EMI of ${inrWords(capacity.monthly)} fits.`
        : "Nothing is left for a new EMI."
    } ${inrWords(payability.moved)} moved between their own accounts and is left out of both sides.`;
  }
  const band =
    capacity.principal > 0
      ? `The offer is ${inrWords(capacity.bandLow)} to ${inrWords(capacity.bandHigh)} over ${yearsLabel(policy.tenureMonths)} at ${Math.round(datasetRate(grade.letter)[0] * 100)}–${Math.round(datasetRate(grade.letter)[1] * 100)}%.`
      : "A new facility is not available on these terms.";
  return `AI graded this file ${grade.letter}, ${grade.label}, readiness ${grade.points}. Cash left after operations is ${inrWords(metrics.medianCashAfterOps)} in a typical month. ${band}`;
}

function inrWords(value: number) {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)}L`;
  if (abs >= 1000) return `${sign}₹${Math.round(abs / 1000)}k`;
  return `${sign}₹${Math.round(abs)}`;
}

function confidence(txns: Txn[], integrity: IntegrityCheck[], months: number) {
  let score = 40;
  if (txns.some((txn) => txn.balance != null)) score += 20;
  if (integrity.every((check) => check.status !== "fail")) score += 20;
  if (months >= 12) score += 10;
  else if (months >= 6) score += 5;
  const tagged = txns.filter((txn) => txn.category !== "other_in" && txn.category !== "other_out").length;
  score += Math.round((tagged / Math.max(txns.length, 1)) * 10);
  return clamp(score, 0, 100);
}

function withinMonths(date: string, end: string, months: number) {
  if (!end) return true;
  const endDate = new Date(`${end}T00:00:00`);
  const start = new Date(endDate);
  start.setMonth(start.getMonth() - months);
  const current = new Date(`${date}T00:00:00`);
  return current >= start && current <= endDate;
}

function shareOf(subset: Txn[], all: Txn[]) {
  const total = all.reduce((sum, txn) => sum + txn.credit + txn.debit, 0);
  const part = subset.reduce((sum, txn) => sum + txn.credit + txn.debit, 0);
  return total > 0 ? part / total : 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]) {
  if (!values.length) return 0;
  return sum(values) / values.length;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((total, value) => total + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
