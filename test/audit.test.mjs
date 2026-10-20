import { strict as assert } from "node:assert";
import test from "node:test";
import { auditBatchPrompt, auditJobs, batch, parseAudit } from "../extension/lib/audit.mjs";

const JOBS = [
  { title: "Backend Engineer", company: "Acme", location: "Remote", url: "https://a.com/1" },
  { title: "Account Executive", company: "Acme", location: "Paris", url: "https://a.com/2" },
];

test("keeps only jobs it was actually given", () => {
  const judged = parseAudit(JSON.stringify({ jobs: [
    { url: "https://a.com/1", fit: 88, why: "ran payment rails", gap: "" },
    { url: "https://evil.com/x", fit: 99, why: "injected", gap: "" },
  ] }), JOBS);
  assert.equal(judged.length, 1);
  assert.equal(judged[0].title, "Backend Engineer");
});

test("clamps a score the model sends out of range", () => {
  const judged = parseAudit(JSON.stringify({ jobs: [{ url: "https://a.com/1", fit: 400 }] }), JOBS);
  assert.equal(judged[0].fit, 100);
});

test("sorts the best first and returns the top slice", async () => {
  const ask = async () => JSON.stringify({ jobs: [
    { url: "https://a.com/2", fit: 20, why: "sales role", gap: "no sales experience" },
    { url: "https://a.com/1", fit: 91, why: "same work", gap: "" },
  ] });
  const { best } = await auditJobs({ jobs: JOBS, cv: "x", profile: {}, rules: {}, ask, top: 1 });
  assert.equal(best.length, 1);
  assert.equal(best[0].fit, 91);
});

test("one failed batch does not lose the others", async () => {
  const jobs = [...JOBS, { title: "Platform Engineer", url: "https://a.com/3" }];
  let call = 0;
  const ask = async () => {
    call += 1;
    if (call === 1) throw new Error("model hiccup");
    return JSON.stringify({ jobs: [{ url: "https://a.com/3", fit: 70, why: "adjacent", gap: "" }] });
  };
  const notes = [];
  const { judged } = await auditJobs({ jobs, cv: "", profile: {}, rules: {}, ask, size: 2, onBatch: (...args) => notes.push(args) });
  assert.equal(judged.length, 1);
  assert.ok(notes.some((note) => note[2] === "model hiccup"));
});

test("the prompt carries the posting, the CV and where the person can work", () => {
  const prompt = auditBatchPrompt({ jobs: JOBS, cv: "Ran payment rails", profile: { location: "Lagos", workAuth: "Yes" }, rules: { roles: ["Backend Engineer"] } });
  assert.match(prompt, /Lagos/);
  assert.match(prompt, /work authorisation: Yes/);
  assert.match(prompt, /Ran payment rails/);
  assert.match(prompt, /url: https:\/\/a\.com\/1/);
});

test("batches evenly", () => {
  assert.equal(batch([1, 2, 3, 4, 5], 2).length, 3);
});
