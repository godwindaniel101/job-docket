import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const home = homedir();
const dir = join(home, "Library/Application Support/JobDocket");
const host = join(dir, "host.mjs");
const wrapper = join(dir, "host.sh");
const extensionId = "ilcbjndijhcgplpeomennkbmckbmbiem";

mkdirSync(dir, { recursive: true });
copyFileSync(join(root, "host.mjs"), host);
copyFileSync(join(root, "agents.mjs"), join(dir, "agents.mjs"));
copyFileSync(join(root, "session.mjs"), join(dir, "session.mjs"));
writeFileSync(wrapper, `#!/bin/sh
export HOME="${home}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
unset NODE_OPTIONS NODE_DEBUG
LOG="$HOME/Library/Application Support/JobDocket/bridge.log"
echo "$(date) wrapper" >> "$LOG"
exec "${node}" "${host}" 2>> "$LOG"
`);
chmodSync(wrapper, 0o755);
for (const path of [wrapper, host, join(dir, "agents.mjs"), join(dir, "session.mjs")]) {
  try {
    execFileSync("xattr", ["-c", path]);
  } catch {
    // No quarantine attributes to clear.
  }
}

const manifest = {
  name: "com.jobdocket.agent",
  description: "Job Docket bridge to the agents already signed in on this Mac",
  path: wrapper,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
};

const manifestDir = join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts");
mkdirSync(manifestDir, { recursive: true });
writeFileSync(join(manifestDir, "com.jobdocket.agent.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Registered ${join(manifestDir, "com.jobdocket.agent.json")}`);
