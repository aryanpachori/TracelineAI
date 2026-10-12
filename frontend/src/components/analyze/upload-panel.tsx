"use client";

import { useState } from "react";
import { PrivacyNote } from "@/components/analyze/privacy-note";
import { SAMPLE_CASE, sampleCsv } from "@/lib/sample";

export function UploadPanel({
  onFile,
  error,
}: {
  onFile: (text: string, fileName: string, caseRef: string) => void;
  error: string | null;
}) {
  const [caseRef, setCaseRef] = useState("");
  const [over, setOver] = useState(false);
  const [paste, setPaste] = useState("");

  function take(text: string, fileName: string) {
    onFile(text, fileName, caseRef.trim());
  }

  return (
    <div className="mx-auto max-w-[760px] px-5 py-12">
      <p className="text-sm text-muted">One statement. A full credit file.</p>
      <h1 className="mt-2 max-w-[18ch] font-serif text-5xl font-normal leading-[1.08]">
        Bring the bank statement.
      </h1>
      <p className="mt-4 max-w-[40rem] text-[1.05rem]">
        CSV, with a header row. Date, description, debit, credit, and balance if you have it.
        Indian dates (DD-MM-YYYY) are fine. AI splits the whole statement into income, spending, and a credit assessment.
      </p>
      <PrivacyNote />

      <label className="mt-8 block text-sm">
        Case reference, optional
        <input
          value={caseRef}
          onChange={(event) => setCaseRef(event.target.value)}
          placeholder="e.g. APP-1044"
          className="mt-1 block w-full max-w-sm border border-rule bg-sheet px-3 py-2"
        />
      </label>

      <label
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void readFile(file, take);
        }}
        className={`mt-6 block cursor-pointer border px-5 py-8 ${over ? "border-ink bg-sheet" : "border-rule bg-transparent"}`}
      >
        <span className="font-serif text-2xl">Drop a CSV here, or choose a file</span>
        <span className="mt-1 block text-sm text-muted">.csv or .txt</span>
        <input
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readFile(file, take);
          }}
        />
      </label>

      {error ? <p className="mt-4 text-rust">{error}</p> : null}

      <div className="mt-8 border-t border-rule pt-6">
        <h2 className="font-serif text-2xl font-normal">Or paste rows</h2>
        <textarea
          value={paste}
          onChange={(event) => setPaste(event.target.value)}
          rows={6}
          placeholder={"Date,Description,Debit,Credit,Balance\n01-04-2026,NEFT/BUYER,,50000,80000"}
          className="mt-3 w-full border border-rule bg-sheet px-3 py-2 text-sm"
        />
        <button
          type="button"
          className="mt-3 border border-ink px-3 py-1.5 disabled:opacity-40"
          disabled={!paste.trim()}
          onClick={() => take(paste, "pasted-statement.csv")}
        >
          Read pasted rows
        </button>
      </div>

      <div className="mt-10 border-t border-ink pt-6">
        <h2 className="font-serif text-2xl font-normal">No file yet</h2>
        <p className="mt-2 max-w-[40rem]">
          {SAMPLE_CASE.account}. October 2025 to September 2026. A returned cheque in July and
          another in August, a term-loan credit in December, and a transfer from the owner’s
          savings in March. Those last two are not income.
        </p>
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <button
            type="button"
            className="on-ink px-3 py-1.5"
            onClick={() => onFile(sampleCsv(), SAMPLE_CASE.fileName, caseRef.trim() || SAMPLE_CASE.reference)}
          >
            Open the sample
          </button>
          <button type="button" className="underline underline-offset-4" onClick={downloadSample}>
            Download the sample CSV
          </button>
        </div>
      </div>
    </div>
  );
}

function readFile(file: File, take: (text: string, fileName: string) => void) {
  const reader = new FileReader();
  reader.onload = () => take(String(reader.result ?? ""), file.name);
  reader.readAsText(file);
}

function downloadSample() {
  downloadText(sampleCsv(), SAMPLE_CASE.fileName, "text/csv");
}

export function downloadText(text: string, fileName: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
