// Proves the panel finds real jobs for a role, in the loaded extension.
import { clickChip, feed, kill, launch, openPanel, seed } from "./harness.mjs";

const ROLE = process.argv[2] || "Engineering Manager";
const { browser } = await launch({ headless: false });
const { page, errors } = await openPanel(browser);
await seed(page, {
  masterCv: "GODWIN DAMIEL\nLagos, Nigeria | godwin@example.com\n\nEXPERIENCE\nEngineering Manager — Acme | 2022 - Present\n- Ran a team of eight on payments.",
  profile: { fullName: "Godwin Damiel", email: "godwin@example.com", location: "Lagos, Nigeria" },
  rules: { roles: ROLE, maxApplications: 5, skipPoorFit: false },
});
await page.reload({ waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 1200));

console.log(`searching for: ${ROLE}`);
await clickChip(page, "Find jobs");

const started = Date.now();
let last = 0;
while (Date.now() - started < 180000) {
  await new Promise((r) => setTimeout(r, 4000));
  const rows = await feed(page);
  if (rows.length !== last) {
    console.log(rows.slice(last).filter((row) => !row.includes("open roles on")).join("\n"));
    last = rows.length;
  }
  if (await page.evaluate(() => Boolean(document.querySelector("#feed .card h3")))) break;
}

const queue = await page.evaluate(() => Number(document.querySelector("#queue-count").textContent));
console.log(`\nqueued: ${queue}`);
console.log(await page.evaluate(() => {
  document.querySelector("#queue-toggle").click();
  return [...document.querySelectorAll("#pane-queue .item strong")].slice(0, 10).map((n) => n.textContent).join("\n");
}));
console.log("\nerrors:", errors.length ? errors.join("\n") : "none");
await kill(browser);
