import assert from "node:assert/strict";
import { deflateRawSync, deflateSync } from "node:zlib";
import test from "node:test";
import { textFromDocx, textFromPdf } from "../extension/lib/cv-text.mjs";
import { buildDocx } from "../extension/lib/docx.mjs";
import { activeModel, buildReviewPrompt, parseAdjust, reviewCv } from "../extension/lib/tailor.mjs";

const CV = "Ada Lovelace built TypeScript services at Northwind for the payments ledger.";

test("reads a Word CV back out of a docx", async () => {
  const text = await textFromDocx(buildDocx(`# Ada Lovelace\n\n- ${CV}`));
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /TypeScript services at Northwind/);
});

test("reads text from a compressed PDF stream", async () => {
  const body = `BT (${CV}) Tj ET`;
  const compressed = deflateRawSync(Buffer.from(body));
  const header = `%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`;
  const bytes = Buffer.concat([
    Buffer.from(header),
    compressed,
    Buffer.from("\nendstream\nendobj\ntrailer\n<<>>\n%%EOF"),
  ]);
  assert.match(await textFromPdf(bytes), /TypeScript services at Northwind/);
});

test("reads a PDF whose text is in a custom font encoding", async () => {
  const sentence = "Ada Lovelace built TypeScript services at Northwind for the payments ledger.";
  const content = deflateSync(Buffer.from(`/F1 12 Tf\n<${Buffer.from(sentence).toString("hex")}> Tj\n`));
  const cmap = deflateSync(Buffer.from("begincodespacerange\n<00> <FF>\nendcodespacerange\n1 beginbfrange\n<20> <7E> <0020>\nendbfrange\n"));
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.from("1 0 obj\n<< /Filter /FlateDecode /Length 2 0 R >>\nstream\n"),
    content,
    Buffer.from("\nendstream\nendobj\n"),
    Buffer.from(`2 0 obj\n${content.length}\nendobj\n`),
    Buffer.from("3 0 obj\n<< /Filter /FlateDecode /Length 4 0 R >>\nstream\n"),
    cmap,
    Buffer.from("\nendstream\nendobj\n"),
    Buffer.from(`4 0 obj\n${cmap.length}\nendobj\n`),
    Buffer.from("5 0 obj\n<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Test /ToUnicode 3 0 R >>\nendobj\n"),
    Buffer.from("6 0 obj\n<< /F1 5 0 R >>\nendobj\n"),
  ]);
  assert.match(await textFromPdf(pdf), /TypeScript services at Northwind/);
});

test("names the configured model and refuses invented figures in a review", async () => {
  assert.equal(activeModel({}), null);
  assert.deepEqual(activeModel({ apiKey: "key", provider: "anthropic" }), {
    provider: "Anthropic",
    model: "claude-sonnet-4-5",
  });
  assert.match(buildReviewPrompt(CV), /Never invent employers/);
  const review = await reviewCv({
    provider: "openai",
    apiKey: "key",
    model: "gpt-4.1",
    masterCv: CV,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              roles: ["Staff Engineer", "Engineering Manager"],
              summary: "Hands-on engineer.",
              changes: ["Led with Northwind."],
              questions: [],
              fineTunedMarkdown: `${CV} Saved $12,000.`,
            }),
          },
        }],
      }),
    }),
  });
  assert.deepEqual(review.roles, ["Staff Engineer", "Engineering Manager"]);
  assert.match(review.questions[0], /\$12,000/);
});

test("keeps a CV note that stays inside the file and drops invented figures", () => {
  const master = "Ada Lovelace built TypeScript services at Northwind for the payments ledger.";
  const kept = parseAdjust(JSON.stringify({
    reply: "I led with Northwind.",
    changes: ["Led with Northwind."],
    fineTunedMarkdown: master,
  }), master);
  assert.equal(kept.changes[0], "Led with Northwind.");
  assert.equal(kept.fineTunedMarkdown, master);
  const blocked = parseAdjust(JSON.stringify({
    reply: "Added the saving.",
    changes: ["Added a saving."],
    fineTunedMarkdown: `${master} Saved $12,000.`,
  }), master);
  assert.equal(blocked.fineTunedMarkdown, "");
  assert.deepEqual(blocked.changes, []);
  assert.match(blocked.reply, /\$12,000/);
});
