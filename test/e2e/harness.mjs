// Loads the real extension in the real Chrome on this Mac and drives the side
// panel like a person. Everything else is a stub; this is not.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION = join(ROOT, "extension");
export const EXTENSION_ID = "ilcbjndijhcgplpeomennkbmckbmbiem";
// Stable Chrome dropped --load-extension, so the tests drive Chrome for Testing.
// Install once with:
//   npx @puppeteer/browsers install chrome@stable --path <dir>
const CHROME = process.env.DOCKET_CHROME
  || "/private/tmp/claude-501/-Users-danieliyenogun-Desktop-Software-P-job/3df0b5b9-7651-4701-adfa-980b8767a1c3/scratchpad/browsers/chrome/mac_arm-155.0.8059.84/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

function hostManifestInto(userDataDir) {
  const dir = join(userDataDir, "NativeMessagingHosts");
  mkdirSync(dir, { recursive: true });
  const source = join(process.env.HOME, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.jobdocket.agent.json");
  try {
    copyFileSync(source, join(dir, "com.jobdocket.agent.json"));
    return true;
  } catch {
    return false;
  }
}

export async function launch({ headless = false } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), "docket-chrome-"));
  const bridge = hostManifestInto(userDataDir);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless,
    userDataDir,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      // Chrome 137 switched --load-extension off unless this feature is disabled.
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
    ],
    defaultViewport: null,
  });
  return { browser, userDataDir, bridge };
}

export async function openPanel(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 900));
  return { page, errors };
}

export async function seed(page, settings) {
  await page.evaluate((value) => chrome.storage.local.set(value), settings);
}

export async function feed(page) {
  return page.evaluate(() => [...document.querySelectorAll("#feed .note, #feed .card")]
    .map((node) => `${node.className.split(" ")[0]} :: ${node.textContent.replace(/\s+/g, " ").trim().slice(0, 150)}`));
}

export async function clickChip(page, label) {
  await page.evaluate((text) => {
    const chip = [...document.querySelectorAll(".chip")].find((node) => node.textContent === text);
    if (!chip) throw new Error(`No chip called ${text}`);
    chip.click();
  }, label);
}

export async function clickCardButton(page, label) {
  return page.evaluate((text) => {
    const button = [...document.querySelectorAll("#feed .card .btn")].find((node) => node.textContent === text);
    if (!button) return false;
    button.click();
    return true;
  }, label);
}

export function kill(browser) {
  return browser.close().catch(() => {});
}
