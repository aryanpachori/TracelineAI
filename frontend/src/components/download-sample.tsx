"use client";

import { downloadText } from "@/components/analyze/upload-panel";
import { SAMPLE_CASE, sampleCsv } from "@/lib/sample";

export function DownloadSample() {
  return (
    <button
      type="button"
      className="rounded-xl border border-rule bg-white px-4 py-2.5"
      onClick={() => downloadText(sampleCsv(), SAMPLE_CASE.fileName, "text/csv")}
    >
      Download the file
    </button>
  );
}
