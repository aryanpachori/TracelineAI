"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Report } from "@/components/analyze/report";
import { UploadPanel } from "@/components/analyze/upload-panel";
import { analyze } from "@/lib/analyze";
import { parseStatement } from "@/lib/parseStatement";
import { DEFAULT_CHART, DEFAULT_WIDGETS, STANDARD_POLICY } from "@/lib/policy";
import { SAMPLE_CASE, sampleCsv } from "@/lib/sample";
import type { AiReading, ChartConfig, Policy, TxnInput, WidgetSetting } from "@/lib/types";

const STORAGE_KEY = "traceline-desk-v1";
const ANALYZE_URL = process.env.NEXT_PUBLIC_ANALYZE_URL || "http://127.0.0.1:8001/analyze";
const DESK_EVENT = "traceline-desk";

type Desk = {
  chart: ChartConfig;
  widgets: WidgetSetting[];
};

const EMPTY_DESK: Desk = { chart: DEFAULT_CHART, widgets: DEFAULT_WIDGETS };
let deskCache: { raw: string | null; desk: Desk } = { raw: null, desk: EMPTY_DESK };

function subscribeDesk(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(DESK_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(DESK_EVENT, onStoreChange);
  };
}

function deskSnapshot(): Desk {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === deskCache.raw) return deskCache.desk;
  deskCache = { raw, desk: readDesk() ?? EMPTY_DESK };
  return deskCache.desk;
}

function writeDesk(desk: Desk) {
  const raw = JSON.stringify(desk);
  window.localStorage.setItem(STORAGE_KEY, raw);
  deskCache = { raw, desk };
  window.dispatchEvent(new Event(DESK_EVENT));
}

export function AnalyzeApp() {
  const params = useSearchParams();
  const reduce = useReducedMotion();
  const sampleOn = params.get("sample") === "1";
  const desk = useSyncExternalStore(subscribeDesk, deskSnapshot, () => EMPTY_DESK);
  const [trackedSample, setTrackedSample] = useState(sampleOn);
  const [rows, setRows] = useState<TxnInput[] | null>(() => (sampleOn ? parseStatement(sampleCsv()).rows : null));
  const [reading, setReading] = useState<AiReading | null>(null);
  const [fileName, setFileName] = useState(() => (sampleOn ? SAMPLE_CASE.fileName : ""));
  const [caseRef, setCaseRef] = useState(() => (sampleOn ? SAMPLE_CASE.reference : ""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyFile, setBusyFile] = useState("");
  const [policy, setPolicy] = useState<Policy>(STANDARD_POLICY);

  if (sampleOn !== trackedSample) {
    setTrackedSample(sampleOn);
    if (sampleOn) {
      const parsed = parseStatement(sampleCsv());
      setRows(parsed.rows);
      setFileName(SAMPLE_CASE.fileName);
      setCaseRef(SAMPLE_CASE.reference);
      setReading(null);
      setError(null);
    } else {
      setRows(null);
      setReading(null);
      setFileName("");
    }
  }

  const analysis = useMemo(() => (rows ? analyze(rows, policy, reading) : null), [rows, policy, reading]);

  function openText(text: string, name: string, reference: string) {
    const parsed = parseStatement(text);
    if (parsed.error || !parsed.rows.length) {
      setError(parsed.error ?? "No transactions found.");
      return;
    }
    setError(parsed.skipped ? `${parsed.skipped} rows skipped.` : null);
    setReading(null);
    setRows(parsed.rows);
    setFileName(name);
    setCaseRef(reference);
  }

  async function openUpload(file: File, reference: string) {
    setBusy(true);
    setBusyFile(file.name);
    setError(null);
    const body = new FormData();
    body.append("file", file);
    body.append("case_ref", reference);
    try {
      const response = await fetch(ANALYZE_URL, { method: "POST", body });
      const payload = (await response.json()) as {
        detail?: string | { msg: string }[];
        rows?: TxnInput[];
        reading?: AiReading;
        fileName?: string;
      };
      if (!response.ok || !payload.rows?.length || !payload.reading) {
        const detail = typeof payload.detail === "string" ? payload.detail : "The statement could not be read.";
        setError(detail);
        return;
      }
      setRows(payload.rows);
      setReading(payload.reading);
      setFileName(payload.fileName || file.name);
      setCaseRef(reference);
    } catch {
      setError("The local reader is not running. Start it, then send the file again.");
    } finally {
      setBusy(false);
      setBusyFile("");
    }
  }

  return (
    <div>
      <header className="border-b border-rule bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1080px] items-center justify-between gap-6 px-5 py-3.5">
          <Link href="/" className="text-[1.2rem] font-semibold tracking-[-0.04em] text-pine">
            Traceline
          </Link>
          <Link href="/#method" className="text-sm">
            Method
          </Link>
        </div>
      </header>
      <AnimatePresence mode="wait">
        {analysis ? (
          <motion.div
            key="report"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {error ? <p className="mx-auto max-w-[1080px] px-5 pt-4 text-sm text-brass">{error}</p> : null}
            <Report
              analysis={analysis}
              policy={policy}
              onPolicy={setPolicy}
              caseRef={caseRef}
              fileName={fileName}
              chart={desk.chart}
              onChart={(chart) => writeDesk({ chart, widgets: desk.widgets })}
              widgets={desk.widgets}
              onWidgets={(widgets) => writeDesk({ chart: desk.chart, widgets })}
              onReset={() => {
                setRows(null);
                setReading(null);
                setError(null);
                setPolicy(STANDARD_POLICY);
              }}
            />
          </motion.div>
        ) : (
          <motion.div
            key="upload"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <UploadPanel onFile={openText} onUpload={openUpload} error={error} busy={busy} busyFile={busyFile} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function readDesk(): Desk | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Desk;
    if (!parsed.chart || !Array.isArray(parsed.widgets)) return null;
    const known = new Set(DEFAULT_WIDGETS.map((widget) => widget.id));
    const widgets = parsed.widgets.filter((widget) => known.has(widget.id));
    DEFAULT_WIDGETS.forEach((widget, index) => {
      if (!widgets.some((item) => item.id === widget.id)) {
        widgets.splice(Math.min(index, widgets.length), 0, widget);
      }
    });
    return {
      chart: {
        type: parsed.chart.type ?? DEFAULT_CHART.type,
        series: { ...DEFAULT_CHART.series, ...parsed.chart.series },
      },
      widgets,
    };
  } catch {
    return null;
  }
}
