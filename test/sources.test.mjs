import { strict as assert } from "node:assert";
import test from "node:test";
import { companySlug, dedupe, feedJobs, matches, normalize, siteSearchUrl } from "../extension/lib/sources.mjs";

test("drops listings with no link or no title", () => {
  assert.equal(normalize({ title: "Engineer", url: "ftp://x" }), null);
  assert.equal(normalize({ title: "", url: "https://a.com/1" }), null);
  assert.equal(normalize({ title: "Engineer", url: "https://a.com/1" }).location, "Not stated");
});

test("strips markup out of a feed summary", () => {
  const row = normalize({ title: "<b>Backend</b> Engineer", url: "https://a.com/1", summary: "<p>Build <i>things</i></p>" });
  assert.equal(row.title, "Backend Engineer");
  assert.equal(row.summary, "Build things");
});

test("dedupes on the link and ignores the fragment", () => {
  const rows = dedupe([
    { title: "A", url: "https://a.com/1#apply" },
    { title: "A again", url: "https://a.com/1" },
    { title: "B", url: "https://a.com/2" },
  ]);
  assert.equal(rows.length, 2);
});

test("matches every word of a role, not just one", () => {
  const job = { title: "Senior Backend Engineer", company: "Acme", summary: "" };
  assert.equal(matches(job, ["backend engineer"]), true);
  assert.equal(matches(job, ["frontend engineer"]), false);
  assert.equal(matches(job, []), true);
});

test("turns a company name into a board slug", () => {
  assert.equal(companySlug("Acme Inc."), "acme");
  assert.equal(companySlug("Flutterwave Ltd"), "flutterwave");
});

test("reports the source that failed instead of returning nothing", async () => {
  const fetchJson = async (url) => {
    if (url.includes("remotive")) throw new Error("offline");
    if (url.includes("arbeitnow")) {
      return { ok: true, json: async () => ({ data: [{ title: "Backend Engineer", company_name: "Acme", url: "https://a.com/1", remote: true }] }) };
    }
    return { ok: false, status: 503 };
  };
  const result = await feedJobs(["backend engineer"], { fetchJson });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].source, "Arbeitnow");
  assert.equal(result.problems.length, 4, "every dead feed is named");
  assert.match(result.problems[0], /Remotive/);
});

test("builds a site search link for the tab-driven sites", () => {
  assert.match(siteSearchUrl("linkedin", "Staff Engineer", "Remote"), /linkedin\.com\/jobs\/search/);
  assert.equal(siteSearchUrl("nope", "x"), "");
});
