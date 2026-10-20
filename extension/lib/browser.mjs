import { mergeSnapshots } from "./pick.mjs";

const BLOCKED = /^(chrome|edge|about|devtools|view-source|file|chrome-extension):/i;

// The docket keeps its own working tab. Before this it read whatever tab happened
// to be in front, so clicking a button while Chrome's own settings page had focus
// answered "this page cannot be read" and the run died there.
let workTabId = null;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readable(url) {
  return /^https?:/i.test(String(url || ""));
}

export function setWorkTab(tabId) {
  workTabId = tabId || null;
  return workTabId;
}

export function workTabId_() {
  return workTabId;
}

async function liveTab(tabId) {
  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && readable(tab.url) ? tab : null;
  } catch {
    return null;
  }
}

async function frontTab() {
  const queries = [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
  ];
  for (const query of queries) {
    const [tab] = await chrome.tabs.query(query);
    if (tab?.id && readable(tab.url)) return tab;
  }
  return null;
}

async function anyReadableTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab.id && readable(tab.url) && !tab.discarded) || null;
}

export async function openTab(url, { active = true } = {}) {
  const tab = await chrome.tabs.create({ url: url || "about:blank", active });
  workTabId = tab.id;
  if (url) await waitForLoad(tab.id);
  return tab;
}

/**
 * The tab the docket is working in. It prefers the tab it already owns, then the
 * tab in front, then any readable tab, and only opens a new one when asked to.
 */
export async function targetTab({ create = false, url = "" } = {}) {
  const owned = await liveTab(workTabId);
  if (owned) return owned;
  const front = await frontTab();
  if (front) {
    workTabId = front.id;
    return front;
  }
  const spare = await anyReadableTab();
  if (spare) {
    workTabId = spare.id;
    return spare;
  }
  if (create) return openTab(url || "about:blank");
  throw new Error("No web page is open to work in. Open a job page in a tab, or use Search, and the docket will open one for you.");
}

export async function activeTab() {
  return targetTab();
}

export async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/page-agent.js"],
    });
  } catch (error) {
    const message = String(error?.message || error);
    if (/cannot be scripted|Cannot access|chrome:\/\//i.test(message)) {
      throw new Error("Chrome blocks extensions on this page. Open the job on its own site and try again.");
    }
    throw error;
  }
}

function stampControl(control, frameId) {
  return control ? { ...control, frameId } : null;
}

function stampSnapshot(snapshot, frameId) {
  return {
    ...snapshot,
    frameId,
    fields: (snapshot.fields || []).map((field) => ({ ...field, frameId })),
    outline: (snapshot.outline || []).map((row) => ({ ...row, frameId })),
    apply: stampControl(snapshot.apply, frameId),
    submit: stampControl(snapshot.submit, frameId),
    next: stampControl(snapshot.next, frameId),
  };
}

export async function readPage(tabId, { retries = 1 } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!readable(tab?.url)) {
    throw new Error(`This tab is showing ${tab?.url ? new URL(tab.url).protocol : "a Chrome page"}, which extensions cannot read. Open the job on its own site.`);
  }
  await ensureInjected(tabId);
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const snapshots = [];
  for (const frame of frames || []) {
    try {
      const response = await chrome.tabs.sendMessage(
        tabId,
        { type: "JOB_AGENT_SNAPSHOT" },
        { frameId: frame.frameId },
      );
      if (response?.ok) snapshots.push(stampSnapshot(response.snapshot, frame.frameId));
    } catch {
      // The frame did not accept the reader. Other frames may still be usable.
    }
  }
  const page = mergeSnapshots(snapshots);
  if (page) return page;
  if (retries > 0) {
    await sleep(1200);
    return readPage(tabId, { retries: retries - 1 });
  }
  throw new Error("Nothing readable came back from this page. It may still be loading, or it may be blocking extensions.");
}


/**
 * Some Apply buttons open a tab instead of navigating. The run has to follow,
 * or it sits on the old page describing a form that moved.
 */
export function openedTabFrom(tabId, waitMs = 3500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (tab) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onCreated.removeListener(onCreated);
      clearTimeout(timer);
      resolve(tab || null);
    };
    const onCreated = async (tab) => {
      if (tab.openerTabId !== tabId) return;
      if (!tab.id) return;
      await waitForLoad(tab.id, 12000);
      const settledTab = await chrome.tabs.get(tab.id).catch(() => null);
      finish(settledTab && readable(settledTab.url) ? settledTab : null);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    chrome.tabs.onCreated.addListener(onCreated);
  });
}

export async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return true;
}

export async function act(tabId, action) {
  const response = await chrome.tabs.sendMessage(
    tabId,
    { type: "JOB_AGENT_ACT", action },
    { frameId: action.frameId || 0 },
  );
  if (!response?.ok) throw new Error(response?.error || "The page did not accept that action.");
  return response.result;
}

export async function scroll(tabId, action = {}) {
  const response = await chrome.tabs.sendMessage(
    tabId,
    { type: "JOB_AGENT_SCROLL", action },
    { frameId: action.frameId || 0 },
  );
  if (!response?.ok) throw new Error(response?.error || "The page did not scroll.");
  return response.result;
}

export function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(finish, timeout);
  });
}

export async function navigate(tabId, url) {
  if (!url) throw new Error("This job has no link.");
  if (!readable(url)) throw new Error("The docket only opens http and https links.");
  const tab = await chrome.tabs.get(tabId);
  if (tab.url === url) {
    await sleep(400);
    return;
  }
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForLoad(tabId);
  await sleep(700);
}
