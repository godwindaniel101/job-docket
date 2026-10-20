// Finds real jobs, then has the agent judge them against a real CV.
import { clickChip, feed, kill, launch, openPanel, seed } from "./harness.mjs";

const CV = `GODWIN DAMIEL
Lagos, Nigeria | godwin@example.com | +234 801 234 5678

SUMMARY
Backend engineer with 9 years on payment systems. Builds and runs money-path services.

EXPERIENCE
Senior Backend Engineer — Fincra | 2022 - Present
- Rebuilt the disbursement path across 17 TypeScript microservices, cutting failed payouts from 3.1% to 0.4%.
- Made every transfer idempotent; owns the reconciliation and settlement path.
- On call for the money path.

Backend Engineer — Paystack | 2019 - 2022
- Shipped the reconciliation engine covering 40,000 daily settlements.
- Took the webhook consumer from 11s p99 to 900ms.

SKILLS
TypeScript, Node.js, PostgreSQL, Redis, Kafka, AWS, payments, settlements, reconciliation

EDUCATION
BSc Computer Science — University of Lagos | 2013 - 2017`;

const { browser } = await launch({ headless: false });
const { page, errors } = await openPanel(browser);
await seed(page, {
  masterCv: CV,
  profile: { fullName: "Godwin Damiel", email: "godwin@example.com", location: "Lagos, Nigeria", workAuth: "Yes", sponsorship: "Yes" },
  rules: { roles: "Backend Engineer", skipPoorFit: false, maxApplications: 5 },
});
await page.reload({ waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 1200));

await clickChip(page, "Find jobs");
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 3000));
  if (await page.evaluate(() => Boolean(document.querySelector("#feed .card h3")))) break;
}
console.log(`queued: ${await page.evaluate(() => document.querySelector("#queue-count").textContent)}`);

console.log("\n--- audit ---");
await clickChip(page, "Audit and rank");
const started = Date.now();
while (Date.now() - started < 420000) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const state = await page.evaluate(() => ({
      cards: document.querySelectorAll("#feed .card").length,
      status: document.querySelector("#status").textContent,
    }));
    process.stdout.write(`\r${state.status} — ${state.cards} cards   `);
    if (state.cards >= 6) break;
  } catch (error) {
    console.log(`\n(panel unreachable: ${error.message.split("\n")[0]})`);
    break;
  }
}
console.log();

try {
  console.log((await feed(page)).filter((row) => /Judged|card ::/.test(row)).join("\n"));
} catch (error) {
  console.log(`could not read the feed: ${error.message.split("\n")[0]}`);
}
console.log("\nerrors:", errors.length ? errors.join("\n") : "none");
await kill(browser);
