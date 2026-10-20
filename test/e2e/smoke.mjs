import { clickChip, feed, kill, launch, openPanel, seed } from "./harness.mjs";

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
console.log(`bridge manifest copied: ${bridge}`);
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
  },
  rules: { roles: "Backend Engineer", maxApplications: 1, pauseBeforeSubmit: true, skipPoorFit: false },
});
await page.reload({ waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 1200));

console.log("\n--- panel booted ---");
console.log((await feed(page)).join("\n") || "(empty feed)");

console.log("\n--- running Check setup ---");
await clickChip(page, "Check setup");
await new Promise((r) => setTimeout(r, 45000));
console.log((await feed(page)).join("\n"));

console.log("\n--- page errors ---");
console.log(errors.length ? errors.join("\n") : "none");

await kill(browser);
