import { categorize, counterparty } from "./categorize";
import { buildFlows } from "./flows";
import { buildGroups } from "./groups";
import { monthKey, monthLabel, prettyDate } from "./format";
import type {
  AiReading,
  Analysis,
  Category,
  IntegrityCheck,
  MonthPoint,
  Policy,
  Preview,
  Reason,
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

export function analyze(inputs: TxnInput[], policy: Policy, reading?: AiReading | null): Analysis {
  const txns = tag(inputs);
  const months = buildMonths(txns);
  const metrics = buildMetrics(txns, months);
  const integrity = buildIntegrity(txns, metrics.months, policy.minMonths);
  const grade = applyReading(score(metrics, integrity, policy), reading);
  const reasons = buildReasons(txns, months, metrics, policy, grade);
  const counterparties = buildCounterparties(txns);
  const outflowMix = buildOutflows(months);
  const uncategorizedShare = shareOf(
    txns.filter((txn) => txn.category === "other_in" || txn.category === "other_out"),
    txns,
  );

  const flows = buildFlows(txns, months, metrics, grade, policy, reading?.rates.business);
  const groups = buildGroups(txns, months);
  const capacity = buildCapacity(metrics, policy, flows.extraCommit);
  const summary = reading?.summary || writeSummary(metrics, capacity, grade, policy, flows);

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
    grade,
    reasons,
    integrity,
    counterparties,
    outflowMix,
    summary,
    dataConfidence: confidence(txns, integrity, metrics.months),
    uncategorizedShare,
    flows,
    groups,
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

function buildCapacity(metrics: Analysis["metrics"], policy: Policy, extraCommit: number) {
  const room = Math.max(0, metrics.medianCashAfterOps - extraCommit);
  const monthly = room * policy.surplusShare;
  const principal = principalFromEmi(monthly, policy.annualRate, policy.tenureMonths);
  const viable = room > 0 && metrics.avgEarned >= policy.minAvgInflow * 0.5;
  return {
    monthly: viable ? monthly : 0,
    principal: viable ? principal : 0,
    bandLow: viable ? principal * 0.75 : 0,
    bandHigh: viable ? principal : 0,
    basis:
      "Capacity is a share of cash left after EMI, rent, suppliers, utilities, tax, and return charges, with autopays and subscriptions taken off. The band is the loan that payment would carry at the rate and tenure below.",
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
    `EMI + rent within ${Math.round(policy.maxObligationRatio * 100)}% of earned inflow`,
    metrics.obligationRatio > policy.maxObligationRatio,
    -22,
    `${Math.round(metrics.obligationRatio * 100)}% now`,
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

function buildReasons(
  txns: Txn[],
  months: MonthPoint[],
  metrics: Analysis["metrics"],
  policy: Policy,
  grade: Analysis["grade"],
): Reason[] {
  const reasons: Reason[] = [];
  const ids = (...categories: Category[]) => txns.filter((txn) => categories.includes(txn.category)).map((txn) => txn.id);

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
      title: "Fixed obligations are heavy",
      detail: `EMI and rent are ${Math.round(metrics.obligationRatio * 100)}% of average earned inflow. The cap is ${Math.round(policy.maxObligationRatio * 100)}%.`,
      txnIds: ids("emi", "rent"),
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
  } else if (metrics.topShare >= 0.35) {
    reasons.push({
      code: "CONCENTRATION_NOTE",
      severity: "info",
      title: "One payer is material",
      detail: `${metrics.topName} is ${Math.round(metrics.topShare * 100)}% of earned inflow, still inside the ${Math.round(policy.maxConcentration * 100)}% cap.`,
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
  if (txns.some((txn) => txn.category === "self_in" || txn.category === "transfer_in")) {
    reasons.push({
      code: "TRANSFER_EXCLUDED",
      severity: "info",
      title: "Self-transfers and inbound transfers are excluded",
      detail: "Money moved from the borrower's own accounts, or from a person rather than a customer, is not treated as business receipts.",
      txnIds: ids("self_in", "transfer_in"),
    });
  }
  if (txns.some((txn) => txn.category === "cash_in")) {
    reasons.push({
      code: "CASH_EXCLUDED",
      severity: "info",
      title: "Cash deposits are excluded",
      detail: "Branch cash deposits are visible and kept out of earned inflow.",
      txnIds: ids("cash_in"),
    });
  }
  if (metrics.medianCashAfterOps <= 0) {
    reasons.push({
      code: "NO_SURPLUS",
      severity: "breach",
      title: "No cash left after operations",
      detail: "The median month does not cover EMI, rent and operating costs. The indicative band is zero.",
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
      severity: "breach",
      title: "Earned inflow is under the floor",
      detail: "Average earned inflow is below the minimum for this file.",
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
      title: "A large share of credits is not business income",
      detail: `${Math.round(metrics.nonEarnedShare * 100)}% of credits are loans, transfers, cash deposits or other non-receipts.`,
      txnIds: ids("loan_in", "self_in", "transfer_in", "cash_in", "other_in"),
    });
  }

  const order = { breach: 0, watch: 1, info: 2 };
  return reasons.sort((a, b) => order[a.severity] - order[b.severity]);
}

function buildIntegrity(txns: Txn[], months: number, minMonths: number): IntegrityCheck[] {
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

  return [
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
  flows: Analysis["flows"],
) {
  const lead = flows.facilities.find((item) => item.fit === "strong") ?? flows.facilities.find((item) => item.fit === "conditional") ?? flows.facilities[0];
  const band =
    capacity.principal > 0
      ? `The working band is ${inrWords(capacity.bandLow)} to ${inrWords(capacity.bandHigh)} over ${policy.tenureMonths} months at ${Math.round(policy.annualRate * 100)}%.`
      : "A new facility is not available on these terms.";
  const option =
    lead && lead.amountHigh > 0
      ? `${lead.name} is ${lead.fit === "strong" ? "the leading option" : "the closest option"}, from ${inrWords(lead.amountLow)} to ${inrWords(lead.amountHigh)} at ${Math.round(lead.rateLow * 100)}–${Math.round(lead.rateHigh * 100)}%.`
      : "A new facility is not a fit on this file.";
  return `AI graded this file ${grade.letter}, ${grade.label}, readiness ${grade.points}. Cash left after operations is ${inrWords(metrics.medianCashAfterOps)} in a typical month. ${band} ${option}`;
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
