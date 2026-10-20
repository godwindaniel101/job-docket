import { strict as assert } from "node:assert";
import test from "node:test";
import { cvFacts } from "../extension/lib/cv-facts.mjs";
import { whoBlock } from "../extension/lib/loop.mjs";

const CV = `GODWIN DAMIEL
Lagos, Nigeria | godwin@example.com

SUMMARY
Backend engineer with 9 years on payment systems.

EXPERIENCE
Senior Backend Engineer — Acme Payments | 2022 - Present
- Rebuilt the disbursement path.
Backend Engineer — Paystack | 2019 - 2022
- Shipped the reconciliation engine.

SKILLS
TypeScript, Node.js, PostgreSQL

EDUCATION
BSc Computer Science — University of Lagos | 2013 - 2017`;

test("pulls the school, degree and skills a form will ask for", () => {
  const facts = cvFacts(CV);
  assert.match(facts, /University of Lagos/);
  assert.match(facts, /BSc Computer Science/);
  assert.match(facts, /TypeScript/);
  assert.match(facts, /9 years/);
});

test("says nothing when there is no CV", () => {
  assert.equal(cvFacts(""), "");
});

test("the who block lists what the agent must never ask for again", () => {
  const who = whoBlock({ firstName: "Godwin", lastName: "Damiel", phone: "+234 801", email: "g@x.com" }, cvFacts(CV));
  assert.match(who, /First name: Godwin/);
  assert.match(who, /Last name: Damiel/);
  assert.match(who, /Phone: \+234 801/);
  assert.match(who, /University of Lagos/);
});

test("leaves out what is blank", () => {
  const who = whoBlock({ email: "g@x.com" }, "");
  assert.equal(who.includes("Phone"), false);
  assert.match(who, /Email: g@x.com/);
});
