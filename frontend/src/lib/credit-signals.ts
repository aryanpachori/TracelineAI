import type { CreditSignals, FlowReport, MonthPoint, Policy, Reason, Txn } from "./types";

export type { CreditSignals };

/** Digital lenders / BNPL often invisible to bureau until late. */
export const LOAN_APP =
  /bajaj|bflautopay|\bbfl\b|kreditbee|\bnavi\b|\bslice\b|lazypay|\bsimpl\b|home\s*credit|moneyview|earlysalary|postpe|paytm\s*postpaid|amazon\s*pay\s*later|flipkart\s*pay|snapmint|zestmoney|cashe|stashfin|mpokket|indialends|ring\s*by\s*reco|loanwalle|loanfront|paysense|prefr\b|fibe\b|liquiloans|branch\s*intl|kredit|cred\.club|dreamplug|\bcred\b/i;

const CONDUCT =
  /bet365|betway|dream11|mpl\b|my11circle|rummycircle|pokerstars|stake\.com|casino|gambling|1xbet|parimatch|binance|wazirx|coinswitch|coindcx|zebpay|unocoin|crypto\.com|coinbase|ku\s*coin/i;

const EMI_DAYS = new Set([1, 5, 15, 25]);

export function buildCreditSignals(input: {
  txns: Txn[];
  months: MonthPoint[];
  avgEarned: number;
  monthlyDebt: number;
  proposedEmi: number;
  policy: Policy;
  flows: FlowReport;
  debtIds?: string[];
}): CreditSignals {
  const earned = Math.max(input.avgEarned, 0);
  const visibleDebt = Math.max(input.monthlyDebt, 0);
  const proposedEmi = Math.max(input.proposedEmi, 0);
  const stack = loanAppStack(input.txns, input.months.length);
  const hiddenStack = hiddenLoanAppMonthly(input.txns, input.months.length, input.debtIds ?? []);
  const monthlyDebt = visibleDebt + hiddenStack;
  const foir = earned > 0 ? monthlyDebt / earned : monthlyDebt > 0 ? 1 : 0;
  const foirWithNew = earned > 0 ? (monthlyDebt + proposedEmi) / earned : foir;
  const foirCap = input.policy.maxObligationRatio;

  const balances = balanceStats(input.txns, monthlyDebt || proposedEmi);
  const dress = windowDressing(input.txns, earned);
  const conduct = conductRisk(input.txns);
  const mandates = mandateHealth(input.flows);
  const debtIds = [...new Set([...(input.debtIds ?? []), ...stack.ids])];

  const thinOnEmiDays =
    balances.balanceOnEmiDays > 0 && monthlyDebt > 0 && balances.balanceOnEmiDays < monthlyDebt * 0.9;

  return {
    foir,
    foirWithNew,
    foirCap,
    foirBreaks: proposedEmi > 0 ? foirWithNew > foirCap : foir > foirCap,
    monthlyDebt,
    hiddenStack,
    proposedEmi,
    abb: balances.abb,
    balanceOnEmiDays: balances.balanceOnEmiDays,
    thinOnEmiDays,
    daysBelowEmi: balances.daysBelowEmi,
    zeroBalanceDays: balances.zeroBalanceDays,
    stackCount: stack.count,
    stackMonthly: stack.monthly,
    stackNames: stack.names,
    stackIds: stack.ids,
    windowDressAmount: dress.amount,
    windowDressIds: dress.ids,
    conductShare: conduct.share,
    conductAmount: conduct.amount,
    conductIds: conduct.ids,
    mandateCount: mandates.count,
    mandateMissed: mandates.missed,
    mandateBounced: mandates.bounced,
    debtIds,
  };
}

export function creditSignalReasons(signals: CreditSignals): Reason[] {
  const reasons: Reason[] = [];

  if (signals.foirBreaks) {
    reasons.push({
      code: "FOIR_BREACH",
      severity: "breach",
      title: "FOIR exceeds policy — residual income is insufficient",
      detail: `Fixed obligations are ${pct(signals.foir)} of earned inflow now${
        signals.proposedEmi > 0 ? `, ${pct(signals.foirWithNew)} after a new EMI of ${inr(signals.proposedEmi)}` : ""
      }. The file cap is ${pct(signals.foirCap)}.${
        signals.hiddenStack > 0 ? ` Includes ${inr(signals.hiddenStack)} a month in digital lenders not booked as EMI.` : ""
      }`,
      txnIds: signals.debtIds,
    });
  } else if (signals.foir >= signals.foirCap * 0.75 && signals.monthlyDebt > 0) {
    reasons.push({
      code: "FOIR_WATCH",
      severity: "watch",
      title: "FOIR sits near the policy limit",
      detail: `Existing instalments are ${pct(signals.foir)} of earned inflow (${inr(signals.monthlyDebt)} a month). Cap is ${pct(signals.foirCap)}.`,
      txnIds: signals.debtIds,
    });
  } else if (signals.monthlyDebt > 0) {
    reasons.push({
      code: "FOIR_OK",
      severity: "good",
      title: "Existing debts fit this cashflow",
      detail: `FOIR is ${pct(signals.foir)} of earned inflow. With a new EMI of ${inr(signals.proposedEmi)} it would be ${pct(signals.foirWithNew)}.`,
      txnIds: signals.debtIds,
    });
  }

  if (signals.thinOnEmiDays) {
    reasons.push({
      code: "EMI_DAY_BALANCE",
      severity: "breach",
      title: "Thin balance on presentation dates",
      detail: `Median end-of-day on the 1st, 5th, 15th and 25th is ${inr(signals.balanceOnEmiDays)}, under the ${inr(signals.monthlyDebt)} already committed. Mandates bounce when the day is empty even if the month average looks fine.`,
      txnIds: signals.debtIds,
    });
  } else if (signals.daysBelowEmi >= 4) {
    reasons.push({
      code: "DAYS_BELOW_EMI",
      severity: "watch",
      title: "Balance falls below EMI on several days",
      detail: `${signals.daysBelowEmi} days sit under the ${inr(signals.monthlyDebt)} already committed. Average bank balance is ${inr(signals.abb)}.`,
      txnIds: [],
    });
  } else if (signals.zeroBalanceDays >= 5) {
    reasons.push({
      code: "ZERO_BALANCE_DAYS",
      severity: "watch",
      title: "The account often sits near zero",
      detail: `${signals.zeroBalanceDays} days with a balance under ₹500. Average balance is ${inr(signals.abb)}.`,
      txnIds: [],
    });
  }

  if (signals.stackCount >= 3 || signals.stackMonthly >= 5000) {
    reasons.push({
      code: "LOAN_STACK",
      severity: signals.stackCount >= 4 || signals.stackMonthly >= 15000 ? "breach" : "watch",
      title:
        signals.stackCount >= 4 || signals.stackMonthly >= 15000
          ? "Multiple digital lenders — overleveraged outside bureau"
          : "Loan-app and pay-later stacking",
      detail: `${signals.stackCount} digital lenders take about ${inr(signals.stackMonthly)} a month${
        signals.stackNames.length ? ` (${signals.stackNames.slice(0, 3).join(", ")}${signals.stackNames.length > 3 ? "…" : ""})` : ""
      }. These often sit outside bureau FOIR until late.`,
      txnIds: signals.stackIds,
    });
  }

  if (signals.windowDressAmount >= 25000) {
    reasons.push({
      code: "WINDOW_DRESS",
      severity: "watch",
      title: "Window dressing in the trailing 30 days",
      detail: `${inr(signals.windowDressAmount)} in large late credits leave again within a few days as self or transfer. They are not treated as earned inflow.`,
      txnIds: signals.windowDressIds,
    });
  }

  if (signals.conductShare >= 0.02 && signals.conductAmount >= 2000) {
    reasons.push({
      code: "CONDUCT_RISK",
      severity: signals.conductShare >= 0.08 ? "breach" : "watch",
      title: "Gambling or crypto outflow — conduct risk",
      detail: `${inr(signals.conductAmount)} (${pct(signals.conductShare)} of outflow) matches betting or crypto narrations.`,
      txnIds: signals.conductIds,
    });
  }

  if (signals.mandateBounced || signals.mandateMissed >= 2) {
    reasons.push({
      code: "MANDATE_STRESS",
      severity: signals.mandateBounced ? "breach" : "watch",
      title: signals.mandateBounced ? "NACH / EMI mandate has already returned" : "EMI mandates miss months",
      detail: `${signals.mandateCount} recurring debt series on file${
        signals.mandateMissed ? `, ${signals.mandateMissed} missed months` : ""
      }${signals.mandateBounced ? ", and at least one bounce is tied to a mandate." : "."}`,
      txnIds: [],
    });
  }

  return reasons;
}

function balanceStats(txns: Txn[], emiFloor: number) {
  const byDay = dailyEod(txns);
  if (!byDay.size) {
    return { abb: 0, balanceOnEmiDays: 0, zeroBalanceDays: 0, daysBelowEmi: 0 };
  }
  const dayBalances = [...byDay.values()];
  const abb = mean(dayBalances);
  const emiDayBalances = [...byDay.entries()]
    .filter(([date]) => EMI_DAYS.has(dayOf(date)))
    .map(([, bal]) => bal);
  const balanceOnEmiDays = emiDayBalances.length ? median(emiDayBalances) : abb;
  const zeroBalanceDays = dayBalances.filter((bal) => bal < 500).length;
  const daysBelowEmi = emiFloor > 0 ? dayBalances.filter((bal) => bal < emiFloor).length : 0;
  return { abb, balanceOnEmiDays, zeroBalanceDays, daysBelowEmi };
}

/** Fill every calendar day from first to last known balance so skipped dates still count. */
function dailyEod(txns: Txn[]) {
  const withBal = txns.filter((txn) => txn.balance != null);
  const byDay = new Map<string, number>();
  if (!withBal.length) return byDay;
  withBal.forEach((txn) => {
    byDay.set(txn.date, txn.balance as number);
  });
  const dates = [...byDay.keys()].sort();
  const filled = new Map<string, number>();
  let cursor = dates[0];
  const end = dates[dates.length - 1];
  let last = byDay.get(cursor) ?? 0;
  while (cursor <= end) {
    if (byDay.has(cursor)) last = byDay.get(cursor) as number;
    filled.set(cursor, last);
    cursor = nextDay(cursor);
  }
  return filled;
}

function loanAppStack(txns: Txn[], months: number) {
  const byName = new Map<string, { amount: number; ids: string[] }>();
  txns.forEach((txn) => {
    if (txn.debit <= 0) return;
    if (!LOAN_APP.test(txn.description)) return;
    const name = (txn.counterparty || txn.description.split(/[/-]/)[0] || "Lender").trim().slice(0, 28);
    const slot = byName.get(name) ?? { amount: 0, ids: [] };
    slot.amount += txn.debit;
    slot.ids.push(txn.id);
    byName.set(name, slot);
  });
  const ranked = [...byName.entries()].sort((a, b) => b[1].amount - a[1].amount);
  const span = Math.max(months, 1);
  return {
    count: ranked.length,
    monthly: ranked.reduce((sum, [, slot]) => sum + slot.amount, 0) / span,
    names: ranked.map(([name]) => name),
    ids: ranked.flatMap(([, slot]) => slot.ids),
  };
}

function hiddenLoanAppMonthly(txns: Txn[], months: number, debtIds: string[]) {
  const counted = new Set(debtIds);
  const amount = txns
    .filter(
      (txn) =>
        txn.debit > 0 &&
        !counted.has(txn.id) &&
        txn.category !== "emi" &&
        txn.category !== "rent" &&
        LOAN_APP.test(txn.description),
    )
    .reduce((sum, txn) => sum + txn.debit, 0);
  return amount / Math.max(months, 1);
}

function windowDressing(txns: Txn[], avgEarned: number) {
  if (!txns.length) return { amount: 0, ids: [] as string[] };
  const end = txns[txns.length - 1].date;
  const startMs = Date.parse(end) - 30 * 86400000;
  const floor = Math.max(20000, avgEarned * 0.35);
  const credits = txns.filter(
    (txn) =>
      txn.credit >= floor &&
      Date.parse(txn.date) >= startMs &&
      (txn.category === "cash_in" ||
        txn.category === "self_in" ||
        txn.category === "transfer_in" ||
        txn.category === "other_in" ||
        txn.category === "loan_in"),
  );
  const ids: string[] = [];
  let amount = 0;
  credits.forEach((credit) => {
    const creditMs = Date.parse(credit.date);
    const match = txns.find(
      (txn) =>
        txn.debit > 0 &&
        (txn.category === "self_out" || txn.category === "transfer_out") &&
        Math.abs(txn.debit - credit.credit) <= Math.max(80, credit.credit * 0.02) &&
        Date.parse(txn.date) >= creditMs &&
        Date.parse(txn.date) - creditMs <= 5 * 86400000,
    );
    if (!match) return;
    amount += credit.credit;
    ids.push(credit.id, match.id);
  });
  return { amount, ids: [...new Set(ids)] };
}

function conductRisk(txns: Txn[]) {
  const hits = txns.filter((txn) => txn.debit > 0 && CONDUCT.test(txn.description));
  const amount = hits.reduce((sum, txn) => sum + txn.debit, 0);
  const totalOut = txns.reduce((sum, txn) => sum + txn.debit, 0);
  return {
    amount,
    share: totalOut > 0 ? amount / totalOut : 0,
    ids: hits.map((txn) => txn.id),
  };
}

function mandateHealth(flows: FlowReport) {
  const debt = flows.series.filter((item) => item.kind === "emi" || item.kind === "autopay" || item.kind === "standing");
  return {
    count: debt.length,
    missed: debt.reduce((sum, item) => sum + item.missed, 0),
    bounced: debt.some((item) => item.bounced),
  };
}

function dayOf(iso: string) {
  return Number(iso.slice(8, 10));
}

function nextDay(iso: string) {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return date.toISOString().slice(0, 10);
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function inr(value: number) {
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}
