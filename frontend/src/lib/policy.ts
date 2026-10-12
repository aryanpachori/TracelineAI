import type { ChartConfig, Policy, WidgetId, WidgetSetting } from "./types";

export const STANDARD_POLICY: Policy = {
  maxObligationRatio: 0.4,
  maxBounces6m: 1,
  minMonths: 6,
  maxConcentration: 0.6,
  surplusShare: 0.35,
  annualRate: 0.24,
  tenureMonths: 18,
  minAvgInflow: 100000,
};

export const POLICY_PRESETS: { id: string; label: string; hint: string; policy: Policy }[] = [
  {
    id: "conservative",
    label: "Conservative",
    hint: "Tighter bounces, shorter tenure, smaller share of surplus",
    policy: {
      maxObligationRatio: 0.3,
      maxBounces6m: 0,
      minMonths: 12,
      maxConcentration: 0.45,
      surplusShare: 0.2,
      annualRate: 0.28,
      tenureMonths: 12,
      minAvgInflow: 150000,
    },
  },
  {
    id: "standard",
    label: "Standard",
    hint: "Small-ticket unsecured starting point",
    policy: STANDARD_POLICY,
  },
  {
    id: "growth",
    label: "Growth",
    hint: "Wider band for a cleaner recent trend",
    policy: {
      maxObligationRatio: 0.55,
      maxBounces6m: 3,
      minMonths: 6,
      maxConcentration: 0.7,
      surplusShare: 0.45,
      annualRate: 0.21,
      tenureMonths: 24,
      minAvgInflow: 80000,
    },
  },
];

export const WIDGET_META: Record<WidgetId, { title: string; span: string }> = {
  verdict: { title: "Repayment view", span: "lg:col-span-12" },
  kpis: { title: "Averages", span: "lg:col-span-12" },
  spending: { title: "Where the money goes", span: "lg:col-span-12" },
  facilities: { title: "Credit options", span: "lg:col-span-12" },
  flows: { title: "Recurring flows", span: "lg:col-span-12" },
  cashflow: { title: "Cash flow", span: "lg:col-span-7" },
  composition: { title: "Credits", span: "lg:col-span-5" },
  outflows: { title: "Debits", span: "lg:col-span-6" },
  counterparties: { title: "Payers", span: "lg:col-span-6" },
  flags: { title: "Notes", span: "lg:col-span-7" },
  policy: { title: "Terms", span: "lg:col-span-5" },
  integrity: { title: "Statement checks", span: "lg:col-span-12" },
  monthly: { title: "Monthly figures", span: "lg:col-span-12" },
  ledger: { title: "Rows", span: "lg:col-span-12" },
};

export const DEFAULT_WIDGETS: WidgetSetting[] = [
  { id: "verdict", visible: true },
  { id: "kpis", visible: true },
  { id: "spending", visible: true },
  { id: "facilities", visible: true },
  { id: "flows", visible: true },
  { id: "cashflow", visible: true },
  { id: "composition", visible: true },
  { id: "outflows", visible: true },
  { id: "counterparties", visible: true },
  { id: "flags", visible: true },
  { id: "policy", visible: true },
  { id: "integrity", visible: true },
  { id: "monthly", visible: true },
  { id: "ledger", visible: true },
];

export const DEFAULT_CHART: ChartConfig = {
  type: "area",
  series: {
    earned: true,
    cashAfterOps: true,
    obligations: true,
    totalIn: false,
  },
};

export const SERIES_META: Record<keyof ChartConfig["series"], { label: string; color: string }> = {
  earned: { label: "Earned inflow", color: "#0c9a74" },
  cashAfterOps: { label: "Cash after operations", color: "#2563eb" },
  obligations: { label: "EMI + rent", color: "#d97706" },
  totalIn: { label: "All credits", color: "#94a3b8" },
};
