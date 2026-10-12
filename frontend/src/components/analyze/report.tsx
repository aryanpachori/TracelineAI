"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CashflowChart, CreditMixChart, SpendMonthChart, SpendShareChart } from "@/components/analyze/charts";
import { OpenProvider, TrailBar, focusIds, openLabel, openMatch, useOpen } from "@/components/analyze/depth";
import { Figure } from "@/components/analyze/figure";
import { buildCaseFile } from "@/lib/case-file";
import { SpendSummary } from "@/components/analyze/spend-summary";
import { downloadText } from "@/components/analyze/upload-panel";
import { CATEGORY_LABEL, inr, inrBand, inrCompact, pct, prettyDate, signedPct } from "@/lib/format";
import { groupName } from "@/lib/groups";
import { POLICY_PRESETS, SERIES_META, STANDARD_POLICY, WIDGET_META } from "@/lib/policy";
import type { Analysis, ChartConfig, ChartSeriesKey, FacilityFit, Policy, SeriesKind, WidgetId, WidgetSetting } from "@/lib/types";

export function Report({
  analysis,
  policy,
  onPolicy,
  caseRef,
  fileName,
  chart,
  onChart,
  widgets,
  onWidgets,
  onReset,
}: {
  analysis: Analysis;
  policy: Policy;
  onPolicy: (policy: Policy) => void;
  caseRef: string;
  fileName: string;
  chart: ChartConfig;
  onChart: (chart: ChartConfig) => void;
  widgets: WidgetSetting[];
  onWidgets: (widgets: WidgetSetting[]) => void;
  onReset: () => void;
}) {
  const [arrange, setArrange] = useState(false);

  const blocks: Record<WidgetId, ReactNode> = {
    verdict: <Verdict analysis={analysis} policy={policy} />,
    kpis: <Averages analysis={analysis} />,
    spending: <Spending analysis={analysis} />,
    facilities: <Facilities analysis={analysis} />,
    flows: <Flows analysis={analysis} />,
    cashflow: <Cashflow analysis={analysis} chart={chart} onChart={onChart} />,
    composition: <Credits analysis={analysis} />,
    outflows: <Debits analysis={analysis} />,
    counterparties: <Payers analysis={analysis} />,
    flags: <Reasons analysis={analysis} />,
    policy: <PolicyPanel policy={policy} onPolicy={onPolicy} />,
    readiness: <Readiness analysis={analysis} />,
    integrity: <Checks analysis={analysis} />,
    monthly: <Months analysis={analysis} />,
    ledger: <Rows analysis={analysis} />,
  };

  return (
    <OpenProvider>
    <article className="mx-auto max-w-[1080px] px-5 pb-44">
      <header className="flex flex-wrap items-end justify-between gap-4 pt-8">
        <div>
          <p className="text-sm text-muted">{fileName}</p>
          <h1 className="font-serif text-4xl font-normal leading-tight">
            {caseRef || "Untitled case"}
          </h1>
          <p className="mt-1 text-muted">{analysis.periodLabel}</p>
        </div>
        <div className="no-print flex flex-wrap gap-4 text-sm">
          <button type="button" className="underline underline-offset-4" onClick={() => setArrange((open) => !open)}>
            {arrange ? "Close arrangement" : "Arrange sections"}
          </button>
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => {
              const file = buildCaseFile(analysis, policy, caseRef, fileName);
              const name = (caseRef || "case").toLowerCase();
              downloadText(JSON.stringify(file, null, 2), `${name}-credit-file.json`, "application/json");
              window.setTimeout(() => {
                downloadText(file.statement, fileName || `${name}-statement.csv`, "text/csv");
              }, 400);
            }}
          >
            Download the file
          </button>
          <button type="button" className="underline underline-offset-4" onClick={onReset}>
            New statement
          </button>
        </div>
      </header>
      <p className="mt-4 max-w-[46rem] text-sm text-muted">
        AI credit file. {analysis.txns.length} rows read from the statement. Statement coverage{" "}
        {analysis.dataConfidence}, from balance, dates, length, and how completely each narration was grouped.
      </p>

      {arrange ? <Arrange widgets={widgets} onWidgets={onWidgets} /> : null}

      <div className="mt-8 grid items-stretch gap-6 lg:grid-cols-12">
        {widgets
          .filter((widget) => widget.visible)
          .map((widget) => (
            <section key={widget.id} className={`panel h-full p-5 ${WIDGET_META[widget.id].span}`}>
              {blocks[widget.id]}
            </section>
          ))}
      </div>
      <LoanAsk analysis={analysis} />
      <TrailBar analysis={analysis} />
    </article>
    </OpenProvider>
  );
}

const FIT_WORD: Record<FacilityFit, string> = {
  strong: "Strong fit",
  conditional: "Conditional",
  weak: "Not available on this file",
};

function LoanAsk({ analysis }: { analysis: Analysis }) {
  const [wants, setWants] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const options = analysis.flows.facilities;
  const chosen = options.find((item) => item.id === picked) ?? null;
  const indicatedRate = chosen ? (chosen.rateLow + chosen.rateHigh) / 2 : 0;
  const indicatedAmount = chosen ? (chosen.amountLow + chosen.amountHigh) / 2 : 0;

  return (
    <section className="panel mt-8 p-5">
      <SectionTitle title="Looking for a loan?" aside={<span className="text-sm text-muted">After the statement</span>} />
      <p className="max-w-[42rem]">
        AI can put an amount and an interest rate on the loan type you are looking for, using the cash flow just read.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className={wants === true ? "on-ink px-4 py-2" : "rounded-xl border border-rule bg-white px-4 py-2"} onClick={() => setWants(true)}>
          Yes, size a loan
        </button>
        <button
          type="button"
          className={wants === false ? "on-ink px-4 py-2" : "rounded-xl border border-rule bg-white px-4 py-2"}
          onClick={() => {
            setWants(false);
            setPicked(null);
          }}
        >
          Not now
        </button>
      </div>
      {wants === false ? (
        <p className="mt-4 text-sm text-muted">The statement stays as it is. Come back here when a loan is the question.</p>
      ) : null}
      {wants === true ? (
        <div className="mt-6">
          <h3 className="font-serif text-xl">Which loan are you looking for?</h3>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {options.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`block h-full w-full rounded-xl border px-4 py-3 text-left ${picked === item.id ? "border-pine bg-[#e7f8f2]" : "border-rule bg-white"}`}
                  onClick={() => setPicked(item.id)}
                >
                  <span className="font-medium">{item.name}</span>
                  <span className="mt-1 block text-sm text-muted">{item.tenure}</span>
                </button>
              </li>
            ))}
          </ul>
          {chosen ? (
            <div className="mt-6 rounded-2xl border border-rule bg-[#f7fbf9] p-5">
              <p className="text-sm text-muted">{FIT_WORD[chosen.fit]}</p>
              <h3 className="mt-1 font-serif text-2xl">{chosen.name}</h3>
              {chosen.amountHigh > 0 ? (
                <>
                  <p className="mt-4 text-sm text-muted">Amount you can get</p>
                  <p className="num font-serif text-4xl leading-none">{inr(indicatedAmount, 0)}</p>
                  <p className="num mt-1 text-sm text-muted">{inrBand(chosen.amountLow, chosen.amountHigh)}</p>
                  <p className="mt-4 text-sm text-muted">Interest on this loan</p>
                  <p className="num font-serif text-4xl leading-none text-pine">{pct(indicatedRate)}</p>
                  <p className="num mt-1 text-sm text-muted">
                    {pct(chosen.rateLow)} – {pct(chosen.rateHigh)} · {chosen.tenure}
                  </p>
                </>
              ) : (
                <p className="mt-4">This statement does not carry that loan. Cash left after the commitments on the file is too thin for it.</p>
              )}
              <p className="mt-4 max-w-[42rem] text-sm">{chosen.reading}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SectionTitle({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-3">
      <h2 className="font-serif text-[1.7rem] font-normal leading-none">{title}</h2>
      {aside}
    </div>
  );
}

function Verdict({ analysis, policy }: { analysis: Analysis; policy: Policy }) {
  const { grade, capacity, summary } = analysis;
  return (
    <div>
      <SectionTitle title="Repayment view" aside={<span className="text-sm text-muted">AI assessment</span>} />
      <div className="grid gap-8 md:grid-cols-[9rem_1fr] md:items-start">
        <div>
          <p className="font-serif text-8xl leading-none">{grade.letter}</p>
          <p className="text-2xl font-semibold tracking-[-0.03em] text-pine">{grade.label}</p>
          <p className="text-sm text-muted">Readiness {grade.points}</p>
        </div>
        <div>
          <p className="text-sm text-muted">Capacity for a new EMI</p>
          <p className="font-serif text-5xl leading-none">
            <Figure value={capacity.monthly} format={(value) => inr(value, 0)} />
            <span className="ml-2 font-sans text-lg text-muted">a month</span>
          </p>
          <p className="mt-3 text-lg">
            Facility{" "}
            <span className="num">
              <Figure value={capacity.bandLow} format={inrCompact} /> –{" "}
              <Figure value={capacity.bandHigh} format={inrCompact} />
            </span>
            <span className="text-muted">
              {" "}
              over {policy.tenureMonths} months at {pct(policy.annualRate)}
            </span>
          </p>
          <p className="mt-4 max-w-[46rem]">{summary}</p>
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<SeriesKind, string> = {
  emi: "EMI",
  autopay: "Autopay",
  subscription: "Subscription",
  standing: "Standing",
  repeat: "Repeat",
};

const FIT_LABEL: Record<FacilityFit, string> = {
  strong: "Strong fit",
  conditional: "Conditional",
  weak: "Weak fit",
};

function Facilities({ analysis }: { analysis: Analysis }) {
  const { open, setOpen } = useOpen();
  return (
    <div>
      <SectionTitle title="Credit options" aside={<span className="text-sm text-muted">Amount and rate from the statement</span>} />
      <p className="mb-4 max-w-[46rem] text-sm">{analysis.flows.reading}</p>
      <ul className="grid gap-4 md:grid-cols-3">
        {analysis.flows.facilities.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`block h-full w-full border border-rule p-4 text-left ${openMatch(open, { kind: "facility", id: item.id }) ? "picked" : ""}`}
              onClick={() => setOpen({ kind: "facility", id: item.id })}
            >
              <span className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium">{item.name}</span>
                <span className={item.fit === "weak" ? "text-muted" : item.fit === "conditional" ? "text-brass" : "text-pine"}>
                  {FIT_LABEL[item.fit]}
                </span>
              </span>
              <span className="num mt-3 block font-serif text-2xl">{inrBand(item.amountLow, item.amountHigh)}</span>
              <span className="mt-1 block text-sm text-muted">
                {pct(item.rateLow)} – {pct(item.rateHigh)} · {item.tenure}
              </span>
              <span className="mt-3 block text-sm">{item.why}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Flows({ analysis }: { analysis: Analysis }) {
  const { open, setOpen } = useOpen();
  return (
    <div>
      <SectionTitle title="Recurring flows" aside={<span className="text-sm text-muted">EMIs, autopays, subscriptions, mobile pay</span>} />
      <ul>
        {analysis.flows.series.map((item) => (
          <li key={item.id} className="border-b border-rule">
            <button
              type="button"
              className={`grid w-full grid-cols-[1fr_auto] gap-3 py-2 text-left text-sm ${openMatch(open, { kind: "series", id: item.id }) ? "picked px-2" : ""}`}
              onClick={() => setOpen({ kind: "series", id: item.id })}
            >
              <span>
                <span className="font-medium">{item.name}</span>
                <span className="block text-muted">
                  {KIND_LABEL[item.kind]} · {item.rail} · {item.monthsSeen} of {item.monthsSpan} months
                  {item.bounced ? " · returned" : ""}
                </span>
              </span>
              <span className="num">{inr(item.typical, 0)}</span>
            </button>
          </li>
        ))}
      </ul>
      <h3 className="mb-2 mt-6 font-serif text-xl">Payment rails</h3>
      <ul>
        {analysis.flows.rails.map((rail) => (
          <li key={rail.rail} className="border-b border-rule">
            <button
              type="button"
              className={`grid w-full grid-cols-[6rem_1fr_1fr] gap-3 py-2 text-left text-sm ${openMatch(open, { kind: "rail", rail: rail.rail }) ? "picked px-2" : ""}`}
              onClick={() => setOpen({ kind: "rail", rail: rail.rail })}
            >
              <span className="font-medium">{rail.rail}</span>
              <span className="num text-muted">In {inrCompact(rail.inflow)}</span>
              <span className="num text-right text-muted">Out {inrCompact(rail.outflow)}</span>
            </button>
          </li>
        ))}
      </ul>
      <h3 className="mb-2 mt-6 font-serif text-xl">Month pattern</h3>
      <div className="overflow-x-auto">
        <table className="sheet-table min-w-[760px]">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">In</th>
              <th className="num">Out</th>
              <th className="num">UPI in</th>
              <th className="num">UPI out</th>
              <th className="num">EMI</th>
              <th className="num">Autopay</th>
              <th className="num">Subs</th>
            </tr>
          </thead>
          <tbody>
            {analysis.flows.months.map((month) => (
              <tr
                key={month.key}
                className={`cursor-pointer ${openMatch(open, { kind: "month", key: month.key }) ? "hit" : ""}`}
                onClick={() => setOpen({ kind: "month", key: month.key })}
              >
                <td>{month.label}</td>
                <td className="num">{inrCompact(month.inflow)}</td>
                <td className="num">{inrCompact(month.outflow)}</td>
                <td className="num">{inrCompact(month.upiIn)}</td>
                <td className="num">{inrCompact(month.upiOut)}</td>
                <td className="num">{month.emi ? inrCompact(month.emi) : "—"}</td>
                <td className="num">{month.autopay ? inrCompact(month.autopay) : "—"}</td>
                <td className="num">{month.subscription ? inrCompact(month.subscription) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Spending({ analysis }: { analysis: Analysis }) {
  const { open, setOpen } = useOpen();
  const { groups } = analysis;
  return (
    <div>
      <SectionTitle title="Where the money goes" aside={<span className="text-sm text-muted">Every row, grouped</span>} />
      <SpendSummary analysis={analysis} />
      <p className="mb-5 max-w-[46rem] text-sm">
        {groups.income[0]
          ? `Income is led by ${groups.income[0].name.toLowerCase()}, ${pct(groups.income[0].share)} of credits. `
          : null}
        Open a slice of either chart, or a group below, and follow it through to a single line.
      </p>
      <div className="grid gap-8 lg:grid-cols-2">
        <div>
          <h3 className="font-serif text-xl">Spending mix</h3>
          <SpendShareChart groups={groups.spend} onGroup={(id) => setOpen({ kind: "group", id })} />
        </div>
        <div>
          <h3 className="font-serif text-xl">Spending by month</h3>
          <SpendMonthChart report={groups} onMonth={(key) => setOpen({ kind: "month", key })} />
        </div>
      </div>
      <div className="mt-6 grid gap-10 lg:grid-cols-2">
        <GroupList title="Spending" groups={groups.spend} open={open} onOpen={(id) => setOpen({ kind: "group", id })} />
        <GroupList title="Income" groups={groups.income} open={open} onOpen={(id) => setOpen({ kind: "group", id })} />
      </div>
    </div>
  );
}

function GroupList({
  title,
  groups,
  open,
  onOpen,
}: {
  title: string;
  groups: Analysis["groups"]["spend"];
  open: ReturnType<typeof useOpen>["open"];
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <h3 className="mb-2 font-serif text-xl">{title}</h3>
      <ul>
        {groups.map((group) => (
          <li key={group.id} className="border-b border-rule">
            <button
              type="button"
              className={`block w-full py-2 text-left ${openMatch(open, { kind: "group", id: group.id }) ? "picked px-2" : ""}`}
              onClick={() => onOpen(group.id)}
            >
              <span className="flex items-baseline justify-between gap-3 text-sm">
                <span className="inline-flex items-center gap-2 font-medium">
                  <span className="inline-block h-2.5 w-2.5" style={{ background: group.color }} />
                  {group.name}
                </span>
                <span className="num">
                  {inrCompact(group.amount)}
                  <span className="ml-2 text-muted">{pct(group.share)}</span>
                </span>
              </span>
              <span className="mt-1 block text-sm text-muted">
                {group.merchants
                  .slice(0, 3)
                  .map((merchant) => merchant.name)
                  .join(" · ")}
                {group.merchants.length > 3 ? ` · ${group.merchants.length - 3} more` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Averages({ analysis }: { analysis: Analysis }) {
  const { open, setOpen } = useOpen();
  const m = analysis.metrics;
  const items = [
    { id: "earned", label: "Earned inflow", value: inrCompact(m.avgEarned), note: `median ${inrCompact(m.medianEarned)}` },
    { id: "cash", label: "Cash after operations", value: inrCompact(m.medianCashAfterOps), note: `surplus after EMI and rent ${inrCompact(m.medianSurplus)}` },
    { id: "obligations", label: "EMI + rent", value: pct(m.obligationRatio), note: "of average earned inflow" },
    { id: "bounces", label: "Returns, 6 months", value: String(m.bounces6m), note: `charges ${inr(m.bounceCharges, 0)}` },
    { id: "volatility", label: "Volatility", value: m.volatility.toFixed(2), note: `recent quarter ${signedPct(m.trend)}` },
    { id: "concentration", label: "Largest payer", value: pct(m.topShare), note: m.topName },
  ];
  return (
    <div>
      <SectionTitle title="Averages" aside={<span className="text-sm text-muted">Open any figure</span>} />
      <dl className="grid grid-cols-2 border-b border-rule md:grid-cols-3 xl:grid-cols-6">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`border-t border-rule py-3 pr-4 text-left ${openMatch(open, { kind: "metric", id: item.id }) ? "picked px-2" : ""}`}
            onClick={() => setOpen({ kind: "metric", id: item.id })}
          >
            <dt className="text-sm text-muted">{item.label}</dt>
            <dd className="num mt-1 text-2xl">{item.value}</dd>
            <dd className="text-sm text-muted">{item.note}</dd>
          </button>
        ))}
      </dl>
      <p className="mt-3 max-w-[46rem] text-sm text-muted">
        Drawings and personal spends averaged {inrCompact(m.drawingsAvg)} a month. They are not
        in the capacity maths. They do reduce the balance.
      </p>
    </div>
  );
}

function Cashflow({
  analysis,
  chart,
  onChart,
}: {
  analysis: Analysis;
  chart: ChartConfig;
  onChart: (chart: ChartConfig) => void;
}) {
  const { setOpen } = useOpen();
  return (
    <div>
      <SectionTitle
        title="Cash flow"
        aside={
          <div className="no-print flex gap-3 text-sm">
            {(["area", "bar", "line"] as const).map((type) => (
              <button
                key={type}
                type="button"
                className={chart.type === type ? "underline decoration-ink underline-offset-4" : "text-muted"}
                onClick={() => onChart({ ...chart, type })}
              >
                {type === "area" ? "Area" : type === "bar" ? "Bars" : "Lines"}
              </button>
            ))}
          </div>
        }
      />
      <CashflowChart months={analysis.months} config={chart} onMonth={(key) => setOpen({ kind: "month", key })} />
      <ul className="no-print mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {(Object.keys(SERIES_META) as ChartSeriesKey[]).map((key) => (
          <li key={key}>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={chart.series[key]}
                onChange={() =>
                  onChart({
                    ...chart,
                    series: { ...chart.series, [key]: !chart.series[key] },
                  })
                }
              />
              <span style={{ color: SERIES_META[key].color }}>{SERIES_META[key].label}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Credits({ analysis }: { analysis: Analysis }) {
  const { setOpen } = useOpen();
  return (
    <div>
      <SectionTitle title="Credits" />
      <CreditMixChart months={analysis.months} onMonth={(key) => setOpen({ kind: "month", key })} />
      <p className="mt-2 text-sm text-muted">
        Business receipts are gross, before returned cheques are taken back out of earned inflow.
      </p>
    </div>
  );
}

function Debits({ analysis }: { analysis: Analysis }) {
  const { open, setOpen } = useOpen();
  const max = Math.max(...analysis.outflowMix.map((row) => row.amount), 1);
  return (
    <div>
      <SectionTitle title="Debits" />
      <ul>
        {analysis.outflowMix.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              className={`grid w-full grid-cols-[9rem_1fr_5.5rem] items-center gap-3 border-b border-rule py-2 text-left text-sm ${openMatch(open, { kind: "metric", id: row.key }) ? "picked px-2" : ""}`}
              onClick={() => setOpen({ kind: "metric", id: row.key })}
            >
            <span>{row.label}</span>
            <span className="block h-2 bg-rule">
              <span className="block h-2 bg-ink" style={{ width: `${(row.amount / max) * 100}%` }} />
            </span>
            <span className="num text-right">{inrCompact(row.amount)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Payers({ analysis }: { analysis: Analysis }) {
  const { open, setOpen } = useOpen();
  const max = analysis.counterparties[0]?.amount ?? 1;
  return (
    <div>
      <SectionTitle title="Payers" aside={<span className="text-sm text-muted">Share of business receipts</span>} />
      <ul>
        {analysis.counterparties.map((row) => (
          <li key={row.name}>
            <button
              type="button"
              className={`grid w-full grid-cols-[1fr_auto] gap-x-4 border-b border-rule py-2 text-left text-sm ${openMatch(open, { kind: "payer", name: row.name }) ? "picked px-2" : ""}`}
              onClick={() => setOpen({ kind: "payer", name: row.name })}
            >
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <span>{row.name}</span>
                <span className="num text-muted">{row.count} credits</span>
              </div>
              <span className="mt-1 block h-2 bg-rule">
                <span className="block h-2 bg-pine" style={{ width: `${(row.amount / max) * 100}%` }} />
              </span>
            </div>
            <span className="num pt-0.5 text-right">
              {inrCompact(row.amount)}
              <span className="block text-muted">{pct(row.share)}</span>
            </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Reasons({ analysis }: { analysis: Analysis }) {
  const { open, setOpen } = useOpen();
  return (
    <div>
      <SectionTitle title="Notes" aside={<span className="text-sm text-muted">Open one to see the rows</span>} />
      <ul>
        {analysis.reasons.map((item) => (
          <li key={item.code} className="border-b border-rule">
            <button
              type="button"
              className={`block w-full py-3 text-left ${openMatch(open, { kind: "reason", code: item.code }) ? "picked px-2" : ""}`}
              onClick={() => setOpen({ kind: "reason", code: item.code })}
            >
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{item.title}</span>
                <span className={`text-sm ${item.severity === "breach" ? "text-rust" : item.severity === "watch" ? "text-brass" : "text-muted"}`}>
                  {item.severity === "breach" ? "Attention" : item.severity === "watch" ? "Watch" : "Note"}
                </span>
              </span>
              <span className="mt-1 block text-sm">{item.detail}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PolicyPanel({
  policy,
  onPolicy,
}: {
  policy: Policy;
  onPolicy: (policy: Policy) => void;
}) {
  const activePreset = POLICY_PRESETS.find((preset) => samePolicy(preset.policy, policy));
  return (
    <div>
      <SectionTitle title="Terms" />
      <div className="no-print flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {POLICY_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={activePreset?.id === preset.id ? "underline decoration-ink underline-offset-4" : "text-muted"}
            onClick={() => onPolicy(preset.policy)}
          >
            {preset.label}
          </button>
        ))}
        <button type="button" className="text-muted" onClick={() => onPolicy(STANDARD_POLICY)}>
          Reset
        </button>
      </div>
      <p className="mt-2 text-sm text-muted">{activePreset?.hint ?? "Custom terms for this file."}</p>
      <ul className="mt-4 space-y-4">
        {FIELDS.map((field) => (
          <li key={field.key}>
            <label className="flex items-baseline justify-between gap-3 text-sm">
              <span>{field.label}</span>
              <span className="num">{field.format(policy[field.key])}</span>
            </label>
            <input
              className="mt-2"
              type="range"
              min={field.min}
              max={field.max}
              step={field.step}
              value={policy[field.key]}
              onChange={(event) =>
                onPolicy({ ...policy, [field.key]: Number(event.target.value) })
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Readiness({ analysis }: { analysis: Analysis }) {
  return (
    <div>
      <SectionTitle title="What moved the readiness" />
      <ul className="grid gap-x-10 md:grid-cols-2">
        {analysis.grade.rules.map((rule) => (
          <li key={rule.id} className="grid grid-cols-[1fr_auto] gap-3 border-b border-rule py-2 text-sm">
            <span>
              {rule.label}
              <span className="block text-muted">{rule.note}</span>
            </span>
            <span className={`num ${rule.hit ? "text-rust" : "text-muted"}`}>{rule.hit ? rule.delta : "0"}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted">{analysis.capacity.basis}</p>
    </div>
  );
}

function Checks({ analysis }: { analysis: Analysis }) {
  return (
    <div>
      <SectionTitle title="Statement checks" />
      <ul className="grid gap-4 md:grid-cols-2">
        {analysis.integrity.map((check) => (
          <li key={check.id} className="border-t border-rule pt-3">
            <p className="flex items-baseline justify-between gap-3">
              <span className="font-medium">{check.label}</span>
              <span className={check.status === "fail" ? "text-rust" : check.status === "pass" ? "text-pine" : "text-muted"}>
                {check.status === "na" ? "Not available" : check.status === "pass" ? "Holds" : "Breaks"}
              </span>
            </p>
            <p className="text-sm text-muted">{check.detail}</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-muted">
        AI groups each narration. Unclassified credits are treated as business receipts
        ({pct(analysis.uncategorizedShare, 1)} of value stayed ungrouped).
      </p>
    </div>
  );
}

function Months({ analysis }: { analysis: Analysis }) {
  const { open, setOpen } = useOpen();
  return (
    <div>
      <SectionTitle title="Monthly figures" aside={<span className="text-sm text-muted">Open a month</span>} />
      <div className="overflow-x-auto">
        <table className="sheet-table min-w-[760px]">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Earned</th>
              <th className="num">Other credits</th>
              <th className="num">EMI + rent</th>
              <th className="num">Operating</th>
              <th className="num">Cash left</th>
              <th className="num">Returns</th>
            </tr>
          </thead>
          <tbody>
            {analysis.months.map((month) => (
              <tr
                key={month.key}
                className={`cursor-pointer ${openMatch(open, { kind: "month", key: month.key }) ? "hit" : ""}`}
                onClick={() => setOpen({ kind: "month", key: month.key })}
              >
                <td>{month.label}</td>
                <td className="num">{inr(month.earned, 0)}</td>
                <td className="num">{inr(month.totalIn - month.businessCredits, 0)}</td>
                <td className="num">{inr(month.obligations, 0)}</td>
                <td className="num">{inr(month.operating, 0)}</td>
                <td className={`num ${month.cashAfterOps < 0 ? "text-rust" : ""}`}>{inr(month.cashAfterOps, 0)}</td>
                <td className="num">{month.bounceCount || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Rows({ analysis }: { analysis: Analysis }) {
  const { open, setOpen, txnId, setTxn } = useOpen();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const categories = useMemo(
    () => [...new Set(analysis.txns.map((txn) => txn.category))].sort(),
    [analysis.txns],
  );
  const ids = focusIds(analysis, open);
  const evidence = new Set(ids ?? []);
  const rows = analysis.txns.filter((txn) => {
    if (ids && ids.length && !evidence.has(txn.id)) return false;
    if (category !== "all" && txn.category !== category) return false;
    if (!query.trim()) return true;
    const hay = `${txn.description} ${txn.counterparty} ${txn.category} ${groupName(analysis.groups, txn.id)}`.toLowerCase();
    return hay.includes(query.trim().toLowerCase());
  });

  return (
    <div>
      <SectionTitle
        title="Rows"
        aside={<span className="text-sm text-muted">{rows.length} shown</span>}
      />
      <div className="no-print mb-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          Search
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mt-1 block border border-rule bg-sheet px-2 py-1.5"
          />
        </label>
        <label className="text-sm">
          Tag
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="mt-1 block border border-rule bg-sheet px-2 py-1.5"
          >
            <option value="all">All tags</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {CATEGORY_LABEL[item] ?? item}
              </option>
            ))}
          </select>
        </label>
        {open ? (
          <button type="button" className="text-sm underline underline-offset-4" onClick={() => setOpen(null)}>
            Clear “{openLabel(analysis, open)}”
          </button>
        ) : null}
      </div>
      {open && ids && !ids.length ? (
        <p className="mb-3 text-sm text-muted">This figure covers the whole file, so every row stays visible.</p>
      ) : null}
      <div className="max-h-[520px] overflow-auto">
        <table className="sheet-table min-w-[820px]">
          <thead className="sticky top-0 bg-paper">
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Tag</th>
              <th className="num">Credit</th>
              <th className="num">Debit</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((txn) => (
              <tr
                key={txn.id}
                className={`clickable ${txnId === txn.id || evidence.has(txn.id) ? "hit" : ""}`}
                onClick={() => setTxn(txn.id)}
              >
                <td className="whitespace-nowrap">{prettyDate(txn.date)}</td>
                <td>
                  {txn.description}
                  <span className="block text-muted">{txn.counterparty}</span>
                </td>
                <td className="whitespace-nowrap text-muted">{groupName(analysis.groups, txn.id) || CATEGORY_LABEL[txn.category]}</td>
                <td className="num">{txn.credit ? inr(txn.credit, 0) : ""}</td>
                <td className="num">{txn.debit ? inr(txn.debit, 0) : ""}</td>
                <td className="num">{txn.balance == null ? "—" : inr(txn.balance, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Arrange({
  widgets,
  onWidgets,
}: {
  widgets: WidgetSetting[];
  onWidgets: (widgets: WidgetSetting[]) => void;
}) {
  function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= widgets.length) return;
    const copy = [...widgets];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    onWidgets(copy);
  }

  return (
    <div className="no-print mt-6 border border-ink bg-sheet px-4 py-3">
      <p className="text-sm text-muted">Show, hide, and reorder. This sitting only, stored in this browser.</p>
      <ul className="mt-2">
        {widgets.map((widget, index) => (
          <li key={widget.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-rule py-2 text-sm">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={widget.visible}
                onChange={() =>
                  onWidgets(widgets.map((item) => (item.id === widget.id ? { ...item, visible: !item.visible } : item)))
                }
              />
              {WIDGET_META[widget.id].title}
            </label>
            <span className="flex gap-3">
              <button type="button" onClick={() => move(index, -1)} disabled={index === 0}>
                Up
              </button>
              <button type="button" onClick={() => move(index, 1)} disabled={index === widgets.length - 1}>
                Down
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const FIELDS: {
  key: keyof Policy;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}[] = [
  { key: "maxObligationRatio", label: "EMI + rent, max share of earned inflow", min: 0.1, max: 0.8, step: 0.01, format: (value) => pct(value) },
  { key: "maxBounces6m", label: "Returns allowed in 6 months", min: 0, max: 6, step: 1, format: (value) => String(value) },
  { key: "minMonths", label: "Minimum months", min: 3, max: 18, step: 1, format: (value) => String(value) },
  { key: "maxConcentration", label: "Largest payer, max share", min: 0.2, max: 0.9, step: 0.01, format: (value) => pct(value) },
  { key: "surplusShare", label: "Share of cash left used as a new EMI", min: 0.1, max: 0.6, step: 0.01, format: (value) => pct(value) },
  { key: "annualRate", label: "Annual interest", min: 0.12, max: 0.36, step: 0.01, format: (value) => pct(value) },
  { key: "tenureMonths", label: "Tenure, months", min: 6, max: 36, step: 1, format: (value) => String(value) },
  { key: "minAvgInflow", label: "Minimum average earned inflow", min: 50000, max: 500000, step: 10000, format: inrCompact },
];

function samePolicy(a: Policy, b: Policy) {
  return (Object.keys(a) as (keyof Policy)[]).every((key) => a[key] === b[key]);
}
