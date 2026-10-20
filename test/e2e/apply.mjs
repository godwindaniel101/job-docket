// Drives one whole application in the loaded extension, against a real page.
import { clickCardButton, clickChip, feed, kill, launch, openPanel, seed } from "./harness.mjs";

const TARGET = process.argv[2] || "http://localhost:8788/job.html";
const WAIT = Number(process.argv[3] || 150000);

const CV = `GODWIN DAMIEL
Lagos, Nigeria | godwin@example.com | +234 801 234 5678 | linkedin.com/in/godwin

SUMMARY
Backend engineer, nine years on payment systems.

EXPERIENCE
Senior Backend Engineer — Acme Payments | 2022 - Present
- Rebuilt the disbursement path, cutting failed payouts from 3.1% to 0.4%.
- Led the move to idempotent transfers across 17 services.

Backend Engineer — Paystack | 2019 - 2022
- Shipped the reconciliation engine covering 40,000 daily settlements.

SKILLS
TypeScript, Node.js, PostgreSQL, Redis, Kafka, AWS

EDUCATION
BSc Computer Science — University of Lagos | 2013 - 2017`;

const { browser, bridge } = await launch({ headless: false });
console.log(`bridge manifest in profile: ${bridge}`);

const job = await browser.newPage();
await job.goto(TARGET, { waitUntil: "networkidle2" });
console.log(`job page: ${await job.title()}`);

const { page, errors } = await openPanel(browser);
await seed(page, {
  masterCv: CV,
  profile: {
    fullName: "Godwin Damiel",
    email: "godwin@example.com",
    phone: "+234 801 234 5678",
    location: "Lagos, Nigeria",
    linkedin: "linkedin.com/in/godwin",
    workAuth: "Yes",
    sponsorship: "Yes",
    salary: "90000",
    notice: "1 month",
  },
  rules: { roles: "Backend Engineer", maxApplications: 1, pauseBeforeSubmit: true, skipPoorFit: false, showPointer: true },
});
await page.reload({ waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 1200));

// The panel is a normal tab here, so point it at the job tab on purpose.
await job.bringToFront();
await new Promise((r) => setTimeout(r, 400));
await page.bringToFront();
await page.evaluate(() => document.querySelector("#tab-use").click());
await new Promise((r) => setTimeout(r, 800));
console.log(`working tab: ${await page.evaluate(() => document.querySelector("#tab-chip").textContent)}`);

console.log("\n--- apply here ---");
await clickChip(page, "Apply here");

const started = Date.now();
let last = 0;
while (Date.now() - started < WAIT) {
  await new Promise((r) => setTimeout(r, 4000));
  const rows = await feed(page);
  if (rows.length !== last) {
    console.log(rows.slice(last).join("\n"));
    last = rows.length;
  }
  const done = await page.evaluate(() => Boolean(
    [...document.querySelectorAll("#feed .card h3")].some((h) => /Ready to send|Over to you|did not work|Skipped/.test(h.textContent)),
  ));
  if (done) break;
}

console.log("\n--- form state on the page ---");
console.log(JSON.stringify(await job.evaluate(() => {
  const values = {};
  const files = [];
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const key = el.name || el.id || "(unnamed)";
    if (el.type === "file") files.push(`${key}: ${el.files?.length ? el.files[0].name : "(empty)"}`);
    else if (el.type !== "hidden") values[key] = el.value;
  }
  const byType = {};
  for (const el of document.querySelectorAll("input")) byType[el.type] = (byType[el.type] || 0) + 1;
  const attach = [...document.querySelectorAll("button, label")]
    .filter((el) => /attach|upload/i.test(el.textContent || ""))
    .map((el) => `${el.tagName} "${el.textContent.trim().slice(0, 24)}"`);
  const body = document.body.innerText;
  const cvMention = (body.match(/[\w-]+\.(docx|pdf)/g) || []).slice(0, 3);
  return { url: location.href, files, inputsByType: byType, attachControls: attach.slice(0, 4), cvMention, values };
}).catch((error) => ({ error: error.message })), null, 2));

const shot = "/private/tmp/claude-501/-Users-danieliyenogun-Desktop-Software-P-job/3df0b5b9-7651-4701-adfa-980b8767a1c3/scratchpad/run-page.png";
await job.evaluate(() => {
  const mark = [...document.querySelectorAll("label, h3, div")].find((el) => /resume|cv/i.test(el.textContent || "") && el.textContent.length < 60);
  if (mark) mark.scrollIntoView({ block: "center" });
}).catch(() => {});
await new Promise((r) => setTimeout(r, 600));
await job.screenshot({ path: shot, fullPage: false }).catch(() => {});
console.log(`screenshot: ${shot}`);

console.log("\n--- panel errors ---");
console.log(errors.length ? errors.join("\n") : "none");
await kill(browser);
