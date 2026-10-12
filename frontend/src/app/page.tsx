import { HomePage } from "@/components/home-page";
import { analyze, toPreview } from "@/lib/analyze";
import { parseStatement } from "@/lib/parseStatement";
import { STANDARD_POLICY } from "@/lib/policy";
import { sampleCsv } from "@/lib/sample";

export default function Page() {
  const parsed = parseStatement(sampleCsv());
  const preview = toPreview(analyze(parsed.rows, STANDARD_POLICY));
  return <HomePage preview={preview} />;
}
