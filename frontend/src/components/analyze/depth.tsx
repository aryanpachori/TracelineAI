"use client";

import { useEffect, useState, createContext, useContext, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { explainTxn } from "@/lib/explain";
import { CATEGORY_LABEL, inr, inrCompact, pct, prettyDate } from "@/lib/format";
import { railOf } from "@/lib/flows";
import type { Analysis, FacilityFit, SeriesKind } from "@/lib/types";

export type OpenRef =
  | { kind: "series"; id: string }
  | { kind: "facility"; id: string }
  | { kind: "rail"; rail: string }
  | { kind: "payer"; name: string }
  | { kind: "month"; key: string }
  | { kind: "metric"; id: string }
  | { kind: "reason"; code: string }
  | { kind: "group"; id: string }
  | { kind: "merchant"; groupId: string; name: string };

export type Crumb = { kind: "scope"; open: OpenRef } | { kind: "txn"; id: string };

type OpenContextValue = {
  open: OpenRef | null;
  setOpen: (open: OpenRef | null) => void;
  txnId: string | null;
  setTxn: (id: string | null) => void;
  trail: Crumb[];
  goTo: (index: number) => void;
};

const OpenContext = createContext<OpenContextValue | null>(null);

function sameOpen(a: OpenRef, b: OpenRef) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isChild(parent: OpenRef, next: OpenRef) {
  return parent.kind === "group" && next.kind === "merchant" && next.groupId === parent.id;
}

function isSibling(current: OpenRef, next: OpenRef) {
  return current.kind === "merchant" && next.kind === "merchant" && current.groupId === next.groupId;
}

export function OpenProvider({ children }: { children: ReactNode }) {
  const [trail, setTrail] = useState<Crumb[]>([]);
  const last = trail.at(-1);
  const txnId = last?.kind === "txn" ? last.id : null;
  const scope = [...trail].reverse().find((crumb) => crumb.kind === "scope");
  const open = scope?.kind === "scope" ? scope.open : null;

  const setOpen = (next: OpenRef | null) => {
    setTrail((current) => {
      if (!next) return [];
      const scopes = current.filter((crumb) => crumb.kind === "scope");
      const hit = scopes.findIndex((crumb) => sameOpen(crumb.open, next));
      if (hit >= 0) {
        let seen = -1;
        const cut = current.findIndex((crumb) => {
          if (crumb.kind === "scope") seen += 1;
          return seen === hit;
        });
        return current.slice(0, cut + 1);
      }
      const lastScope = [...current].reverse().find((crumb) => crumb.kind === "scope");
      const base = current.filter((crumb) => crumb.kind !== "txn");
      if (lastScope?.kind === "scope" && isChild(lastScope.open, next)) {
        return [...base, { kind: "scope", open: next }];
      }
      if (lastScope?.kind === "scope" && isSibling(lastScope.open, next)) {
        return [...base.slice(0, -1), { kind: "scope", open: next }];
      }
      return [{ kind: "scope", open: next }];
    });
  };

  const setTxn = (id: string | null) => {
    setTrail((current) => {
      const base = current.filter((crumb) => crumb.kind !== "txn");
      if (!id) return base;
      return [...base, { kind: "txn", id }];
    });
  };

  const goTo = (index: number) => {
    setTrail((current) => current.slice(0, index + 1));
  };

  return <OpenContext.Provider value={{ open, setOpen, txnId, setTxn, trail, goTo }}>{children}</OpenContext.Provider>;
}

export function useOpen() {
  const value = useContext(OpenContext);
  if (!value) throw new Error("Reading is only available inside the credit file.");
  return value;
}

export function openMatch(open: OpenRef | null, next: OpenRef) {
  if (!open || open.kind !== next.kind) return false;
  return JSON.stringify(open) === JSON.stringify(next);
}

const KIND_LABEL: Record<SeriesKind, string> = {
  emi: "EMI",
  autopay: "Autopay",
  subscription: "Subscription",
  standing: "Standing payment",
  repeat: "Repeat debit",
};

const FIT_LABEL: Record<FacilityFit, string> = {
  strong: "Strong fit",
  conditional: "Conditional",
  weak: "Weak fit",
};

export function TrailBar({ analysis }: { analysis: Analysis }) {
  const { trail, goTo, setOpen } = useOpen();
  const reduce = useReducedMotion();
  const last = trail.at(-1);
  const txn = last?.kind === "txn" ? analysis.txns.find((item) => item.id === last.id) : undefined;

  return (
    <AnimatePresence>
      {trail.length ? (
        <motion.div
          className="fixed inset-0 z-30 flex items-center justify-center p-4"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
        >
          <button
            type="button"
            className="absolute inset-0 bg-[#12233a]/40"
            aria-label="Close"
            onClick={() => setOpen(null)}
          />
          <div className="relative flex max-h-[min(82vh,40rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-rule bg-white shadow-[0_24px_60px_rgba(18,35,58,0.22)]">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Depth analysis={analysis} />
            </div>
            <div className="flex items-start gap-4 border-t border-rule px-4 py-3">
              <div className="min-w-0 flex-1">
                <nav className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm" aria-label="How you got here">
                  <button type="button" className="text-muted underline underline-offset-4" onClick={() => setOpen(null)}>
                    This file
                  </button>
                  {trail.map((crumb, index) => {
                    const label = crumb.kind === "scope" ? openLabel(analysis, crumb.open) : txn && crumb.id === txn.id ? prettyDate(txn.date) : "Transaction";
                    const current = index === trail.length - 1;
                    return (
                      <span key={`${crumb.kind}-${index}`} className="inline-flex items-center gap-1.5">
                        <span className="text-muted">/</span>
                        <button
                          type="button"
                          className={current ? "font-semibold" : "text-muted underline underline-offset-4"}
                          onClick={() => goTo(index)}
                        >
                          {label}
                        </button>
                      </span>
                    );
                  })}
                </nav>
              </div>
              <button type="button" className="shrink-0 text-sm text-muted underline underline-offset-4" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function Depth({ analysis }: { analysis: Analysis }) {
  const { open, setOpen, txnId, setTxn } = useOpen();
  const txn = analysis.txns.find((item) => item.id === txnId) ?? null;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (txnId) setTxn(null);
        else setOpen(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen, setTxn, txnId]);

  if (txn) {
    const detail = explainTxn(analysis, txn);
    return (
      <section id="reading" className="px-5 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-sm text-muted">Transaction</p>
          <div className="flex gap-4 text-sm">
            {open ? (
              <button type="button" className="underline underline-offset-4" onClick={() => setTxn(null)}>
                Back to {openLabel(analysis, open)}
              </button>
            ) : null}
            <button type="button" className="underline underline-offset-4" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="num font-serif text-5xl leading-none">{detail.amount}</p>
            <p className="mt-2 text-muted">
              {prettyDate(txn.date)} · {detail.party === "this name" ? txn.description : detail.party}
            </p>
          </div>
          <p className={`text-sm font-medium ${detail.direction === "out" ? "text-rust" : "text-pine"}`}>
            {detail.direction === "out" ? "Money out" : "Money in"}
          </p>
        </div>
        <p className="mt-4 max-w-[46rem] text-[1.05rem]">{detail.purpose}</p>
        <ul className="mt-4 flex flex-wrap gap-2">
          {detail.tags.map((tag) => (
            <li key={tag} className="tag">
              {tag}
            </li>
          ))}
        </ul>
        <p className="mt-4 border border-rule bg-paper px-3 py-2 text-sm">
          <span className="text-muted">Narration · </span>
          {txn.description}
          {txn.balance != null ? <span className="num mt-1 block text-muted">Balance after {inr(txn.balance, 0)}</span> : null}
        </p>
        {detail.group ? (
          <button
            type="button"
            className="mt-4 text-sm underline underline-offset-4"
            onClick={() => setOpen({ kind: "group", id: detail.group!.id })}
          >
            All {detail.group.name.toLowerCase()} rows
          </button>
        ) : null}
      </section>
    );
  }

  if (!open) return null;
  const view = buildView(analysis, open);
  const rows = analysis.txns.filter((txn) => view.txnIds.includes(txn.id)).slice(0, 8);

  return (
    <section id="reading" className="px-5 py-5">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm text-muted">AI reading</p>
        <button type="button" className="text-sm underline underline-offset-4" onClick={() => setOpen(null)}>
          Close
        </button>
      </div>
      <h2 className="mt-2 font-serif text-3xl font-normal leading-tight">{view.title}</h2>
      <p className="mt-3 max-w-[46rem]">{view.reading}</p>
      <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {view.facts.map((fact) => (
          <div key={fact.label} className="border-t border-rule pt-2">
            <dt className="text-sm text-muted">{fact.label}</dt>
            <dd className="num mt-1">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {view.merchants?.length ? (
        <table className="sheet-table mt-5">
          <thead>
            <tr>
              <th>Inside this group</th>
              <th className="num">Times</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {view.merchants.map((merchant) => (
              <tr
                key={merchant.name}
                className="clickable"
                onClick={() =>
                  view.groupId
                    ? setOpen({ kind: "merchant", groupId: view.groupId, name: merchant.name })
                    : setOpen({ kind: "payer", name: merchant.name })
                }
              >
                <td>{merchant.name}</td>
                <td className="num">{merchant.count}</td>
                <td className="num">{inr(merchant.amount, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {rows.length ? (
        <table className="sheet-table mt-5">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((txn) => (
              <tr key={txn.id} className="clickable" onClick={() => setTxn(txn.id)}>
                <td className="whitespace-nowrap">{prettyDate(txn.date)}</td>
                <td>
                  {txn.description}
                  <span className="mt-1 flex flex-wrap gap-1">
                    <span className="tag">{CATEGORY_LABEL[txn.category]}</span>
                    <span className="tag">{railOf(txn.description)}</span>
                  </span>
                </td>
                <td className="num">{inr(txn.credit || txn.debit, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-4 text-sm text-muted">This figure covers the whole file. The monthly table and the rows below carry the detail.</p>
      )}
    </section>
  );
}

export function focusIds(analysis: Analysis, open: OpenRef | null) {
  if (!open) return null;
  return buildView(analysis, open).txnIds;
}

export function openLabel(analysis: Analysis, open: OpenRef) {
  return buildView(analysis, open).title;
}

function buildView(analysis: Analysis, open: OpenRef): View {
  if (open.kind === "merchant") {
    const group = [...analysis.groups.spend, ...analysis.groups.income].find((item) => item.id === open.groupId);
    const merchant = group?.merchants.find((item) => item.name === open.name);
    return {
      title: open.name,
      groupId: open.groupId,
      reading: merchant
        ? `${open.name} appears ${merchant.count} ${merchant.count === 1 ? "time" : "times"} inside ${group?.name.toLowerCase() ?? "this group"}, totalling ${inr(merchant.amount, 0)}. Open a line to see its tags and what it was for.`
        : `${open.name} inside this group.`,
      facts: [
        { label: "Amount", value: inr(merchant?.amount ?? 0, 0) },
        { label: "Rows", value: String(merchant?.count ?? 0) },
        { label: "Group", value: group?.name ?? "—" },
      ],
      txnIds: merchant?.txnIds ?? [],
    };
  }

  if (open.kind === "group") {
    const group = [...analysis.groups.spend, ...analysis.groups.income].find((item) => item.id === open.id);
    if (!group) return empty("This group");
    const lead = group.merchants[0];
    return {
      title: group.name,
      groupId: group.id,
      reading: `AI placed ${group.count} statement ${group.count === 1 ? "line" : "lines"} in ${group.name.toLowerCase()}, ${inr(group.amount, 0)} and ${pct(group.share)} of ${group.side === "out" ? "spending" : "income"}.${lead ? ` ${lead.name} is the largest name inside it, at ${inr(lead.amount, 0)} across ${lead.count} ${lead.count === 1 ? "row" : "rows"}.` : ""} Open a name, then a line, for the tags and what it was for.`,
      facts: [
        { label: "Amount", value: inr(group.amount, 0) },
        { label: "Share", value: pct(group.share) },
        { label: "Rows", value: String(group.count) },
        { label: "Names", value: String(group.merchants.length) },
      ],
      merchants: group.merchants,
      txnIds: group.txnIds,
    };
  }

  if (open.kind === "series") {
    const series = analysis.flows.series.find((item) => item.id === open.id);
    if (!series) return empty("This commitment");
    return {
      title: series.name,
      reading: `AI grouped this as a ${KIND_LABEL[series.kind].toLowerCase()} on ${series.rail}. It posts at ${inr(series.typical, 0)}, seen in ${series.monthsSeen} of ${series.monthsSpan} months${series.missed ? `, with ${series.missed} month${series.missed === 1 ? "" : "s"} missing` : ""}.`,
      facts: [
        { label: "Type", value: KIND_LABEL[series.kind] },
        { label: "Typical amount", value: inr(series.typical, 0) },
        { label: "Rail", value: series.rail },
        { label: "Last seen", value: prettyDate(series.lastDate) },
      ],
      txnIds: series.txnIds,
    };
  }

  if (open.kind === "facility") {
    const facility = analysis.flows.facilities.find((item) => item.id === open.id);
    if (!facility) return empty("This facility");
    const txnIds =
      facility.id === "upi"
        ? analysis.txns.filter((txn) => railOf(txn.description) === "UPI" && (txn.category === "business_in" || txn.category === "salary")).map((txn) => txn.id)
        : facility.id === "topup"
          ? analysis.flows.series.filter((item) => item.kind === "emi").flatMap((item) => item.txnIds)
          : analysis.flows.series.filter((item) => item.kind === "emi" || item.kind === "autopay" || item.kind === "subscription").flatMap((item) => item.txnIds);
    return {
      title: facility.name,
      reading: facility.reading,
      facts: [
        { label: "Fit", value: FIT_LABEL[facility.fit] },
        { label: "Amount", value: facility.amountHigh > 0 ? `${inrCompact(facility.amountLow)} – ${inrCompact(facility.amountHigh)}` : "Not available" },
        { label: "Rate", value: `${pct(facility.rateLow)} – ${pct(facility.rateHigh)}` },
        { label: "Tenure", value: facility.tenure },
      ],
      txnIds,
    };
  }

  if (open.kind === "rail") {
    const rail = analysis.flows.rails.find((item) => item.rail === open.rail);
    const txnIds = analysis.txns.filter((txn) => railOf(txn.description) === open.rail).map((txn) => txn.id);
    return {
      title: open.rail,
      reading: rail
        ? `AI separated ${open.rail} from the other payment rails. Inflow is ${inr(rail.inflow, 0)} across ${rail.inCount} credits. Outflow is ${inr(rail.outflow, 0)} across ${rail.outCount} debits.`
        : `No ${open.rail} rows were found.`,
      facts: [
        { label: "Inflow", value: inr(rail?.inflow ?? 0, 0) },
        { label: "Outflow", value: inr(rail?.outflow ?? 0, 0) },
        { label: "Credits", value: String(rail?.inCount ?? 0) },
        { label: "Debits", value: String(rail?.outCount ?? 0) },
      ],
      txnIds,
    };
  }

  if (open.kind === "payer") {
    const payer = analysis.counterparties.find((item) => item.name === open.name);
    const txnIds = analysis.txns.filter((txn) => txn.counterparty === open.name).map((txn) => txn.id);
    return {
      title: open.name,
      reading: payer
        ? `${open.name} accounts for ${pct(payer.share)} of business receipts, ${inr(payer.amount, 0)} across ${payer.count} credits.`
        : `Rows for ${open.name}.`,
      facts: [
        { label: "Receipts", value: inr(payer?.amount ?? 0, 0) },
        { label: "Share", value: pct(payer?.share ?? 0) },
        { label: "Credits", value: String(payer?.count ?? txnIds.length) },
        { label: "Rows", value: String(txnIds.length) },
      ],
      txnIds,
    };
  }

  if (open.kind === "month") {
    const month = analysis.months.find((item) => item.key === open.key);
    const pattern = analysis.flows.months.find((item) => item.key === open.key);
    const txnIds = analysis.txns.filter((txn) => txn.date.startsWith(open.key)).map((txn) => txn.id);
    return {
      title: month?.label ?? open.key,
      reading: month
        ? `Earned inflow was ${inr(month.earned, 0)}. Cash left after operations was ${inr(month.cashAfterOps, 0)}. UPI inflow was ${inr(pattern?.upiIn ?? 0, 0)}, with EMI ${inr(pattern?.emi ?? month.emi, 0)} and subscriptions ${inr(pattern?.subscription ?? 0, 0)}.`
        : "This month.",
      facts: [
        { label: "Earned", value: inr(month?.earned ?? 0, 0) },
        { label: "Cash left", value: inr(month?.cashAfterOps ?? 0, 0) },
        { label: "UPI in", value: inr(pattern?.upiIn ?? 0, 0) },
        { label: "Subscriptions", value: inr(pattern?.subscription ?? 0, 0) },
      ],
      txnIds,
    };
  }

  if (open.kind === "reason") {
    const reason = analysis.reasons.find((item) => item.code === open.code);
    return {
      title: reason?.title ?? "Note",
      reading: reason?.detail ?? "This note covers the file as a whole.",
      facts: [
        { label: "Weight", value: reason ? severityLabel(reason.severity) : "Note" },
        { label: "Rows", value: String(reason?.txnIds.length ?? 0) },
      ],
      txnIds: reason?.txnIds ?? [],
    };
  }

  return metricView(analysis, open.id);
}

function metricView(analysis: Analysis, id: string): View {
  const metrics = analysis.metrics;
  const byCategory = (categories: string[]) =>
    analysis.txns.filter((txn) => categories.includes(txn.category)).map((txn) => txn.id);

  if (id === "earned") {
    return {
      title: "Earned inflow",
      reading: `Average earned inflow is ${inr(metrics.avgEarned, 0)} a month. Loan credits, self-transfers, and cash deposits stay out. Returned cheques are taken back out.`,
      facts: [
        { label: "Average", value: inr(metrics.avgEarned, 0) },
        { label: "Median", value: inr(metrics.medianEarned, 0) },
      ],
      txnIds: byCategory(["business_in", "salary", "bounce_reversal"]),
    };
  }
  if (id === "cash") {
    return {
      title: "Cash after operations",
      reading: `A typical month leaves ${inr(metrics.medianCashAfterOps, 0)} after EMI, rent, suppliers, utilities, tax, and return charges. Personal drawings are shown separately.`,
      facts: [
        { label: "Median cash left", value: inr(metrics.medianCashAfterOps, 0) },
        { label: "After EMI and rent", value: inr(metrics.medianSurplus, 0) },
      ],
      txnIds: byCategory(["business_in", "salary", "emi", "rent", "supplier", "utilities", "tax", "bounce_charge", "bounce_reversal"]),
    };
  }
  if (id === "obligations" || id === "emi" || id === "rent") {
    const ids = id === "emi" ? ["emi"] : id === "rent" ? ["rent"] : ["emi", "rent"];
    return {
      title: id === "emi" ? "EMI" : id === "rent" ? "Rent" : "EMI and rent",
      reading: `EMI and rent are ${pct(metrics.obligationRatio)} of average earned inflow.`,
      facts: [{ label: "Share of inflow", value: pct(metrics.obligationRatio) }],
      txnIds: byCategory(ids),
    };
  }
  if (id === "bounces") {
    return {
      title: "Returns",
      reading: `${metrics.bounces6m} return events in the last six months. Charges on the file come to ${inr(metrics.bounceCharges, 0)}.`,
      facts: [
        { label: "Last 6 months", value: String(metrics.bounces6m) },
        { label: "Charges", value: inr(metrics.bounceCharges, 0) },
      ],
      txnIds: byCategory(["bounce_reversal", "bounce_charge"]),
    };
  }
  if (id === "volatility") {
    return {
      title: "Volatility",
      reading: `Earned inflow moves with a coefficient of ${metrics.volatility.toFixed(2)}. The latest quarter is ${metrics.trend >= 0 ? "up" : "down"} ${Math.abs(Math.round(metrics.trend * 100))}% against the earlier months.`,
      facts: [
        { label: "Coefficient", value: metrics.volatility.toFixed(2) },
        { label: "Recent quarter", value: `${metrics.trend >= 0 ? "+" : ""}${Math.round(metrics.trend * 100)}%` },
      ],
      txnIds: [],
    };
  }
  if (id === "concentration") {
    return {
      title: metrics.topName,
      reading: `${metrics.topName} is ${pct(metrics.topShare)} of business receipts.`,
      facts: [{ label: "Share", value: pct(metrics.topShare) }],
      txnIds: analysis.txns.filter((txn) => txn.counterparty === metrics.topName && txn.credit > 0).map((txn) => txn.id),
    };
  }
  if (id === "suppliers") {
    return {
      title: "Suppliers",
      reading: "Supplier payments are taken out of cash left before a facility is sized.",
      facts: [{ label: "Rows", value: String(byCategory(["supplier"]).length) }],
      txnIds: byCategory(["supplier"]),
    };
  }
  if (id === "utilities") {
    return {
      title: "Utilities and tax",
      reading: "Utilities and tax leave the account before cash left is measured.",
      facts: [{ label: "Rows", value: String(byCategory(["utilities", "tax"]).length) }],
      txnIds: byCategory(["utilities", "tax"]),
    };
  }
  if (id === "drawings") {
    return {
      title: "Drawings and personal",
      reading: `Drawings averaged ${inr(metrics.drawingsAvg, 0)} a month. They are visible here and are not treated as a loan payment.`,
      facts: [{ label: "Average", value: inr(metrics.drawingsAvg, 0) }],
      txnIds: byCategory(["personal", "cash_out", "self_out"]),
    };
  }
  return empty("This figure");
}

function severityLabel(severity: "info" | "watch" | "breach") {
  if (severity === "breach") return "Attention";
  if (severity === "watch") return "Watch";
  return "Note";
}

function empty(title: string): View {
  return { title, reading: "Nothing further is attached to this figure.", facts: [], txnIds: [] };
}

type View = {
  title: string;
  reading: string;
  facts: { label: string; value: string }[];
  txnIds: string[];
  groupId?: string;
  merchants?: { name: string; amount: number; count: number; txnIds?: string[] }[];
};
