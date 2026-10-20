import assert from "node:assert/strict";
import test from "node:test";
import { mergeSnapshots } from "../extension/lib/pick.mjs";
import { fixture, loadPage } from "./dom.mjs";

test("reads a posting, its form, and the submit control", () => {
  const { extract, act } = loadPage(fixture("apply.html"));
  const page = extract();
  assert.equal(page.job.title, "Staff Engineer");
  assert.equal(page.job.company, "Northwind");
  assert.equal(page.job.location, "Berlin, Germany");
  assert.match(page.job.description, /TypeScript/);
  assert.equal(page.captcha, false);
  assert.equal(page.submit.text, "Submit application");
  const email = page.fields.find((field) => field.type === "email");
  act({ type: "fill", selector: email.selector, value: "ada@example.com" });
  assert.equal(extract().fields.find((field) => field.type === "email").value, "ada@example.com");
});

test("reads board cards and a captcha", () => {
  const board = loadPage(fixture("board.html")).extract();
  assert.deepEqual(Array.from(board.listings, (job) => job.company), ["Northwind", "Acme Corp", "Northwind"]);
  assert.equal(board.listings[2].location, "Russia");
  const captcha = loadPage(fixture("captcha.html")).extract();
  assert.equal(captcha.captcha, true);
  assert.equal(captcha.job.company, "Northwind");
  assert.equal(captcha.apply.text, "Apply");
});

test("keeps a captcha that lives in another frame", () => {
  const merged = mergeSnapshots([
    { frameId: 0, isTop: true, job: { title: "Role", description: "x".repeat(200) }, fields: [], listings: [] },
    { frameId: 2, captcha: true, fields: [{ label: "Email", type: "email" }], submit: { selector: "#send", text: "Submit" } },
  ]);
  assert.equal(merged.captcha, true);
  assert.equal(merged.fields.length, 1);
  assert.equal(merged.submit.frameId, undefined);
  assert.equal(merged.frameId, 2);
});

test("ignores the invisible reCAPTCHA that most career sites load on every page", () => {
  const page = loadPage(`<!doctype html><html><body>
    <h1>Senior Engineer</h1>
    <div class="grecaptcha-badge"><iframe src="https://www.google.com/recaptcha/api2/anchor?size=invisible"></iframe></div>
    <iframe src="https://www.google.com/recaptcha/api2/anchor?k=abc&size=invisible"></iframe>
    <div class="g-recaptcha" data-size="invisible"></div>
    <form><input name="email" type="email"><button>Submit application</button></form>
  </body></html>`).extract();
  assert.equal(page.captcha, false);
});

test("still reports a captcha a person has to click", () => {
  const page = loadPage(`<!doctype html><html><body>
    <h1>Senior Engineer</h1>
    <div class="g-recaptcha" data-sitekey="abc"></div>
  </body></html>`).extract();
  assert.equal(page.captcha, true);
});

test("ignores one marked hidden in the markup", () => {
  const page = loadPage(`<!doctype html><html><body>
    <iframe src="https://hcaptcha.com/captcha" hidden></iframe>
  </body></html>`).extract();
  assert.equal(page.captcha, false);
});
