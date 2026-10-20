import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

export const KNOWN_AGENTS = [
  {
    id: "claude",
    label: "Claude Code",
    paths: [join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
  },
  {
    id: "cursor",
    label: "Cursor agent",
    paths: [join(HOME, ".local/bin/agent"), join(HOME, ".local/bin/cursor-agent"), "/opt/homebrew/bin/agent"],
  },
  {
    id: "codex",
    label: "Codex",
    paths: ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", join(HOME, ".local/bin/codex")],
  },
];

export function findBinary(paths) {
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Try the next install location.
    }
  }
  return null;
}

export function listAgents() {
  return KNOWN_AGENTS.map((agent) => {
    const command = findBinary(agent.paths);
    return { id: agent.id, label: agent.label, installed: Boolean(command) };
  });
}

export function resolveAgent(id) {
  const installed = KNOWN_AGENTS
    .map((agent) => ({ ...agent, command: findBinary(agent.paths) }))
    .filter((agent) => agent.command);
  if (id && id !== "auto") {
    const chosen = installed.find((agent) => agent.id === id);
    if (!chosen) {
      const known = KNOWN_AGENTS.find((agent) => agent.id === id);
      throw new Error(known
        ? `${known.label} has no local command on this Mac. Claude Code is available.`
        : "That agent is not available.");
    }
    return chosen;
  }
  if (!installed.length) {
    throw new Error("No local agent is installed. Claude Code or Codex can run the docket with the login already on this Mac.");
  }
  return installed[0];
}

function clean(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "").trim();
}

function run(command, args, { input, timeoutMs = 180000, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd || tmpdir(),
      env: {
        ...process.env,
        PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The agent took too long and was stopped."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(clean(stderr || stdout).slice(-500) || `The agent exited with code ${code}.`));
        return;
      }
      resolve(clean(stdout));
    });
    child.stdin.end(input || "");
  });
}

export async function askAgent(id, prompt) {
  const agent = resolveAgent(id);
  if (agent.id === "claude") {
    return run(agent.command, ["-p", "--tools", "", "--permission-mode", "dontAsk", "--output-format", "text"], {
      input: prompt,
    });
  }
  if (agent.id === "codex") {
    const dir = mkdtempSync(join(tmpdir(), "docket-"));
    const output = join(dir, "answer.txt");
    await run(agent.command, [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-o",
      output,
      "-",
    ], { input: prompt, cwd: dir });
    return clean(readFileSync(output, "utf8"));
  }
  if (agent.id === "cursor") {
    return run(agent.command, ["-p", "--output-format", "text"], { input: prompt });
  }
  throw new Error(`${agent.label} cannot take a docket task.`);
}
