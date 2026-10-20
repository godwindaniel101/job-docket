import { appendFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askAgent, listAgents } from "./agents.mjs";
import { dropSession, sessionFor, stopAllSessions } from "./session.mjs";

const logPath = join(homedir(), "Library/Application Support/JobDocket/bridge.log");

function log(line) {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never touch stdout. That stream is the Chrome protocol.
  }
}

function writeMessage(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  writeSync(1, header);
  writeSync(1, body);
}

// Chrome holds one process open per connected port, so stdin is read as a stream
// and requests are answered as they finish rather than one strictly after another.
function readMessages(onMessage) {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length <= 0 || length > 64_000_000) {
        log(`bad frame length ${length}`);
        process.exit(1);
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(body.toString("utf8")));
      } catch (error) {
        log(`parse ${error.message}`);
      }
    }
  });
  process.stdin.on("end", () => {
    stopAllSessions();
    log("stdin end");
    process.exit(0);
  });
}

async function handle(message) {
  const type = message?.type;
  if (type === "hello" || type === "list") {
    const agents = listAgents();
    return { ok: true, agents, claude: agents.some((agent) => agent.id === "claude" && agent.installed) };
  }
  if (type === "reset") {
    dropSession(String(message.session || "main"));
    return { ok: true };
  }
  if (type === "ask") {
    const session = sessionFor(String(message.session || "main"), {
      system: String(message.system || "You are a careful assistant. Answer with JSON only."),
      model: message.model || "",
      onLog: log,
    });
    if (session) {
      const answer = await session.ask(String(message.prompt || ""), Number(message.timeoutMs) || 90000);
      if (answer.ok) return answer;
      log(`ask failed ${answer.error}`);
      if (/closed|fresh session/i.test(answer.error || "")) {
        const retry = await session.ask(String(message.prompt || ""), Number(message.timeoutMs) || 90000);
        if (retry.ok) return retry;
        return retry;
      }
      return answer;
    }
    const text = await askAgent(message.agent || "auto", String(message.prompt || ""));
    return { ok: true, text };
  }
  if (type === "oneshot") {
    const text = await askAgent(message.agent || "auto", String(message.prompt || ""));
    return { ok: true, text };
  }
  return { ok: false, error: "Unknown request." };
}

log("started");
readMessages(async (message) => {
  const id = message?.id ?? null;
  try {
    const result = await handle(message);
    writeMessage({ id, ...result });
  } catch (error) {
    log(`handle ${error.stack || error.message}`);
    try {
      writeMessage({ id, ok: false, error: error.message });
    } catch (writeError) {
      log(`write ${writeError.message}`);
    }
  }
});

process.on("uncaughtException", (error) => {
  log(`uncaught ${error.stack || error.message}`);
  try {
    writeMessage({ ok: false, error: error.message });
  } catch {
    // Chrome already closed the pipe.
  }
});
