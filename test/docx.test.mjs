import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDocx } from "../extension/lib/docx.mjs";
import { novelFigures, parseModelJson } from "../extension/lib/tailor.mjs";

test("writes a docx a word processor can open", () => {
  const bytes = buildDocx("# Ada Lovelace\n\n- Shipped the ledger", "a4");
  const dir = mkdtempSync(join(tmpdir(), "docket-"));
  const file = join(dir, "cv.docx");
  writeFileSync(file, bytes);
  const xml = execFileSync("python3", ["-c", "import sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode())", file], { encoding: "utf8" });
  assert.match(xml, /Ada Lovelace/);
  assert.match(xml, /Shipped the ledger/);
  assert.match(xml, /w:w="11906"/);
});

test("parses model JSON and flags figures that are not in the master", () => {
  const parsed = parseModelJson("```json\n{\"fit\":\"partial\",\"skip\":false,\"tailoredMarkdown\":\"# Ada\"}\n```");
  assert.equal(parsed.fit, "partial");
  assert.equal(parsed.tailoredMarkdown, "# Ada");
  assert.deepEqual(novelFigures("Grew revenue 50%", "Grew revenue 50% and saved $12,000"), ["$12,000"]);
});
