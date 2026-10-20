import { strict as assert } from "node:assert";
import test from "node:test";
import { mergeProfile, profileFromCv } from "../extension/lib/profile.mjs";

const CV = `ADA LOVELACE
Lagos, Nigeria | ada@example.com | +234 801 234 5678 | linkedin.com/in/adalovelace | github.com/ada | adalovelace.dev

SUMMARY
Backend engineer with nine years on payment systems.

EXPERIENCE
Senior Backend Engineer — Acme Payments | 2022 – Present
- Rebuilt the disbursement path.`;

test("reads the header of a normal CV", () => {
  const found = profileFromCv(CV);
  assert.equal(found.fullName, "Ada Lovelace");
  assert.equal(found.email, "ada@example.com");
  assert.equal(found.phone, "+234 801 234 5678");
  assert.equal(found.location, "Lagos, Nigeria");
  assert.equal(found.linkedin, "linkedin.com/in/adalovelace");
  assert.equal(found.github, "github.com/ada");
});

test("does not mistake a date range for a phone number", () => {
  const found = profileFromCv("Jane Doe\nBerlin, Germany | jane@x.com\n\nEXPERIENCE\nEngineer | 2019 – 2024");
  assert.equal(found.phone, undefined);
});

test("skips a heading line that is not a name", () => {
  const found = profileFromCv("CURRICULUM VITAE\nsam@x.com");
  assert.equal(found.fullName, undefined);
  assert.equal(found.email, "sam@x.com");
});

test("reads a markdown CV with a hash heading", () => {
  const found = profileFromCv("# Chidi Okonkwo\nAbuja, Nigeria · chidi@x.com");
  assert.equal(found.fullName, "Chidi Okonkwo");
  assert.equal(found.location, "Abuja, Nigeria");
});

test("never overwrites an answer the person typed", () => {
  const { merged, filled } = mergeProfile(
    { fullName: "Ada L.", email: "", phone: "" },
    { fullName: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(merged.fullName, "Ada L.");
  assert.equal(merged.email, "ada@example.com");
  assert.deepEqual(filled, ["email"]);
});

test("finds the name when a title follows it on the same line", () => {
  const found = profileFromCv("Godwin Damiel | Senior Software Engineer\nLagos, Nigeria · godwin@example.com");
  assert.equal(found.fullName, "Godwin Damiel");
});

test("finds the name in a header a PDF flattened onto one line", () => {
  const found = profileFromCv("GODWIN DAMIEL Senior Backend Engineer Lagos Nigeria godwin@example.com +2348070000000");
  assert.equal(found.fullName, "Godwin Damiel");
  assert.equal(found.email, "godwin@example.com");
});

test("title-cases a name written in lower case", () => {
  assert.equal(profileFromCv("godwin damiel\nlagos, nigeria | g@x.com").fullName, "Godwin Damiel");
});

test("does not read a job title as a name", () => {
  assert.equal(profileFromCv("Senior Software Engineer\ng@x.com").fullName, undefined);
});
