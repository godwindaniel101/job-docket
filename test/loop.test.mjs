import { strict as assert } from "node:assert";
import test from "node:test";
import { pageView, parseAction, runLoop } from "../extension/lib/loop.mjs";

function page(overrides = {}) {
  return {
    url: "https://jobs.example.com/apply",
    title: "Senior Engineer",
    text: "Apply for Senior Engineer at Acme.",
    outline: [
      { ref: "f1", kind: "input", label: "Full name", required: true, frameId: 0 },
      { ref: "f2", kind: "file", label: "Resume", frameId: 0 },
      { ref: "f3", kind: "button", label: "Submit application", frameId: 0 },
      { ref: "f4", kind: "link", label: "Apply", href: "https://jobs.example.com/form", frameId: 0 },
    ],
    ...overrides,
  };
}

function harness(answers, extra = {}) {
  const acted = [];
  const queue = [...answers];
  return {
    acted,
    deps: {
      readPage: async () => page(extra.page || {}),
      ask: async () => queue.shift() ?? '{"action":"done","summary":"out of answers"}',
      act: async (action) => acted.push(action),
      scroll: async () => ({ bottom: true }),
      navigate: async (url) => acted.push({ type: "navigate", url }),
      wait: async () => {},
      onStep: () => {},
      cvFile: { base64: "AAA", filename: "cv.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      ...extra.deps,
    },
  };
}

test("fills a field and attaches the CV by ref", async () => {
  const { deps, acted } = harness([
    '{"action":"type","ref":"f1","text":"Ada Lovelace"}',
    '{"action":"upload_cv","ref":"f2"}',
    '{"action":"done","summary":"filled"}',
  ]);
  const result = await runLoop(deps);
  assert.equal(result.status, "done");
  assert.deepEqual(acted[0], { type: "fill", ref: "f1", label: "Full name", value: "Ada Lovelace", frameId: 0 });
  assert.equal(acted[1].type, "upload");
  assert.equal(acted[1].filename, "cv.docx");
});

test("never presses submit itself, even when the agent asks", async () => {
  const { deps, acted } = harness(['{"action":"click","ref":"f3","why":"send it"}']);
  const result = await runLoop(deps);
  assert.equal(result.status, "ready-to-submit");
  assert.equal(result.submit.label, "Submit application");
  assert.equal(acted.length, 0, "nothing was clicked");
});

test("presses submit only once the person approved the send", async () => {
  const { deps, acted } = harness(
    ['{"action":"click","ref":"f3"}', '{"action":"done","summary":"sent"}'],
    { deps: { sendApproved: () => true } },
  );
  const result = await runLoop(deps);
  assert.equal(result.status, "done");
  assert.deepEqual(acted[0], { type: "click", ref: "f3", label: "Submit application", frameId: 0 });
});

test("hands a captcha back to the person before asking the agent anything", async () => {
  let asked = 0;
  const { deps } = harness([], { page: { captcha: true }, deps: { ask: async () => { asked += 1; return "{}"; } } });
  const result = await runLoop(deps);
  assert.equal(result.status, "needs-human");
  assert.match(result.message, /captcha/i);
  assert.equal(asked, 0);
});

test("stops when the agent repeats the same step", async () => {
  const { deps } = harness([
    '{"action":"scroll","amount":1}',
    '{"action":"scroll","amount":1}',
    '{"action":"scroll","amount":1}',
  ]);
  const result = await runLoop(deps);
  assert.equal(result.status, "needs-human");
  assert.match(result.message, /circles/i);
});

test("collects listings in search mode and returns them", async () => {
  const { deps } = harness([
    '{"action":"collect","jobs":[{"title":"Staff Engineer","company":"Acme","location":"Remote","url":"https://jobs.example.com/1"},{"title":"bad","url":"javascript:alert(1)"}]}',
  ]);
  const result = await runLoop(deps, { mode: "search" });
  assert.equal(result.status, "collected");
  assert.equal(result.collected.length, 1);
  assert.equal(result.collected[0].title, "Staff Engineer");
});

test("tells the agent when it names a ref that is not on the page", async () => {
  const seen = [];
  const { deps } = harness(
    ['{"action":"click","ref":"f99"}', '{"action":"done","summary":"ok"}'],
    { deps: { ask: async (view) => { seen.push(view); return seen.length === 1 ? '{"action":"click","ref":"f99"}' : '{"action":"done","summary":"ok"}'; } } },
  );
  await runLoop(deps);
  assert.match(seen[1], /no ref f99/i);
});

test("refuses a link that is not http", () => {
  assert.throws(() => parseAction('{"action":"navigate","url":"file:///etc/passwd"}'), /will not open/i);
});

test("the view names every control with its ref", () => {
  const view = pageView(page(), { mode: "apply" });
  assert.match(view, /f1 input "Full name" required/);
  assert.match(view, /f3 button "Submit application"/);
  assert.match(view, /MODE: apply/);
});

test("carries on past a captcha the person says is not there", async () => {
  const seen = [];
  const deps = {
    readPage: async () => ({ url: "https://x.com", captcha: true, captchaDetail: { what: "a captcha frame", size: "0×0" }, outline: [] }),
    ask: async () => { seen.push(1); return '{"action":"done","summary":"filled"}'; },
    act: async () => {},
    scroll: async () => ({}),
    navigate: async () => {},
  };
  const stopped = await runLoop(deps);
  assert.equal(stopped.status, "needs-human");
  assert.equal(stopped.reason, "captcha");
  assert.match(stopped.message, /a captcha frame, 0×0/);
  assert.equal(seen.length, 0);

  const carried = await runLoop(deps, { ignoreCaptcha: true });
  assert.equal(carried.status, "done");
  assert.equal(seen.length, 1);
});
