import { strict as assert } from "node:assert";
import test from "node:test";
import { boardFromUrl, pool, rank, scoreJob, slugFor, sweepBoards, targetsForCompany } from "../extension/lib/discover.mjs";
import { seedTargets } from "../extension/lib/boards.mjs";

test("recognises the company board behind any ATS link", () => {
  assert.deepEqual(boardFromUrl("https://job-boards.greenhouse.io/gitlab/jobs/8687926002"), { system: "greenhouse", slug: "gitlab" });
  assert.deepEqual(boardFromUrl("https://jobs.lever.co/spotify/abc"), { system: "lever", slug: "spotify" });
  assert.deepEqual(boardFromUrl("https://jobs.ashbyhq.com/ramp/xyz"), { system: "ashby", slug: "ramp" });
  assert.deepEqual(boardFromUrl("https://apply.workable.com/monzo/j/ABC"), { system: "workable", slug: "monzo" });
  assert.deepEqual(boardFromUrl("https://moniepoint.bamboohr.com/careers/42"), { system: "bamboohr", slug: "moniepoint" });
  assert.equal(boardFromUrl("https://example.com/careers"), null);
});

test("turns a company name into a slug every system will take", () => {
  assert.equal(slugFor("Cockroach Labs"), "cockroach");
  assert.equal(slugFor("1Password"), "1password");
  assert.equal(targetsForCompany("Stripe").length, 6, "one slug is tried on every system");
});

test("ranks a close title above a far one, and fresh above stale", () => {
  const wants = { roles: ["Engineering Manager"], dos: ["remote"], location: "Lagos" };
  const near = scoreJob({ title: "Engineering Manager, Payments", location: "Remote", posted: new Date().toISOString() }, wants);
  const far = scoreJob({ title: "Account Executive", location: "Paris", posted: new Date().toISOString() }, wants);
  const stale = scoreJob({ title: "Engineering Manager, Payments", location: "Remote", posted: "2024-01-01" }, wants);
  assert.ok(near > far, "a matching title scores higher");
  assert.ok(near > stale, "a fresh posting scores higher than an old one");
});

test("rank returns the best first and respects the limit", () => {
  const jobs = [
    { title: "Account Executive", url: "https://a.com/1" },
    { title: "Engineering Manager", url: "https://a.com/2" },
  ];
  const ranked = rank(jobs, { roles: ["Engineering Manager"] }, 1);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].title, "Engineering Manager");
});

test("one dead board does not end the sweep", async () => {
  const fetchJson = async (url) => {
    if (url.includes("deadco")) throw new Error("gone");
    return { ok: true, json: async () => ({ jobs: [{ title: "Engineer", absolute_url: "https://a.com/1", location: { name: "Remote" } }] }) };
  };
  const found = await sweepBoards(
    [{ system: "greenhouse", slug: "deadco" }, { system: "greenhouse", slug: "liveco" }],
    { fetchJson },
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].company, "liveco");
});

test("the same board is never read twice in one sweep", async () => {
  let calls = 0;
  const fetchJson = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ jobs: [] }) };
  };
  await sweepBoards([{ system: "greenhouse", slug: "x" }, { system: "greenhouse", slug: "x" }], { fetchJson });
  assert.equal(calls, 1);
});

test("the pool keeps going when a worker throws", async () => {
  const out = await pool([1, 2, 3], async (n) => {
    if (n === 2) throw new Error("bad");
    return [n];
  }, 2);
  assert.deepEqual(out.sort(), [1, 3]);
});

test("ships a seed list of real boards", () => {
  const targets = seedTargets();
  assert.ok(targets.length > 50, `expected a useful seed list, got ${targets.length}`);
  assert.ok(targets.every((target) => target.system && target.slug));
});
