import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

// Chrome reads native-messaging hosts from a per-browser directory, and the
// path differs by platform. Writing to every browser the person might use is
// cheaper than asking them which one they opened.
const HOST_DIRS = {
  darwin: [
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Google/Chrome Beta",
    "Library/Application Support/Google/Chrome Canary",
    "Library/Application Support/Chromium",
    "Library/Application Support/BraveSoftware/Brave-Browser",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Arc/User Data",
  ],
  linux: [
    ".config/google-chrome",
    ".config/google-chrome-beta",
    ".config/chromium",
    ".config/BraveSoftware/Brave-Browser",
    ".config/microsoft-edge",
  ],
};

const roots = HOST_DIRS[process.platform];
if (!roots) {
  console.error(`This installer covers macOS and Linux. On ${process.platform}, write the manifest below to your browser's NativeMessagingHosts directory by hand:`);
  console.error(JSON.stringify(manifest, null, 2));
  process.exit(1);
}

const written = [];
for (const root of roots) {
  const browserDir = join(home, root);
  // Only register with browsers that are actually installed.
  if (!existsSync(browserDir)) continue;
  const manifestDir = join(browserDir, "NativeMessagingHosts");
  mkdirSync(manifestDir, { recursive: true });
  const target = join(manifestDir, "com.jobdocket.agent.json");
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  written.push(target);
}

if (!written.length) {
  console.error("No Chrome-family browser found in the usual places. Install Chrome, then run this again.");
  process.exit(1);
}

for (const target of written) console.log(`Registered ${target}`);
console.log("\nNow quit the browser completely and open it again: it only looks for new bridges at startup.");
