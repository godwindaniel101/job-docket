import { act, focusTab, navigate, openTab, openedTabFrom, readPage, readable, scroll, setWorkTab, sleep, targetTab } from "./lib/browser.mjs";
import { askAgent, listAgents, resetSession, watchBridge } from "./lib/agent-bridge.mjs";
import { SYSTEM_PROMPT, runLoop, whoBlock } from "./lib/loop.mjs";
import { cvFacts } from "./lib/cv-facts.mjs";
import { companyJobs, feedJobs, siteSearchUrl, SITE_SEARCHES } from "./lib/sources.mjs";
import { boardFromUrl, rank, sweepBoards, targetsForCompany } from "./lib/discover.mjs";
import { seedTargets } from "./lib/boards.mjs";
import { AUDIT_SYSTEM, auditJobs } from "./lib/audit.mjs";
import { textFromCvFile } from "./lib/cv-text.mjs";
import { buildDocx, bytesToBase64, docxFilename } from "./lib/docx.mjs";
import { deriveNames, planFields } from "./lib/fill.mjs";
import { parseLines, screenJob } from "./lib/policy.mjs";
import { FIELD_NAMES, mergeProfile, profileFromAgent, profileFromCv } from "./lib/profile.mjs";
import { loadSettings, rememberApplication, saveQueue, saveSettings } from "./lib/storage.mjs";
import { extractJson, reviewCv, tailorCv } from "./lib/tailor.mjs";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const WRITER_SYSTEM = `You write and judge CVs for one person. You answer with one JSON object and nothing else.
Never add an employer, a job title, a date or a number that is not already in the CV you were given.
Plain words. No buzzwords. Keep the person's own phrasing where it is already clear.`;

const ROUTER_SYSTEM = `You read one line a person typed into a job application tool and answer with one JSON object, nothing else:
{"intent":"search","query":"backend engineer in Lagos"}
{"intent":"apply"}        when they mean the page in front of them
{"intent":"read"}         when they want to know what the open page is
{"intent":"queue"}        when they mean work through the saved list
{"intent":"stop"}
{"intent":"chat","reply":"one short sentence"}   when it is a question about the docket itself`;

const el = {
  feed: document.querySelector("#feed"),
  status: document.querySelector("#status"),
  conn: document.querySelector("#conn"),
  tabChip: document.querySelector("#tab-chip"),
  tabUse: document.querySelector("#tab-use"),
  chips: document.querySelector("#chips"),
  form: document.querySelector("#say-form"),
  input: document.querySelector("#say-input"),
  send: document.querySelector("#say-send"),
  drawer: document.querySelector("#drawer"),
  drawerClose: document.querySelector("#drawer-close"),
  queueToggle: document.querySelector("#queue-toggle"),
  queueCount: document.querySelector("#queue-count"),
  panes: {
    queue: document.querySelector("#pane-queue"),
    filed: document.querySelector("#pane-filed"),
    cv: document.querySelector("#pane-cv"),
  },
  rulesOpen: document.querySelector("#rules-open"),
  file: document.querySelector("#cv-file"),
};

let settings = null;
let queue = [];
let busy = false;
let stopFlag = false;
let pending = null;
let tab = null;
let cvFile = null;
let cvBytes = null;
let review = null;
let group = null;
let attachedName = "";

/* ---------- feed ---------- */

function scrollDown() {
  el.feed.scrollTop = el.feed.scrollHeight;
}

function node(tag, className, text) {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text != null) made.textContent = text;
  return made;
}

function add(element) {
  group = null;
  el.feed.append(element);
  scrollDown();
  return element;
}

function said(text) {
  return add(node("div", "said", text));
}

function note(text, { glyph = "·", why = "", quiet = false, grouped = true, detail = null } = {}) {
  const row = node("div", `note${quiet ? " quiet" : ""}${detail ? " has-detail" : ""}`);
  row.append(node("span", "glyph", glyph));
  const body = node("span", "body", text);
  if (why) body.append(node("span", "why", ` — ${why}`));
  row.append(body);
  if (detail) {
    const open = node("button", "peek", "what exactly?");
    open.type = "button";
    const sheet = node("dl", "detail");
    sheet.hidden = true;
    for (const [label, value] of detail) {
      if (value === "" || value == null) continue;
      sheet.append(node("dt", null, label));
      sheet.append(node("dd", null, String(value)));
    }
    open.addEventListener("click", () => {
      sheet.hidden = !sheet.hidden;
      open.textContent = sheet.hidden ? "what exactly?" : "hide";
    });
    body.append(" ", open);
    row.append(sheet);
  }
  if (grouped) {
    if (!group) {
      group = node("div", "group");
      el.feed.append(group);
    }
    group.append(row);
    scrollDown();
    return row;
  }
  return add(row);
}

function card({ title, meta, link, body, actions = [], tone = "" }) {
  const box = node("div", `card${tone ? ` ${tone}` : ""}`);
  if (title) box.append(node("h3", null, title));
  if (meta) box.append(node("p", "meta", meta));
  if (body) box.append(node("p", null, body));
  if (link) box.append(node("p", "link", link));
  if (actions.length) {
    const row = node("div", "card-actions");
    for (const action of actions) {
      const button = node("button", `btn${action.primary ? " primary" : ""}${action.danger ? " danger" : ""}`, action.label);
      button.type = "button";
      button.addEventListener("click", () => action.run(box));
      row.append(button);
    }
    box.append(row);
  }
  return add(box);
}

function failed(error) {
  busy = false;
  setStatus("Ready");
  card({ title: "That did not work", body: error?.message || String(error), tone: "bad" });
  paintChips();
}

function setStatus(text, working = false) {
  el.status.textContent = text;
  el.status.classList.toggle("working", working);
}

/* ---------- agent ---------- */

async function askBrowse(view) {
  return askAgent({ prompt: view, system: SYSTEM_PROMPT, session: "browse", model: settings?.llm?.model || "", timeoutMs: 90000 });
}

async function askWriter(prompt) {
  return askAgent({ prompt, system: WRITER_SYSTEM, session: "cv", model: settings?.llm?.model || "", timeoutMs: 180000 });
}

async function askAudit(prompt) {
  return askAgent({ prompt, system: AUDIT_SYSTEM, session: "audit", model: settings?.llm?.model || "", timeoutMs: 180000 });
}

async function askRouter(line) {
  const text = await askAgent({ prompt: line, system: ROUTER_SYSTEM, session: "route", timeoutMs: 30000 });
  return extractJson(text);
}

async function checkBridge() {
  try {
    const agents = await listAgents();
    const installed = agents.filter((agent) => agent.installed);
    el.conn.classList.toggle("on", installed.length > 0);
    el.conn.classList.toggle("off", installed.length === 0);
    el.conn.title = installed.length ? `${installed[0].label} on this Mac` : "No local agent found";
    return installed.length > 0;
  } catch (error) {
    el.conn.classList.add("off");
    el.conn.title = error.message;
    return false;
  }
}

/* ---------- tab ---------- */

async function refreshTab({ create = false, url = "" } = {}) {
  try {
    tab = await targetTab({ create, url });
    const host = readable(tab.url) ? new URL(tab.url).hostname.replace(/^www\./, "") : "";
    el.tabChip.textContent = host || "No tab yet";
    el.tabChip.title = tab.title ? `${tab.title}\n${tab.url}\n\nClick to bring this tab to the front.` : tab.url || "";
    return tab;
  } catch (error) {
    tab = null;
    el.tabChip.textContent = "No tab yet";
    el.tabChip.title = error.message;
    throw error;
  }
}

async function useFrontTab() {
  setWorkTab(null);
  const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (front?.id && readable(front.url)) setWorkTab(front.id);
  await refreshTab({ create: false }).catch(() => {});
  note(tab ? `Working in ${el.tabChip.textContent}` : "No readable tab in front.", { glyph: "◎" });
}

/* ---------- CV ---------- */

function hasCv() {
  return Boolean(settings?.masterCv?.trim());
}

async function ingestCv(text, source) {
  const cv = String(text || "").trim();
  if (cv.length < 40) throw new Error("That is too short to be a CV.");
  settings.masterCv = cv;
  let { merged, filled } = mergeProfile(settings.profile, profileFromCv(cv));
  settings.profile = merged;
  await saveSettings(settings);
  note(source, { glyph: "✓" });

  // Whatever the header did not spell out plainly, the agent reads for itself.
  const thin = ["fullName", "email", "phone", "location"].some((key) => !merged[key]?.trim());
  if (thin) {
    try {
      const asked = await profileFromAgent(cv, askWriter, extractJson);
      const second = mergeProfile(merged, asked);
      merged = second.merged;
      filled = [...filled, ...second.filled];
      settings.profile = merged;
      await saveSettings(settings);
    } catch (error) {
      note(`Could not read the rest of your details: ${error.message}`, { glyph: "!", quiet: true });
    }
  }

  if (filled.length) {
    note(`Took your ${filled.map((key) => FIELD_NAMES[key] || key).join(", ")} from the CV`, {
      glyph: "✓",
      detail: filled.map((key) => [FIELD_NAMES[key] || key, merged[key]]),
    });
  }
  const stillMissing = ["fullName", "email", "phone"].filter((key) => !merged[key]?.trim());
  if (stillMissing.length) {
    card({
      title: "Two minutes now saves a stop later",
      body: `Your ${stillMissing.map((key) => FIELD_NAMES[key]).join(" and ")} is not in the CV, and most forms ask for it.`,
      actions: [{ label: "Fill it in", primary: true, run: () => chrome.runtime.openOptionsPage() }],
      tone: "ask",
    });
  }
  await reviewMaster();
}

async function reviewMaster() {
  busy = true;
  setStatus("Reading your CV", true);
  paintChips();
  try {
    review = await reviewCv({ masterCv: settings.masterCv, complete: askWriter });
    for (const change of review.changes.slice(0, 4)) note(change, { glyph: "·", quiet: true });
    card({
      title: review.roles.length ? "Roles that fit your CV" : "CV read",
      meta: review.roles.join(" · ") || review.summary,
      body: review.summary && review.roles.length ? review.summary : "",
      actions: [
        review.roles.length && {
          label: "Search these roles",
          primary: true,
          run: async () => {
            settings.rules = { ...settings.rules, roles: review.roles.join("\n") };
            await saveSettings(settings);
            findJobs(review.roles.join(", ")).catch(failed);
          },
        },
        review.fineTunedMarkdown?.trim() && {
          label: "Use the tightened draft",
          run: async () => {
            settings.masterCv = review.fineTunedMarkdown.trim();
            await saveSettings(settings);
            note("Master CV replaced with the tightened draft.", { glyph: "✓" });
          },
        },
      ].filter(Boolean),
    });
  } finally {
    busy = false;
    setStatus("Ready");
    paintChips();
  }
}

async function onFile(file) {
  busy = true;
  setStatus(`Reading ${file.name}`, true);
  paintChips();
  try {
    const text = await textFromCvFile(file);
    await ingestCv(text, `Read ${file.name}`);
  } catch (error) {
    failed(error);
  } finally {
    el.file.value = "";
    busy = false;
    paintChips();
  }
}

function askForCv() {
  card({
    title: "Start with your CV",
    body: "PDF, Word or text. Everything the docket writes is built from this file and adds nothing to it.",
    actions: [
      { label: "Upload CV", primary: true, run: () => el.file.click() },
      { label: "Paste instead", run: (box) => pasteBox(box) },
    ],
  });
}

function pasteBox(box) {
  if (box.querySelector("textarea")) return;
  const area = node("textarea", "paste");
  area.rows = 7;
  area.placeholder = "Paste the CV text here.";
  const save = node("button", "btn primary", "Save pasted CV");
  save.type = "button";
  save.addEventListener("click", () => {
    ingestCv(area.value, "Saved the pasted CV").catch(failed);
  });
  box.append(area, save);
  area.focus();
}

async function buildCvFor(job, rules = rulesFrom()) {
  if (!hasCv()) return null;
  let markdown = settings.masterCv;
  let fit = "";
  try {
    const tailored = await tailorCv({ masterCv: settings.masterCv, job, rules, complete: askWriter });
    if (tailored.skip && rules.skipPoorFit) return { skip: true, reason: tailored.skipReason || "Poor match" };
    markdown = tailored.tailoredMarkdown || settings.masterCv;
    fit = tailored.fit || "";
    note(tailored.untailored ? "Kept the master CV unchanged" : `Tailored the CV${fit ? ` (${fit})` : ""}`, { glyph: "✎" });
    if (tailored.coverLetter) settings.profile = { ...settings.profile, coverNote: tailored.coverLetter };
  } catch (error) {
    note(`Could not tailor: ${error.message}. Attaching the master CV.`, { glyph: "!", quiet: true });
  }
  cvBytes = buildDocx(markdown, rules.pageSize);
  cvFile = { base64: bytesToBase64(cvBytes), filename: docxFilename(settings.profile, job), mime: DOCX_MIME };
  return { skip: false, fit };
}

function downloadCv() {
  if (!cvBytes) return;
  const url = URL.createObjectURL(new Blob([cvBytes], { type: DOCX_MIME }));
  const link = document.createElement("a");
  link.href = url;
  link.download = cvFile?.filename || "CV.docx";
  link.click();
  URL.revokeObjectURL(url);
}

/* ---------- rules ---------- */

function rulesFrom() {
  const raw = settings?.rules || {};
  return {
    avoidCompanies: parseLines(raw.avoidCompanies),
    avoidRegions: parseLines(raw.avoidRegions),
    dos: parseLines(raw.dos),
    donts: parseLines(raw.donts),
    roles: parseLines(raw.roles),
    boards: parseLines(raw.boards),
    pageSize: raw.pageSize || "a4",
    skipPoorFit: raw.skipPoorFit !== false,
    pauseBeforeSubmit: raw.pauseBeforeSubmit !== false,
    showPointer: raw.showPointer !== false,
    maxApplications: Number(raw.maxApplications) || 5,
  };
}

/* ---------- queue ---------- */

function enqueue(job) {
  if (!job?.url) return false;
  if (queue.some((item) => item.url === job.url)) return false;
  if ((settings.applications || []).some((item) => item.url === job.url && item.status === "applied")) return false;
  queue.push(job);
  return true;
}

function paintQueue() {
  el.queueCount.textContent = String(queue.length);
  saveQueue(queue).catch(() => {});
  const pane = el.panes.queue;
  pane.replaceChildren();
  if (!queue.length) {
    pane.append(node("p", "empty", "Nothing queued. Ask the docket to find jobs."));
    return;
  }
  for (const job of queue) {
    const row = node("div", "item");
    const grow = node("div", "grow");
    grow.append(node("strong", null, job.title || job.url));
    grow.append(node("small", null, [
      job.fit != null ? `fit ${job.fit}/100` : "",
      job.company,
      job.location,
      job.source,
    ].filter(Boolean).join(" · ")));
    if (job.why) grow.append(node("small", "why", job.why));
    const open = node("button", "btn", "Apply");
    open.type = "button";
    open.addEventListener("click", () => applyToJob(job).catch(failed));
    const drop = node("button", "icon", "×");
    drop.type = "button";
    drop.title = "Remove";
    drop.addEventListener("click", () => {
      queue = queue.filter((item) => item.url !== job.url);
      paintQueue();
    });
    row.append(grow, open, drop);
    pane.append(row);
  }
}

function paintFiled() {
  const pane = el.panes.filed;
  pane.replaceChildren();
  const rows = settings?.applications || [];
  if (!rows.length) {
    pane.append(node("p", "empty", "Nothing filed yet."));
    return;
  }
  for (const entry of rows.slice(0, 40)) {
    const row = node("div", "item");
    const grow = node("div", "grow");
    grow.append(node("strong", null, entry.title || entry.url));
    grow.append(node("small", null, [entry.company, new Date(entry.at).toLocaleDateString()].filter(Boolean).join(" · ")));
    row.append(grow);
    pane.append(row);
  }
}

function paintCvPane() {
  const pane = el.panes.cv;
  pane.replaceChildren();
  const box = node("div", "item");
  const grow = node("div", "grow");
  grow.append(node("strong", null, hasCv() ? "Master CV saved" : "No CV yet"));
  grow.append(node("small", null, hasCv() ? `${settings.masterCv.trim().split(/\s+/).length} words` : "Upload a PDF, Word file or text"));
  const change = node("button", "btn", hasCv() ? "Replace" : "Upload");
  change.type = "button";
  change.addEventListener("click", () => el.file.click());
  box.append(grow, change);
  pane.append(box);
  if (cvBytes) {
    const save = node("button", "btn", `Download ${cvFile.filename}`);
    save.type = "button";
    save.addEventListener("click", downloadCv);
    pane.append(save);
  }
  const rules = node("button", "btn", "Open rules and profile");
  rules.type = "button";
  rules.addEventListener("click", () => chrome.runtime.openOptionsPage());
  pane.append(rules);
}

function showDrawer(pane) {
  el.drawer.hidden = false;
  for (const button of document.querySelectorAll(".drawer-tab")) {
    button.classList.toggle("is-on", button.dataset.pane === pane);
  }
  for (const [name, element] of Object.entries(el.panes)) element.hidden = name !== pane;
  if (pane === "queue") paintQueue();
  if (pane === "filed") paintFiled();
  if (pane === "cv") paintCvPane();
  el.queueToggle.setAttribute("aria-expanded", "true");
}

/* ---------- chips ---------- */

const CHIPS = [
  { id: "find", label: "Find jobs", run: () => findJobs() },
  { id: "read", label: "Read this page", run: () => readHere() },
  { id: "apply", label: "Apply here", run: () => applyHere() },
  { id: "audit", label: "Audit and rank", run: () => auditQueue() },
  { id: "queue", label: "Run the queue", run: () => runQueue() },
  { id: "check", label: "Check setup", run: () => diagnose() },
];

function paintChips() {
  el.chips.replaceChildren();
  for (const chip of CHIPS) {
    const button = node("button", "chip", chip.label);
    button.type = "button";
    button.disabled = busy;
    button.addEventListener("click", () => {
      chip.run().catch(failed);
    });
    el.chips.append(button);
  }
  if (busy) {
    const stop = node("button", "chip hot", "Stop");
    stop.type = "button";
    stop.addEventListener("click", stopRun);
    el.chips.append(stop);
  }
  el.send.disabled = busy;
}

function stopRun() {
  stopFlag = true;
  pending = null;
  busy = false;
  setStatus("Stopped");
  note("Stopped.", { glyph: "■" });
  paintChips();
}

/* ---------- running ---------- */

const GLYPHS = {
  click: "▸",
  type: "✎",
  select: "▾",
  upload_cv: "📎",
  scroll: "↓",
  navigate: "→",
  collect: "≡",
  ask_human: "!",
  ready_to_submit: "✓",
  done: "✓",
};

let lastPage = null;

function controlOf(ref) {
  return (lastPage?.outline || []).find((row) => row.ref === ref) || null;
}

function stepNote(step) {
  const control = step.ref ? controlOf(step.ref) : null;
  const detail = [
    ["Action", step.action],
    ["On", control ? `${control.kind} "${control.label || "(no label)"}"` : step.ref || ""],
    ["Typed", step.action === "type" ? step.text : ""],
    ["Chose", step.action === "select" ? step.value : ""],
    ["Link", step.url || control?.href || ""],
    ["Why it did this", step.why || ""],
    ["Page", lastPage?.url || ""],
  ].filter(([, value]) => value);
  const label = {
    click: `Clicked ${step.ref}`,
    type: `Typed into ${step.ref}`,
    select: `Chose ${step.value}`,
    upload_cv: "Attached the CV",
    scroll: "Scrolled down",
    navigate: `Opened ${step.url}`,
    collect: `Found ${step.jobs?.length || 0} postings`,
    ask_human: "Needs you",
    ready_to_submit: "Form is filled",
    done: "Finished",
  }[step.action] || step.action;
  note(label, { glyph: GLYPHS[step.action] || "·", why: step.why, detail });
}

/**
 * `at` is mutable on purpose: a click can move the run to a tab the browser
 * opened, and every later step has to land there, not on the page left behind.
 */
function loopDeps(tabId, { sendApproved = () => false } = {}) {
  const at = { id: tabId };
  return {
    at,
    who: whoBlock(deriveNames(settings.profile || {}), cvFacts(settings.masterCv)),
    get attached() {
      return attachedName;
    },
    readPage: async () => {
      lastPage = await readPage(at.id);
      return lastPage;
    },
    act: async (action) => {
      const watching = action.type === "click" ? openedTabFrom(at.id) : null;
      const result = await act(at.id, { ...action, quiet: rulesFrom().showPointer === false });
      if (watching) {
        const opened = await watching;
        if (opened?.id) {
          at.id = opened.id;
          setWorkTab(opened.id);
          await refreshTab().catch(() => {});
          note(`That opened a new tab — following it`, {
            glyph: "→",
            detail: [["New page", opened.url], ["Title", opened.title || ""]],
          });
        }
      }
      return result;
    },
    scroll: (action) => scroll(at.id, action),
    navigate: (url) => navigate(at.id, url),
    wait: () => sleep(650),
    ask: askBrowse,
    onStep: stepNote,
    shouldStop: () => stopFlag,
    sendApproved,
    cvFile,
  };
}

async function drive(tabId, { mode = "apply", note: hint = "", job = null, approved = false, ignoreCaptcha = false } = {}) {
  const deps = loopDeps(tabId, { sendApproved: () => approved });
  const result = await runLoop(deps, { mode, note: hint, ignoreCaptcha });
  tabId = deps.at.id;
  if (result.status === "needs-human" || result.status === "blocked") {
    pending = { tabId, mode, job, ignoreCaptcha };
    card({
      title: "Over to you",
      body: result.message,
      tone: "ask",
      actions: [
        { label: "I've done it", primary: true, run: () => continueRun().catch(failed) },
        // The detector can be wrong, and the person is looking at the page.
        result.reason === "captcha" && {
          label: "There is no captcha",
          run: () => continueRun({ ignoreCaptcha: true }).catch(failed),
        },
        { label: "Show me the tab", run: () => focusTab(tabId) },
        { label: "Skip this one", run: () => { pending = null; note("Skipped.", { glyph: "·" }); } },
      ].filter(Boolean),
    });
    return result;
  }
  if (result.status === "ready-to-submit") {
    pending = { tabId, mode, job, submit: result.submit };
    card({
      title: "Ready to send",
      body: result.message,
      tone: "good",
      actions: [
        { label: `Send it`, primary: true, run: () => sendApplication().catch(failed) },
        cvBytes && { label: "Read the CV first", run: downloadCv },
        { label: "Skip", danger: true, run: () => { pending = null; note("Left unsent.", { glyph: "·" }); } },
      ].filter(Boolean),
    });
    return result;
  }
  if (result.status === "collected") {
    const kept = [];
    const rules = rulesFrom();
    for (const found of result.collected) {
      const screen = screenJob(found, rules);
      if (screen.decision === "skip") continue;
      if (enqueue({ ...found, source: "This page" })) kept.push(found);
    }
    note(`Queued ${kept.length} of ${result.collected.length} postings on this page.`, { glyph: "≡" });
    paintQueue();
    return result;
  }
  if (result.status === "done" && result.message) note(result.message, { glyph: "✓" });
  return result;
}

async function continueRun({ ignoreCaptcha = false } = {}) {
  if (!pending) return;
  const { tabId, mode, job } = pending;
  const skipCaptcha = ignoreCaptcha || pending.ignoreCaptcha;
  pending = null;
  busy = true;
  stopFlag = false;
  setStatus("Working", true);
  paintChips();
  try {
    await drive(tabId, { mode, job, ignoreCaptcha: skipCaptcha, note: "The person says they handled it. Carry on." });
  } finally {
    busy = false;
    setStatus("Ready");
    paintChips();
  }
}

async function sendApplication() {
  if (!pending?.submit) return;
  const { tabId, submit, job } = pending;
  pending = null;
  busy = true;
  setStatus("Sending", true);
  paintChips();
  try {
    await act(tabId, { type: "click", ref: submit.ref, frameId: submit.frameId });
    await sleep(2500);
    const after = await readPage(tabId).catch(() => null);
    const sent = Boolean(after?.confirmation);
    if (job?.url) {
      settings.applications = await rememberApplication({
        url: job.url,
        title: job.title,
        company: job.company,
        location: job.location,
        status: "applied",
      });
      queue = queue.filter((item) => item.url !== job.url);
      paintQueue();
    }
    card({
      title: sent ? "Application sent" : "Pressed send",
      body: sent ? "The page showed a confirmation." : "No confirmation text on the page yet. Check the tab.",
      tone: sent ? "good" : "ask",
    });
  } finally {
    busy = false;
    setStatus("Ready");
    paintChips();
  }
}

/* ---------- commands ---------- */

async function findJobs(query = "") {
  if (!hasCv() && !query) {
    askForCv();
    return;
  }
  busy = true;
  stopFlag = false;
  setStatus("Searching", true);
  paintChips();
  try {
    const rules = rulesFrom();
    const roles = query ? [query] : rules.roles.length ? rules.roles : ["engineer"];
    const wants = { roles, dos: rules.dos, location: settings.profile?.location || "" };

    // Company boards first: they carry far more than any keyword feed, and they
    // never need a login. Then the feeds, for anything the boards miss.
    note(`Reading ${boardTargets().length} company boards for ${roles.join(", ")}`, { glyph: "⌕", grouped: false });
    const boardJobs = await sweepBoards(boardTargets(), {
      concurrency: 8,
      onNote: (line) => note(line, { glyph: "·", quiet: true }),
    });
    note(`${boardJobs.length} open roles across those boards`, { glyph: "≡" });

    const { jobs: feedRows, problems } = await feedJobs(roles);
    for (const problem of problems) note(problem, { glyph: "!", quiet: true });

    const everything = [...boardJobs, ...feedRows];
    learnBoards(everything);

    let kept = 0;
    let outsideRoles = 0;
    let byRules = 0;
    let already = 0;
    for (const job of rank(everything, wants, 400)) {
      const screen = screenJob(job, rules);
      if (screen.decision === "skip") {
        if (/outside the roles/.test(screen.reason)) outsideRoles += 1;
        else byRules += 1;
        continue;
      }
      if (enqueue(job)) kept += 1;
      else already += 1;
      if (kept >= 60) break;
    }
    paintQueue();

    const breakdown = [
      `${everything.length} postings read`,
      outsideRoles ? `${outsideRoles} outside your roles` : "",
      byRules ? `${byRules} stopped by your other rules` : "",
      already ? `${already} already seen` : "",
    ].filter(Boolean).join(" · ");

    card({
      title: kept ? `${kept} jobs queued` : "Nothing passed your rules",
      meta: breakdown,
      body: kept
        ? "Open the queue, or say \"run the queue\"."
        : "Your roles may be narrower than the titles employers use. Widen them, or queue the best matches anyway.",
      tone: kept ? "" : "ask",
      actions: [
        kept ? { label: "Open the queue", primary: true, run: () => showDrawer("queue") } : null,
        !kept && everything.length ? {
          label: "Queue the 20 closest anyway",
          primary: true,
          run: () => {
            let added = 0;
            for (const job of rank(everything, wants, 20)) if (enqueue(job)) added += 1;
            paintQueue();
            note(`Queued ${added} by closeness, ignoring the role filter.`, { glyph: "≡" });
            showDrawer("queue");
          },
        } : null,
        { label: "Also search a company", run: () => askCompany() },
        { label: "Search LinkedIn in a tab", run: () => searchSite("linkedin", roles[0]).catch(failed) },
      ].filter(Boolean),
    });
  } finally {
    busy = false;
    setStatus("Ready");
    paintChips();
  }
}

/** The seed list plus every board a posting has revealed since. */
function boardTargets() {
  const extra = (settings.rules?.extraBoards || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const named = parseLines(settings.rules?.dos || "")
    .filter((line) => /^[a-z0-9 .&-]{2,40}$/i.test(line))
    .flatMap((name) => targetsForCompany(name));
  const seen = new Set();
  return [...seedTargets(), ...extra.map((entry) => {
    const [system, slug] = entry.split(":");
    return system && slug ? { system, slug } : null;
  }).filter(Boolean), ...named].filter((target) => {
    const key = `${target.system}:${target.slug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every posting names a board. Remember it, so the reach grows each run. */
async function learnBoards(jobs) {
  const known = new Set((settings.rules?.extraBoards || "").split("\n").map((line) => line.trim()).filter(Boolean));
  const before = known.size;
  for (const job of jobs) {
    const board = boardFromUrl(job.url);
    if (board) known.add(`${board.system}:${board.slug}`);
  }
  if (known.size === before) return;
  settings.rules = { ...settings.rules, extraBoards: [...known].slice(0, 2000).join("\n") };
  await saveSettings(settings);
  note(`Learned ${known.size - before} new company board${known.size - before === 1 ? "" : "s"} for next time`, { glyph: "✓", quiet: true });
}

function askCompany() {
  const box = card({
    title: "Search one company",
    body: "Type a company name. The docket tries its board on Greenhouse, Lever, Ashby and SmartRecruiters.",
  });
  const input = node("textarea", "paste");
  input.rows = 1;
  input.placeholder = "Monzo";
  const go = node("button", "btn primary", "Search it");
  go.type = "button";
  go.addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) return;
    busy = true;
    setStatus(`Looking up ${name}`, true);
    paintChips();
    try {
      const found = await sweepBoards(targetsForCompany(name), { concurrency: 4 });
      const rules = rulesFrom();
      let kept = 0;
      for (const job of rank(found, { roles: rules.roles, dos: rules.dos }, 200)) {
        if (screenJob(job, rules).decision === "skip") continue;
        if (enqueue(job)) kept += 1;
      }
      paintQueue();
      note(found.length ? `${name}: ${found.length} open roles, ${kept} queued` : `No public board found for ${name}`, { glyph: found.length ? "≡" : "·" });
    } finally {
      busy = false;
      setStatus("Ready");
      paintChips();
    }
  });
  box.append(input, go);
  input.focus();
}

async function searchSite(id, query) {
  const site = SITE_SEARCHES.find((entry) => entry.id === id);
  const where = settings?.profile?.location || "";
  const url = siteSearchUrl(id, query || rulesFrom().roles[0] || "engineer", where);
  if (!url) throw new Error("That site is not set up.");
  busy = true;
  stopFlag = false;
  setStatus(`Reading ${site.name}`, true);
  paintChips();
  try {
    const opened = await openTab(url);
    await refreshTab();
    note(`Opened ${site.name}${site.needsLogin ? " — sign in there if it asks" : ""}`, { glyph: "→" });
    await sleep(1500);
    await drive(opened.id, { mode: "search", note: "This is a list of jobs. Collect the postings worth opening." });
  } finally {
    busy = false;
    setStatus("Ready");
    paintChips();
  }
}

async function readHere() {
  busy = true;
  setStatus("Reading the page", true);
  paintChips();
  try {
    await refreshTab({ create: false });
    const page = await readPage(tab.id);
    const job = page.job || {};
    const isJob = Boolean(job.title && (job.company || job.description?.length > 200));
    const listings = page.listings || [];
    card({
      title: job.title || page.title || "This page",
      meta: [job.company, job.location].filter(Boolean).join(" · ") || new URL(page.url).hostname,
      body: isJob ? (job.description || "").slice(0, 280) : `${listings.length} postings and ${(page.outline || []).length} things to click.`,
      link: page.url,
      actions: [
        isJob ? { label: "Apply to this", primary: true, run: () => applyToJob({ ...job, url: page.url }).catch(failed) } : null,
        isJob ? { label: "Queue it", run: () => { enqueue({ ...job, url: page.url }); paintQueue(); note("Queued.", { glyph: "≡" }); } } : null,
        listings.length ? { label: `Queue ${listings.length} postings`, primary: true, run: () => {
          const rules = rulesFrom();
          let kept = 0;
          for (const listing of listings) {
            if (screenJob(listing, rules).decision === "skip") continue;
            if (enqueue(listing)) kept += 1;
          }
          paintQueue();
          note(`Queued ${kept}.`, { glyph: "≡" });
        } } : null,
        { label: "Let the agent decide", run: () => drive(tab.id, { mode: "apply" }).catch(failed) },
      ].filter(Boolean),
    });
  } finally {
    busy = false;
    setStatus("Ready");
    paintChips();
  }
}

async function applyHere() {
  await refreshTab({ create: false });
  const page = await readPage(tab.id);
  await applyToJob({ ...(page.job || {}), url: page.url || tab.url }, tab.id);
}


/**
 * A skip is shown, never silent, and always overridable. The reason belongs to
 * the person: they know what they can defend in a first call.
 */
function heldBack(job, title, reason) {
  card({
    title,
    body: reason || "No reason given.",
    tone: "ask",
    actions: [
      {
        label: "Apply anyway",
        primary: true,
        run: () => applyToJob(job, null, true).catch(failed),
      },
      {
        label: "Drop it",
        run: () => {
          queue = queue.filter((item) => item.url !== job.url);
          paintQueue();
          note("Dropped from the queue.", { glyph: "·" });
        },
      },
      {
        label: "Open the posting",
        run: () => chrome.tabs.create({ url: job.url }),
      },
    ],
  });
}

async function applyToJob(job, existingTabId = null, force = false) {
  if (!hasCv()) {
    askForCv();
    return;
  }
  busy = true;
  stopFlag = false;
  pending = null;
  setStatus(`Applying: ${job.title || job.url}`, true);
  paintChips();
  try {
    note(job.title ? `${job.title}${job.company ? ` at ${job.company}` : ""}` : job.url, { glyph: "◎", grouped: false });
    let tabId = existingTabId;
    if (!tabId) {
      await refreshTab({ create: true, url: job.url });
      tabId = tab.id;
      note(`Opening ${new URL(job.url).hostname.replace(/^www\./, "")}`, { glyph: "→" });
      await navigate(tabId, job.url);
      await refreshTab();
    }

    const rules = force ? { ...rulesFrom(), skipPoorFit: false } : rulesFrom();
    const screen = force ? { decision: "keep" } : screenJob(job, rules);
    if (screen.decision === "skip") {
      heldBack(job, "Your rules say no", screen.reason);
      return;
    }

    const built = await buildCvFor(job, rules);
    if (built?.skip) {
      heldBack(job, "The agent thinks this is a stretch", built.reason);
      return;
    }

    await resetSession("browse").catch(() => {});
    attachedName = "";
    await prefill(tabId);
    await drive(tabId, {
      mode: "apply",
      job,
      approved: rules.pauseBeforeSubmit === false,
      note: `Apply for "${job.title || "this role"}". The CV is ready to attach with upload_cv.`,
    });
  } finally {
    busy = false;
    setStatus("Ready");
    paintChips();
  }
}


/** Fills what the profile already answers, so the agent only handles the rest. */
async function prefill(tabId) {
  let page;
  try {
    page = await readPage(tabId);
  } catch {
    return 0;
  }
  const profile = { ...settings.profile, coverNote: settings.profile?.coverNote || "" };
  const { planned } = planFields(page.fields, profile);
  let done = 0;
  const attached = [];
  const failures = [];
  for (const action of planned) {
    if (action.type === "upload") {
      if (!cvFile) {
        failures.push(`${action.label || "attachment"}: no CV file was ready`);
        continue;
      }
      try {
        await act(tabId, { ...action, base64: cvFile.base64, filename: cvFile.filename, mime: cvFile.mime });
        attached.push(action.label || "Resume");
        attachedName = cvFile.filename;
      } catch (error) {
        failures.push(`${action.label || "attachment"}: ${error.message}`);
      }
      continue;
    }
    try {
      await act(tabId, action);
      done += 1;
    } catch (error) {
      failures.push(`${action.kind || "field"}: ${error.message}`);
    }
  }
  if (done) note(`Filled ${done} field${done === 1 ? "" : "s"} from your profile`, { glyph: "✎" });
  if (attached.length) {
    note(`Attached ${cvFile.filename} to ${attached.join(" and ")}`, {
      glyph: "📎",
      detail: [["File", cvFile.filename], ["Controls", attached.join(", ")]],
    });
  } else if (planned.some((action) => action.type === "upload")) {
    note("Found an attachment control but could not attach the CV", { glyph: "!", detail: failures.map((line) => ["Problem", line]) });
  } else {
    note("No attachment control on this page yet", { glyph: "·", quiet: true });
  }
  if (failures.length && attached.length) {
    note(`${failures.length} field${failures.length === 1 ? "" : "s"} refused the value`, { glyph: "!", quiet: true, detail: failures.map((line) => ["Problem", line]) });
  }
  return done;
}

async function runQueue() {
  if (!queue.length) {
    note("The queue is empty.", { glyph: "·" });
    return;
  }
  const limit = rulesFrom().maxApplications;
  const batch = queue.slice(0, limit);
  note(`Working through ${batch.length} of ${queue.length}.`, { glyph: "≡", grouped: false });
  for (const job of batch) {
    if (stopFlag) break;
    await applyToJob(job);
    if (pending) break;
  }
}


/* ---------- diagnostics ---------- */

async function timed(run) {
  const started = Date.now();
  try {
    const value = await run();
    return { ok: true, value, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), ms: Date.now() - started };
  }
}

/** Five checks that cover every way a run can fail silently. */
async function diagnose() {
  busy = true;
  setStatus("Checking", true);
  paintChips();
  const lines = [];
  const say = (ok, text) => {
    lines.push(`${ok ? "✓" : "✗"} ${text}`);
    note(text, { glyph: ok ? "✓" : "✗", quiet: ok });
  };
  try {
    const bridge = await timed(() => listAgents());
    say(bridge.ok, bridge.ok
      ? `Agent bridge answered in ${bridge.ms}ms: ${bridge.value.filter((a) => a.installed).map((a) => a.label).join(", ") || "nothing installed"}`
      : `Agent bridge: ${bridge.error}`);

    const think = bridge.ok ? await timed(() => askBrowse('URL: about:blank\nCONTROLS:\nnone visible\n\nAnswer {"action":"done","summary":"check"}.')) : null;
    if (think) say(think.ok, think.ok ? `Agent answered a step in ${(think.ms / 1000).toFixed(1)}s` : `Agent step: ${think.error}`);

    const found = await timed(() => refreshTab({ create: false }));
    say(found.ok, found.ok ? `Working tab: ${tab.url}` : `No working tab: ${found.error}`);

    if (found.ok) {
      const page = await timed(() => readPage(tab.id));
      say(page.ok, page.ok
        ? `Read the page: ${(page.value.outline || []).length} controls, ${(page.value.fields || []).length} form fields, ${(page.value.listings || []).length} listings`
        : `Cannot read the page: ${page.error}`);

      if (page.ok) {
        const first = (page.value.outline || []).find((row) => row.kind === "input" || row.kind === "textarea");
        if (first) {
          const touch = await timed(() => act(tab.id, { type: "fill", ref: first.ref, label: first.label, value: "", frameId: first.frameId }));
          say(touch.ok, touch.ok ? `Controlled the page: touched "${first.label || first.ref}"` : `Cannot control the page: ${touch.error}`);
        } else {
          say(true, "No text field on this page to test a fill against. Open a job application form and check again.");
        }
      }
    }

    const missing = ["fullName", "email", "phone"].filter((key) => !settings?.profile?.[key]?.trim());
    say(missing.length === 0, missing.length
      ? `Profile gaps the forms will stop on: ${missing.join(", ")}. Open the gear to fill them.`
      : "Profile has a name, an email and a phone number");
    say(hasCv(), hasCv() ? "Master CV is saved" : "No master CV yet");

    const report = lines.join("\n");
    card({
      title: "Setup check",
      body: lines.some((line) => line.startsWith("✗")) ? "Fix the lines marked ✗ above." : "Everything the run needs is working.",
      actions: [{ label: "Copy this report", run: () => navigator.clipboard.writeText(report).then(() => note("Copied.", { glyph: "·" })) }],
      tone: lines.some((line) => line.startsWith("✗")) ? "ask" : "good",
    });
  } finally {
    busy = false;
    setStatus("Ready");
    paintChips();
  }
}


/**
 * Scoring by arithmetic cannot read a CV. This hands the shortlist to the agent
 * with the CV and asks it to judge the work, then shows the ten it would back.
 */
async function auditQueue() {
  const pool = queue.length ? queue : [];
  if (!pool.length) {
    note("Nothing to audit yet. Run Find jobs first.", { glyph: "·" });
    return;
  }
  if (!hasCv()) {
    askForCv();
    return;
  }
  busy = true;
  stopFlag = false;
  setStatus("Auditing", true);
  paintChips();
  try {
    const rules = rulesFrom();
    note(`Reading your CV against ${pool.length} postings`, { glyph: "⌕", grouped: false });
    const { judged, best } = await auditJobs({
      jobs: pool,
      cv: settings.masterCv,
      profile: settings.profile,
      rules,
      ask: askAudit,
      size: 25,
      top: 10,
      onBatch: (index, total, error) => {
        if (error) note(`Batch ${index} of ${total} failed: ${error}`, { glyph: "!", quiet: true });
        else setStatus(`Auditing ${index} of ${total}`, true);
      },
    });
    if (!judged.length) {
      card({ title: "The audit came back empty", body: "The agent did not return a usable answer. Try again, or run Check setup.", tone: "bad" });
      return;
    }

    // Keep the verdicts, so the queue shows them and the order means something.
    const byUrl = new Map(judged.map((job) => [job.url, job]));
    queue = queue.map((job) => ({ ...job, ...(byUrl.get(job.url) || {}) }))
      .sort((a, b) => (b.fit || 0) - (a.fit || 0));
    paintQueue();

    note(`Judged ${judged.length}: ${judged.filter((job) => job.fit >= 70).length} worth applying to, ${judged.filter((job) => job.fit < 50).length} not`, { glyph: "≡" });

    for (const [index, job] of best.entries()) {
      card({
        title: `${index + 1}. ${job.title}`,
        meta: `${[job.company, job.location].filter(Boolean).join(" · ")} — fit ${job.fit}/100`,
        body: job.why + (job.gap ? `\nGap: ${job.gap}` : ""),
        link: job.url,
        tone: job.fit >= 70 ? "good" : "",
        actions: [
          { label: "Apply to this", primary: index === 0, run: () => applyToJob(job).catch(failed) },
          { label: "Open it", run: () => chrome.tabs.create({ url: job.url }) },
        ],
      });
    }
  } finally {
    busy = false;
    setStatus("Ready");
    paintChips();
  }
}

/* ---------- composer ---------- */

async function say(text) {
  said(text);
  el.input.value = "";
  el.input.style.height = "auto";
  busy = true;
  setStatus("Thinking", true);
  paintChips();
  let routed = null;
  try {
    routed = await askRouter(text);
  } catch (error) {
    note(error.message, { glyph: "!", quiet: true });
  } finally {
    busy = false;
    paintChips();
  }
  const intent = routed?.intent || "";
  if (!intent) {
    // Guessing "search" on anything unrecognised wasted a sweep and confused people.
    card({
      title: "What did you mean?",
      body: `"${text.slice(0, 80)}"`,
      tone: "ask",
      actions: [
        { label: "Search for this", primary: true, run: () => findJobs(text).catch(failed) },
        { label: "Rank what I have", run: () => auditQueue().catch(failed) },
        { label: "Work the open page", run: () => applyHere().catch(failed) },
      ],
    });
    setStatus("Ready");
    return;
  }
  if (intent === "chat" && routed.reply) {
    note(routed.reply, { glyph: "·", grouped: false });
    setStatus("Ready");
    return;
  }
  if (intent === "stop") return stopRun();
  if (intent === "audit") return auditQueue();
  if (intent === "queue") return runQueue();
  if (intent === "read") return readHere();
  if (intent === "apply") return applyHere();
  return findJobs(routed?.query || text);
}

/* ---------- wiring ---------- */

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = el.input.value.trim();
  if (!text || busy) return;
  say(text).catch(failed);
});

el.input.addEventListener("input", () => {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 120)}px`;
});

el.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    el.form.requestSubmit();
  }
});

el.file.addEventListener("change", () => {
  const file = el.file.files?.[0];
  if (file) onFile(file).catch(failed);
});

el.tabChip.addEventListener("click", async () => {
  if (!tab?.id) {
    await useFrontTab().catch(failed);
    return;
  }
  const shown = await focusTab(tab.id);
  if (!shown) await useFrontTab().catch(failed);
});
el.tabUse.addEventListener("click", () => useFrontTab().catch(failed));
el.rulesOpen.addEventListener("click", () => chrome.runtime.openOptionsPage());
el.queueToggle.addEventListener("click", () => {
  if (el.drawer.hidden) showDrawer("queue");
  else el.drawer.hidden = true;
});
el.drawerClose.addEventListener("click", () => {
  el.drawer.hidden = true;
  el.queueToggle.setAttribute("aria-expanded", "false");
});
for (const button of document.querySelectorAll(".drawer-tab")) {
  button.addEventListener("click", () => showDrawer(button.dataset.pane));
}

chrome.tabs.onActivated.addListener(() => refreshTab().catch(() => {}));
chrome.tabs.onUpdated.addListener((id, info) => {
  if (tab && id === tab.id && info.status === "complete") refreshTab().catch(() => {});
});

watchBridge((state) => {
  el.conn.classList.toggle("on", state.connected);
  el.conn.classList.toggle("off", !state.connected);
});

async function start() {
  settings = await loadSettings();
  queue = settings.queue || [];
  paintChips();
  await refreshTab({ create: false }).catch(() => {});
  const ready = await checkBridge();
  if (!ready) {
    card({
      title: "No local agent yet",
      body: "The docket uses Claude Code already signed in on this Mac. Install it, run node bridge/install-host.mjs, quit Chrome fully and open it again.",
      tone: "bad",
    });
  }
  if (!hasCv()) {
    const hello = node("div", "empty");
    hello.append(node("h2", null, "Job Docket"));
    hello.append(node("p", null, "It reads the page you are on, tailors your CV, fills the form, and stops before anything is sent."));
    add(hello);
    askForCv();
  } else {
    note(`CV loaded. ${rulesFrom().roles.length ? `Roles: ${rulesFrom().roles.join(", ")}` : "No roles set yet."}`, { glyph: "✓", grouped: false });
  }
  paintQueue();
  if (queue.length) {
    note(`${queue.length} job${queue.length === 1 ? "" : "s"} still in the queue from last time`, { glyph: "≡", grouped: false });
  }
}

start().catch(failed);
