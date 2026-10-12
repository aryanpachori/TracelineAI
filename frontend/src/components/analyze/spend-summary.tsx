"use client";

import { useMemo } from "react";
import { useOpen } from "@/components/analyze/depth";
import { inr, pct } from "@/lib/format";
import { buildSpendBrief, writeSpendSummary } from "@/lib/spend-summary";
import type { Analysis } from "@/lib/types";

export function SpendSummary({ analysis }: { analysis: Analysis }) {
  const { setOpen } = useOpen();
  const brief = useMemo(() => buildSpendBrief(analysis), [analysis]);
  const text = useMemo(() => writeSpendSummary(brief), [brief]);
  const lead = brief.top[0];

  return (
    <div className="mb-5 rounded-2xl border border-rule bg-[#e7f8f2] px-4 py-4">
      <p className="text-sm font-semibold text-pine">AI spending summary</p>
      <p className="mt-2 max-w-[48rem]">{text}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Fact label="Kind of spender" value={brief.kind} />
        {lead ? (
          <button type="button" className="text-left" onClick={() => setOpen({ kind: "group", id: lead.id })}>
            <Fact label="Spent most on" value={`${lead.name} · ${pct(lead.share)}`} link />
          </button>
        ) : null}
        {brief.peakMonth.key ? (
          <button type="button" className="text-left" onClick={() => setOpen({ kind: "month", key: brief.peakMonth.key })}>
            <Fact label="Heaviest month" value={`${brief.peakMonth.label} · ${inr(brief.peakMonth.amount, 0)}`} link />
          </button>
        ) : null}
      </div>
      <p className="mt-3 text-sm text-muted">Written from the grouped spends on this statement. The rows stay in this browser.</p>
    </div>
  );
}

function Fact({ label, value, link }: { label: string; value: string; link?: boolean }) {
  return (
    <span className="block border-t border-[#b7e6d6] pt-2">
      <span className="block text-xs text-muted">{label}</span>
      <span className={`mt-1 block font-medium ${link ? "underline decoration-[#9ed9c4] underline-offset-4" : ""}`}>{value}</span>
    </span>
  );
}
