import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { findBinary, KNOWN_AGENTS } from "./agents.mjs";

const HOME = homedir();

// A cold `claude -p` costs about fourteen seconds and loads every setting source,
// skill and memory file on this Mac: roughly eighty thousand tokens before the
// docket has said anything. One long-lived session with a written system prompt
// and no setting sources answers in one to three seconds on a few hundred tokens.
function claudeArgs({ system, model }) {
  const args = [
    "-p",
    "--verbose",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--system-prompt", system,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
    "--permission-mode", "dontAsk",
  ];
  if (model) args.push("--model", model);
  return args;
}

function clean(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "").trim();
}

class Session {
  constructor({ command, system, model, onLog }) {
    this.command = command;
    this.system = system;
    this.model = model;
    this.onLog = onLog || (() => {});
    this.child = null;
    this.buffer = "";
    this.pending = null;
    this.turns = 0;
  }

  start() {
    if (this.child && !this.child.killed) return;
    this.child = spawn(this.command, claudeArgs({ system: this.system, model: this.model }), {
      cwd: tmpdir(),
      env: {
        ...process.env,
        PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.child.stdout.on("data", (chunk) => this.onChunk(chunk));
    this.child.stderr.on("data", (chunk) => this.onLog(`session stderr ${clean(chunk).slice(0, 200)}`));
    this.child.on("exit", (code) => {
      this.onLog(`session exit ${code}`);
      this.child = null;
      this.settle({ ok: false, error: "The agent session closed. The docket will open a new one." });
    });
    this.child.on("error", (error) => {
      this.onLog(`session error ${error.message}`);
      this.settle({ ok: false, error: error.message });
    });
  }

  settle(value) {
    const waiting = this.pending;
    this.pending = null;
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.resolve(value);
    }
  }

  onChunk(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type !== "result") continue;
      if (message.is_error || message.subtype !== "success") {
        this.settle({ ok: false, error: clean(message.result) || "The agent could not answer that step." });
        continue;
      }
      this.turns += 1;
      this.settle({ ok: true, text: clean(message.result), cost: message.total_cost_usd || 0 });
    }
  }

  ask(prompt, timeoutMs = 90000) {
    if (this.pending) return Promise.resolve({ ok: false, error: "The agent is still on the last step." });
    this.start();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.stop();
        resolve({ ok: false, error: "That step took too long. The docket opened a fresh session." });
      }, timeoutMs);
      this.pending = { resolve, timer };
      const frame = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: String(prompt || "") }] },
      };
      try {
        this.child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        this.settle({ ok: false, error: error.message });
      }
    });
  }

  stop() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    } catch {
      // The session was already gone.
    }
    this.child = null;
  }
}

const sessions = new Map();

export function sessionFor(name, { system, model, onLog }) {
  const key = `${name}|${model || ""}`;
  const held = sessions.get(key);
  if (held && held.system === system) return held;
  if (held) held.stop();
  const command = findBinary(KNOWN_AGENTS.find((agent) => agent.id === "claude").paths);
  if (!command) return null;
  const session = new Session({ command, system, model, onLog });
  sessions.set(key, session);
  return session;
}

export function dropSession(name) {
  for (const [key, session] of sessions) {
    if (key.split("|")[0] === name) {
      session.stop();
      sessions.delete(key);
    }
  }
}

export function stopAllSessions() {
  for (const session of sessions.values()) session.stop();
  sessions.clear();
}
