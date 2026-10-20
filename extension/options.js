import { listAgents, askAgent } from "./lib/agent-bridge.mjs";
import { loadSettings, saveSettings } from "./lib/storage.mjs";
import { FIELD_NAMES, mergeProfile, profileFromAgent, profileFromCv } from "./lib/profile.mjs";
import { extractJson } from "./lib/tailor.mjs";

const PROFILE = ["fullName", "email", "phone", "location", "linkedin", "github", "website", "workAuth", "sponsorship", "salary", "notice", "coverNote"];
const TAG_FIELDS = ["roles", "dos", "avoidCompanies", "avoidRegions", "donts"];

const saved = document.querySelector("#saved");
const agentStatus = document.querySelector("#agent-status");
const agentSelect = document.querySelector("select[name=agent]");
const cvCount = document.querySelector("#cv-count");

let settings = null;
let saveTimer = null;

function field(name) {
  return document.querySelector(`[name="${name}"]`);
}

function splitLines(text) {
  return String(text || "")
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** One line per entry is what the rest of the docket reads. */
function joinLines(values) {
  return values.join("\n");
}

function flash(message = "Saved") {
  saved.textContent = message;
  saved.classList.add("show");
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => saved.classList.remove("show"), 1400);
}

function collect() {
  const profile = {};
  for (const key of PROFILE) profile[key] = field(key)?.value?.trim() || "";
  const rules = { ...settings.rules };
  for (const key of TAG_FIELDS) rules[key] = joinLines(tagValues(key));
  rules.boards = field("boards").value;
  rules.pageSize = field("pageSize").value === "letter" ? "letter" : "a4";
  rules.skipPoorFit = field("skipPoorFit").checked;
  rules.showPointer = field("showPointer").checked;
  rules.pauseBeforeSubmit = field("pauseBeforeSubmit").checked;
  rules.maxApplications = Math.max(1, Math.min(50, Number(field("maxApplications").value) || 5));
  return {
    ...settings,
    profile,
    rules,
    masterCv: field("masterCv").value,
    agent: { id: agentSelect.value || "auto" },
  };
}

/** Typing should never need a Save button to be found. */
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    settings = collect();
    await saveSettings(settings);
    flash();
    countCv();
  }, 400);
}

function countCv() {
  const words = field("masterCv").value.trim().split(/\s+/).filter(Boolean).length;
  cvCount.textContent = words ? `${words} words. Tailored copies never add to this.` : "Nothing saved yet. Upload a file in the side panel, or paste it here.";
}

/* ---------- tag editors ---------- */

const tagState = new Map();

function tagValues(name) {
  return tagState.get(name) || [];
}

function paintTags(box) {
  const name = box.dataset.field;
  const values = tagValues(name);
  box.replaceChildren();
  for (const value of values) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.append(document.createTextNode(value));
    const drop = document.createElement("button");
    drop.type = "button";
    drop.textContent = "×";
    drop.title = `Remove ${value}`;
    drop.addEventListener("click", () => {
      tagState.set(name, values.filter((kept) => kept !== value));
      paintTags(box);
      queueSave();
    });
    tag.append(drop);
    box.append(tag);
  }
  const input = document.createElement("input");
  input.placeholder = values.length ? "Add another" : placeholderFor(name);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(box, input.value);
      return;
    }
    if (event.key === "Backspace" && !input.value && values.length) {
      tagState.set(name, values.slice(0, -1));
      paintTags(box);
      queueSave();
    }
  });
  input.addEventListener("blur", () => addTag(box, input.value));
  input.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") || "";
    if (!/[\n,]/.test(text)) return;
    event.preventDefault();
    for (const line of splitLines(text)) addTag(box, line, false);
    paintTags(box);
    queueSave();
  });
  box.append(input);
  return input;
}

function addTag(box, raw, repaint = true) {
  const name = box.dataset.field;
  const value = String(raw || "").trim();
  if (!value) return;
  const values = tagValues(name);
  if (values.some((kept) => kept.toLowerCase() === value.toLowerCase())) return;
  tagState.set(name, [...values, value]);
  if (repaint) {
    const input = paintTags(box);
    input.focus();
    queueSave();
  }
}

function placeholderFor(name) {
  return {
    roles: "Staff Engineer, then Enter",
    dos: "Remote, TypeScript, Flutterwave…",
    avoidCompanies: "A company you will not work for",
    avoidRegions: "A place you will not move to",
    donts: "unpaid, security clearance, on-site 5 days",
  }[name] || "Add one, then Enter";
}

/* ---------- tabs ---------- */

for (const button of document.querySelectorAll(".tab")) {
  button.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".tab")) other.classList.toggle("is-on", other === button);
    for (const pane of document.querySelectorAll(".pane")) {
      pane.hidden = pane.id !== `pane-${button.dataset.pane}`;
    }
    location.hash = button.dataset.pane;
  });
}

/* ---------- agent ---------- */

async function fillAgents(selected) {
  try {
    const agents = await listAgents();
    for (const agent of agents) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.installed ? agent.label : `${agent.label} (not installed)`;
      option.disabled = !agent.installed;
      agentSelect.append(option);
    }
    agentSelect.value = selected || "auto";
    const ready = agents.filter((agent) => agent.installed).map((agent) => agent.label);
    agentStatus.textContent = ready.length ? `Found ${ready.join(" and ")}.` : "No local agent found. Install Claude Code, then reload.";
  } catch (error) {
    agentStatus.textContent = error.message;
  }
}

document.querySelector("#test-agent").addEventListener("click", async () => {
  agentStatus.textContent = "Asking…";
  const started = Date.now();
  try {
    const text = await askAgent({
      prompt: 'Reply with this JSON and nothing else: {"ready":true}',
      system: "You answer with one JSON object and nothing else.",
      session: "test",
      timeoutMs: 60000,
    });
    agentStatus.textContent = /ready/.test(text)
      ? `Answered in ${((Date.now() - started) / 1000).toFixed(1)}s.`
      : `Answered: ${text.slice(0, 80)}`;
  } catch (error) {
    agentStatus.textContent = error.message;
  }
});

/* ---------- start ---------- */

function paint(next) {
  settings = next;
  for (const key of PROFILE) {
    const input = field(key);
    if (input) input.value = settings.profile[key] || "";
  }
  field("boards").value = settings.rules.boards || "";
  field("masterCv").value = settings.masterCv || "";
  field("pageSize").value = settings.rules.pageSize === "letter" ? "letter" : "a4";
  field("skipPoorFit").checked = settings.rules.skipPoorFit !== false;
  field("showPointer").checked = settings.rules.showPointer !== false;
  field("pauseBeforeSubmit").checked = settings.rules.pauseBeforeSubmit !== false;
  field("maxApplications").value = settings.rules.maxApplications || 5;
  for (const box of document.querySelectorAll(".tags")) {
    tagState.set(box.dataset.field, splitLines(settings.rules[box.dataset.field]));
    paintTags(box);
  }
  countCv();
}

/** The side panel writes while this page is open, so follow the store. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
  loadSettings().then((next) => {
    paint(next);
    flash("Updated from the side panel");
  });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadSettings().then(paint);
});

document.querySelector("#reread").addEventListener("click", async () => {
  const cv = field("masterCv").value.trim();
  if (!cv) {
    flash("No CV saved yet");
    return;
  }
  flash("Reading your CV…");
  let found = profileFromCv(cv);
  const thin = ["fullName", "email", "phone", "location"].some((key) => !(found[key] || settings.profile[key]));
  if (thin) {
    try {
      found = { ...(await profileFromAgent(cv, (prompt) => askAgent({
        prompt,
        system: "You answer with one JSON object and nothing else.",
        session: "cv",
        timeoutMs: 90000,
      }), extractJson)), ...found };
    } catch (error) {
      flash(error.message.slice(0, 60));
    }
  }
  const { merged, filled } = mergeProfile(settings.profile, found);
  settings = { ...settings, profile: merged };
  await saveSettings(settings);
  paint(settings);
  flash(filled.length ? `Filled ${filled.map((key) => FIELD_NAMES[key] || key).join(", ")}` : "Nothing new to take from the CV");
});

async function start() {
  paint(await loadSettings());

  for (const input of document.querySelectorAll("input, select, textarea")) {
    if (input.closest(".tags")) continue;
    input.addEventListener("input", queueSave);
    input.addEventListener("change", queueSave);
  }

  const wanted = location.hash.replace("#", "");
  const tab = [...document.querySelectorAll(".tab")].find((button) => button.dataset.pane === wanted);
  if (tab) tab.click();
  await fillAgents(settings.agent?.id);
}

start();
