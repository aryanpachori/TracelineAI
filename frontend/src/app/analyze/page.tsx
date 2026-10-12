import { Suspense } from "react";
import { AnalyzeApp } from "@/components/analyze/analyze-app";

export default function AnalyzePage() {
  return (
    <Suspense fallback={<p className="px-5 py-10">Opening the file…</p>}>
      <AnalyzeApp />
    </Suspense>
  );
}
