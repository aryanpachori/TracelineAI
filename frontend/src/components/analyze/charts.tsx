"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { inrCompact } from "@/lib/format";
import { SERIES_META } from "@/lib/policy";
import type { ChartConfig, ChartSeriesKey, GroupReport, MonthPoint } from "@/lib/types";

const AXIS = { fill: "#5c6d84", fontSize: 12 };

export function CashflowChart({
  months,
  config,
  onMonth,
}: {
  months: MonthPoint[];
  config: ChartConfig;
  onMonth?: (key: string) => void;
}) {
  const data = months.map((month) => ({
    key: month.key,
    label: month.label,
    earned: Math.round(month.earned),
    cashAfterOps: Math.round(month.cashAfterOps),
    obligations: Math.round(month.obligations),
    totalIn: Math.round(month.totalIn),
  }));

  const keys = (Object.keys(config.series) as ChartSeriesKey[]).filter((key) => config.series[key]);
  const chart = (
    <>
      <CartesianGrid stroke="#e4edf6" vertical={false} />
      <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: "#d9e3ef" }} />
      <YAxis
        tick={AXIS}
        tickLine={false}
        axisLine={false}
        width={64}
        tickFormatter={(value: number) => inrCompact(value)}
      />
      <Tooltip content={<Tip />} cursor={{ stroke: "#0c9a74", strokeWidth: 1 }} />
      {keys.map((key) =>
        config.type === "bar" ? (
          <Bar key={key} dataKey={key} name={SERIES_META[key].label} fill={SERIES_META[key].color} maxBarSize={18} />
        ) : config.type === "line" ? (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            name={SERIES_META[key].label}
            stroke={SERIES_META[key].color}
            strokeWidth={1.75}
            dot={false}
          />
        ) : (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            name={SERIES_META[key].label}
            stroke={SERIES_META[key].color}
            fill={SERIES_META[key].color}
            fillOpacity={0.08}
            strokeWidth={1.75}
          />
        ),
      )}
    </>
  );

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        {config.type === "bar" ? (
          <BarChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }} onClick={(state) => pickMonth(state, onMonth)}>
            {chart}
          </BarChart>
        ) : config.type === "line" ? (
          <LineChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }} onClick={(state) => pickMonth(state, onMonth)}>
            {chart}
          </LineChart>
        ) : (
          <AreaChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }} onClick={(state) => pickMonth(state, onMonth)}>
            {chart}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export function CreditMixChart({
  months,
  onMonth,
}: {
  months: MonthPoint[];
  onMonth?: (key: string) => void;
}) {
  const data = months.map((month) => ({
    key: month.key,
    label: month.label,
    Business: Math.round(month.businessCredits),
    Loans: Math.round(month.loanIn),
    "Self and transfers": Math.round(month.selfAndTransferIn),
    Cash: Math.round(month.cashIn),
  }));

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }} onClick={(state) => pickMonth(state, onMonth)}>
          <CartesianGrid stroke="#e4edf6" vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: "#d9e3ef" }} />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={64}
            tickFormatter={(value: number) => inrCompact(value)}
          />
          <Tooltip content={<Tip />} cursor={{ fill: "rgba(28, 25, 21, 0.04)" }} />
          <Bar dataKey="Business" stackId="credits" fill="#0c9a74" maxBarSize={22} />
          <Bar dataKey="Loans" stackId="credits" fill="#e11d48" maxBarSize={22} />
          <Bar dataKey="Self and transfers" stackId="credits" fill="#d97706" maxBarSize={22} />
          <Bar dataKey="Cash" stackId="credits" fill="#2563eb" maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SpendShareChart({
  groups,
  onGroup,
}: {
  groups: GroupReport["spend"];
  onGroup?: (id: string) => void;
}) {
  const data = groups.filter((group) => group.amount > 0);
  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="amount"
            nameKey="name"
            innerRadius={62}
            outerRadius={104}
            paddingAngle={1}
            stroke="#ffffff"
            onClick={(entry) => {
              const id = readId(entry);
              if (id) onGroup?.(id);
            }}
          >
            {data.map((group) => (
              <Cell key={group.id} fill={group.color} />
            ))}
          </Pie>
          <Tooltip content={<Tip />} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SpendMonthChart({
  report,
  onMonth,
}: {
  report: GroupReport;
  onMonth?: (key: string) => void;
}) {
  const keys = [...report.chartIds, "rest"];
  const names = new Map(report.spend.map((group) => [group.id, group.name]));
  names.set("rest", "Other spending");
  const data = report.months.map((month) => {
    const row: Record<string, string | number> = { key: month.key, label: month.label };
    keys.forEach((id) => {
      row[id] = Math.round(month.values[id] ?? 0);
    });
    return row;
  });
  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }} onClick={(state) => pickMonth(state, onMonth)}>
          <CartesianGrid stroke="#e4edf6" vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: "#d9e3ef" }} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={(value: number) => inrCompact(value)} />
          <Tooltip content={<Tip />} />
          {keys.map((id) => (
            <Bar
              key={id}
              dataKey={id}
              name={names.get(id) ?? id}
              stackId="spend"
              fill={report.spend.find((group) => group.id === id)?.color ?? "#c4bdb2"}
              maxBarSize={22}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function readId(entry: unknown) {
  const row = entry as { id?: string; payload?: { id?: string } } | null;
  return row?.id ?? row?.payload?.id;
}

function pickMonth(state: unknown, onMonth?: (key: string) => void) {
  const payload = (state as { activePayload?: Array<{ payload?: { key?: string } }> } | null)?.activePayload;
  const key = payload?.[0]?.payload?.key;
  if (key) onMonth?.(key);
}

function Tip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="border border-ink bg-sheet px-3 py-2 text-sm">
      {label ? <p className="font-serif">{label}</p> : null}
      <ul className="mt-1 space-y-0.5">
        {payload.map((item) => (
          <li key={String(item.name)} className="flex items-baseline justify-between gap-6">
            <span className="text-muted">{item.name}</span>
            <span className="num">{inrCompact(Number(item.value ?? 0))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
