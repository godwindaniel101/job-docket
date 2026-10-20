export const HOST = "com.jobdocket.agent";

// One port stays open for the life of the side panel. Chrome spawns the bridge
// once, the bridge holds one agent session, and a step costs seconds instead of
// the fourteen a cold start used to cost.
let port = null;
let nextId = 1;
const waiting = new Map();
let onStatus = () => {};

function failAll(message) {
  for (const [, entry] of waiting) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }
  waiting.clear();
}

function describe(message) {
  const text = String(message || "");
  if (/not found|forbidden|native messaging host/i.test(text)) {
    return "Chrome cannot see the agent bridge. Run `node bridge/install-host.mjs`, quit Chrome fully, open it again, then reload Job Docket.";
  }
  if (/exited|disconnected|closed/i.test(text)) {
    return "The agent bridge closed. The docket will open it again on the next step.";
  }
  return text || "The agent bridge stopped answering.";
}

function connect() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  onStatus({ connected: true });
  port.onMessage.addListener((message) => {
    const entry = waiting.get(message?.id);
    if (!entry) return;
    waiting.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message);
    else entry.reject(new Error(describe(message.error)));
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    port = null;
    onStatus({ connected: false, error: error?.message || "" });
    failAll(describe(error?.message));
  });
  return port;
}

export function watchBridge(handler) {
  onStatus = handler || (() => {});
}

export function bridgeReady() {
  return Boolean(port);
}

export function closeBridge() {
  if (!port) return;
  try {
    port.disconnect();
  } catch {
    // Chrome already tore the port down.
  }
  port = null;
  failAll("The docket closed the agent bridge.");
}

export function sendAgent(message, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let live;
    try {
      live = connect();
    } catch (error) {
      reject(new Error(describe(error.message)));
      return;
    }
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("That step took too long. Try it again, or use Stop."));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    try {
      live.postMessage({ ...message, id });
    } catch (error) {
      waiting.delete(id);
      clearTimeout(timer);
      port = null;
      reject(new Error(describe(error.message)));
    }
  });
}

export async function askAgent({ prompt, system, session = "main", model = "", timeoutMs = 120000 }) {
  const answer = await sendAgent({ type: "ask", prompt, system, session, model }, timeoutMs);
  return String(answer.text || "");
}

export async function listAgents() {
  const answer = await sendAgent({ type: "hello" }, 15000);
  return answer.agents || [];
}

export async function resetSession(session = "main") {
  await sendAgent({ type: "reset", session }, 15000);
}
