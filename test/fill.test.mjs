import assert from "node:assert/strict";
import test from "node:test";
import { deriveNames, isApplicationForm, planFields } from "../extension/lib/fill.mjs";
import { fixture, loadPage } from "./dom.mjs";

test("splits a full name when the form asks for parts", () => {
  assert.deepEqual(deriveNames({ fullName: "Ada Lovelace" }), {
    fullName: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
  });
});

test("fills known answers and stops on privacy and missing notes", () => {
  const { extract } = loadPage(fixture("apply.html"));
  const page = extract();
  assert.equal(isApplicationForm(page.fields), true);
  const { planned, unknown } = planFields(page.fields, {
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    phone: "123",
    workAuth: "Yes",
  });
  assert.equal(planned.some((action) => action.kind === "text" || action.kind === "email"), true);
  assert.equal(planned.some((action) => action.kind === "radio"), true);
  assert.equal(planned.some((action) => action.type === "upload"), true);
  assert.equal(unknown.some((field) => /privacy/i.test(field.label)), true);
  assert.equal(unknown.some((field) => /why do you/i.test(field.label)), true);
});

test("does not treat a board search box as an application", () => {
  const { extract } = loadPage(fixture("board.html"));
  const page = extract();
  assert.equal(isApplicationForm(page.fields), false);
});

test("leaves the country picker inside a phone widget alone", () => {
  const { planned, unknown } = planFields([
    { selector: "#country", type: "text", name: "country", label: "Phone *", aria: "Phone country code", required: false },
    { selector: "#phone", type: "tel", name: "phone", label: "Phone *", required: true },
  ], { phone: "+234 801 234 5678" });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].selector, "#phone");
  assert.equal(unknown.length, 0);
});

test("does not answer a question about somebody else with your own name", () => {
  const { planned, unknown } = planFields([
    { selector: "#ref", type: "text", name: "question_1", label: "Name of the person who referred you", required: true },
  ], { fullName: "Godwin Damiel" });
  assert.equal(planned.length, 0);
  assert.equal(unknown[0].because, "unmapped");
});

test("still fills a plain full name field", () => {
  const { planned } = planFields([
    { selector: "#n", type: "text", name: "name", label: "Full name", required: true },
  ], { fullName: "Godwin Damiel" });
  assert.equal(planned[0].value, "Godwin Damiel");
});
