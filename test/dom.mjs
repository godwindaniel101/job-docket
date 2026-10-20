import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const source = readFileSync(new URL("../extension/content/page-agent.js", import.meta.url), "utf8");

export function loadPage(html) {
  const { document, window } = parseHTML(html);
  const context = vm.createContext({
    document,
    window,
    console,
    URL,
    Event: window.Event,
    Uint8Array,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  });
  context.globalThis = context;
  context.chrome = { runtime: { onMessage: { addListener() {} } } };
  vm.runInContext(source, context);
  return {
    document,
    extract: (doc = document) => context.__JOB_AGENT.extract(doc),
    act: (action, doc = document) => context.__JOB_AGENT.act(doc, action),
  };
}

export function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}
