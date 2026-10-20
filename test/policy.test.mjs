import assert from "node:assert/strict";
import test from "node:test";
import { matchesList, parseLines, screenJob } from "../extension/lib/policy.mjs";

test("parses one rule per line and ignores blanks", () => {
  assert.deepEqual(parseLines(" Acme \n\nRussia\n"), ["Acme", "Russia"]);
});

test("matches a short name only as a whole word", () => {
  assert.equal(matchesList("Acme Corp", ["Acme"]), "Acme");
  assert.equal(matchesList("AcmeCorp", ["Acme"]), null);
  assert.equal(matchesList("Australia", ["US"]), null);
  assert.equal(matchesList("Remote, US", ["US"]), "US");
});

test("skips avoided companies, regions, roles, and don'ts", () => {
  const rules = {
    roles: ["Staff Engineer"],
    avoidCompanies: ["Acme Corp"],
    avoidRegions: ["Russia"],
    donts: ["security clearance"],
    dos: ["TypeScript"],
  };
  assert.equal(screenJob({ title: "Data Scientist", company: "Northwind", location: "Berlin" }, rules).decision, "skip");
  assert.equal(screenJob({ title: "Staff Engineer", company: "Acme Corp", location: "Berlin" }, rules).reason.includes("avoid"), true);
  assert.equal(screenJob({ title: "Staff Engineer", company: "Northwind", location: "Moscow, Russia" }, rules).decision, "skip");
  assert.equal(
    screenJob({
      title: "Staff Engineer",
      company: "Northwind",
      location: "Berlin",
      description: "Location: Russia",
    }, rules).decision,
    "skip",
  );
  assert.equal(
    screenJob({
      title: "Staff Engineer",
      company: "Northwind",
      location: "Berlin",
      description: "Active security clearance required",
    }, rules).decision,
    "skip",
  );
  const kept = screenJob({
    title: "Staff Engineer",
    company: "Northwind",
    location: "Berlin",
    description: "TypeScript services",
  }, rules);
  assert.equal(kept.decision, "keep");
  assert.deepEqual(kept.dos, ["TypeScript"]);
});

test("matches a role whose words the employer moved around", () => {
  const rules = { roles: ["Backend Engineer"] };
  const keep = (title) => screenJob({ title }, rules).decision;
  assert.equal(keep("Senior Backend Engineer, VGo Carrier Technology"), "keep");
  assert.equal(keep("Engineer, Backend Platform"), "keep");
  assert.equal(keep("Backend Software Engineer (Ruby)"), "keep");
  assert.equal(keep("Staff Backend Engineer II"), "keep");
  assert.equal(keep("Account Executive - France"), "skip");
  assert.equal(keep("Frontend Engineer"), "skip");
});

test("ignores seniority words when matching a role", () => {
  assert.equal(screenJob({ title: "Backend Engineer" }, { roles: ["Senior Backend Engineer"] }).decision, "keep");
});

test("the queue survives a round trip without dragging junk along", async () => {
  const { trimQueue } = await import("../extension/lib/storage.mjs");
  const kept = trimQueue([
    { title: "Backend Engineer", url: "https://a.com/1", fit: 82, why: "payment rails", summary: "x".repeat(900), extra: "drop me" },
    { title: "Same job again", url: "https://a.com/1" },
    { title: "No link", company: "Acme" },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].fit, 82);
  assert.equal(kept[0].summary.length, 500);
  assert.equal(kept[0].extra, undefined);
});
