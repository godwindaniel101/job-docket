(() => {
  if (globalThis.__JOB_AGENT_LOADED) return;
  globalThis.__JOB_AGENT_LOADED = true;

  const JOB_HREF = /greenhouse\.io|lever\.co|ashbyhq|myworkdayjobs|smartrecruiters|workable\.com|recruitee|bamboohr|\/jobs\/|\/job\/|jobs\/view|viewjob|gh_jid|ashby_jid/i;

  function text(node) {
    if (!node) return "";
    const raw = node.innerText != null && node.innerText !== "" ? node.innerText : node.textContent;
    return String(raw || "").replace(/\s+/g, " ").trim();
  }

  function cssEscape(value) {
    if (globalThis.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }

  function pageUrl(doc) {
    const canonical = doc.querySelector('link[rel="canonical"]');
    const href = canonical && (canonical.getAttribute("href") || canonical.href);
    if (href) return href;
    return doc.URL || (doc.location && doc.location.href) || "";
  }

  function baseUrl(doc) {
    const base = doc.querySelector("base");
    const href = base && base.getAttribute("href");
    if (href) return href;
    return pageUrl(doc) || "https://example.invalid/";
  }

  function absUrl(value, base) {
    if (!value) return "";
    try {
      return new URL(value, base).href;
    } catch {
      return "";
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function stripHtml(doc, value) {
    const raw = String(value || "");
    if (!raw.includes("<")) return raw.replace(/\s+/g, " ").trim().slice(0, 12000);
    const holder = doc.createElement("div");
    holder.innerHTML = raw;
    return text(holder).slice(0, 12000);
  }

  function walkJson(node, jobs, doc) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item) => walkJson(item, jobs, doc));
      return;
    }
    const types = [].concat(node["@type"] || []);
    if (types.includes("JobPosting")) jobs.push(normalizePosting(node, doc));
    if (node["@graph"]) walkJson(node["@graph"], jobs, doc);
    if (node.itemListElement) walkJson(node.itemListElement, jobs, doc);
    if (node.item) walkJson(node.item, jobs, doc);
  }

  function locationFrom(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(locationFrom).filter(Boolean).join("; ");
    const address = value.address || value;
    if (typeof address === "string") return address;
    return [address.addressLocality, address.addressRegion, address.addressCountry].filter(Boolean).join(", ");
  }

  function normalizePosting(node, doc) {
    const org = node.hiringOrganization;
    const company = typeof org === "string" ? org : (org && org.name) || "";
    return {
      title: node.title || "",
      company,
      location: locationFrom(node.jobLocation),
      description: stripHtml(doc, node.description || ""),
      url: typeof node.url === "string" ? node.url : "",
    };
  }

  function readJsonLd(doc) {
    const jobs = [];
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        walkJson(JSON.parse(script.textContent), jobs, doc);
      } catch {
        // A broken block should not hide the rest of the page.
      }
    }
    return jobs;
  }

  function mark(doc, el) {
    let id = el.getAttribute("data-ja-id");
    if (!id) {
      const next = Number(doc.documentElement.getAttribute("data-ja-seq") || "0") + 1;
      doc.documentElement.setAttribute("data-ja-seq", String(next));
      id = `f${next}`;
      el.setAttribute("data-ja-id", id);
    }
    return `[data-ja-id="${id}"]`;
  }

  function labelFor(doc, el) {
    if (el.id) {
      const labelled = doc.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (labelled) return text(labelled);
    }
    const wrap = el.closest && el.closest("label");
    if (wrap) {
      const clone = wrap.cloneNode(true);
      for (const control of clone.querySelectorAll("input, select, textarea")) control.remove();
      const value = text(clone);
      if (value) return value;
    }
    return el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
  }

  function questionFor(el) {
    const fieldset = el.closest && el.closest("fieldset");
    const legend = fieldset && fieldset.querySelector("legend");
    if (legend) return text(legend);
    return "";
  }

  function isRequired(el, label) {
    return Boolean(el.required || el.hasAttribute?.("required") || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label));
  }

  function addListing(listings, seen, listing) {
    const title = (listing.title || "").replace(/\s+/g, " ").trim();
    if (title.length < 2 || title.length > 140) return;
    if (/^(apply|search|learn more|sign in|log in|read more)$/i.test(title)) return;
    const url = listing.url || "";
    const key = url ? url : `${title}|${listing.company || ""}|${listing.location || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    listings.push({
      title,
      company: (listing.company || "").slice(0, 80),
      location: (listing.location || "").slice(0, 80),
      url,
    });
  }

  function nearby(card, selector) {
    if (!card) return "";
    let node = null;
    try {
      node = card.querySelector(selector);
    } catch {
      return "";
    }
    const value = text(node);
    return value.length > 80 ? "" : value;
  }

  function extractListings(doc, base) {
    const listings = [];
    const seen = new Set();
    for (const card of doc.querySelectorAll(".opening, .posting, [data-job], li.job, .job-card, .job-listing")) {
      const link = card.querySelector("a[href]");
      if (!link) continue;
      addListing(listings, seen, {
        title: text(link),
        company: nearby(card, ".company, [class*=company]"),
        location: nearby(card, ".location, [class*=location]"),
        url: absUrl(link.getAttribute("href"), base),
      });
    }
    for (const link of doc.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") || "";
      if (!JOB_HREF.test(href)) continue;
      const parent = link.parentElement;
      addListing(listings, seen, {
        title: text(link),
        company: nearby(parent, ":scope > .company, :scope > [class*=company]"),
        location: nearby(parent, ":scope > .location, :scope > [class*=location]"),
        url: absUrl(href, base),
      });
    }
    return listings.slice(0, 25);
  }

  function longestText(doc) {
    let best = "";
    for (const node of doc.querySelectorAll("main, article, #content, [id*='description'], [class*='description'], [class*='job-post']")) {
      const value = text(node);
      if (value.length > best.length) best = value;
    }
    return best.slice(0, 12000);
  }

  function controlLabel(el) {
    return (text(el) || el.getAttribute("value") || el.getAttribute("aria-label") || "").trim();
  }

  function pickControl(doc, predicate) {
    for (const el of doc.querySelectorAll("a, button, input[type=submit], input[type=button]")) {
      const label = controlLabel(el);
      if (!label || label.length > 80) continue;
      if (!predicate(label)) continue;
      return { selector: mark(doc, el), text: label };
    }
    return null;
  }

  function extractFields(doc) {
    const fields = [];
    for (const el of doc.querySelectorAll("input, textarea, select, [contenteditable='true']")) {
      const type = (el.getAttribute("contenteditable") === "true" ? "textarea" : el.getAttribute("type") || el.tagName || "text").toLowerCase();
      if (type === "hidden" || type === "password" || el.hasAttribute?.("hidden")) continue;
      const label = labelFor(doc, el);
      const question = questionFor(el);
      const options = el.tagName === "SELECT"
        ? [...el.options].map((option) => ({ value: option.value, label: text(option) || option.value }))
        : [];
      fields.push({
        selector: mark(doc, el),
        type: type === "select" ? "select" : type,
        name: el.getAttribute("name") || "",
        label,
        question,
        placeholder: el.getAttribute("placeholder") || "",
        aria: el.getAttribute("aria-label") || "",
        required: isRequired(el, label),
        value: el.value || "",
        checked: Boolean(el.checked),
        filled: type === "file" ? Boolean(el.files && el.files.length) : false,
        options,
      });
    }
    return fields;
  }

  function isTopFrame() {
    try {
      return globalThis.window.top === globalThis.window;
    } catch {
      return false;
    }
  }


  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = globalThis.getComputedStyle ? getComputedStyle(el) : null;
    if (style && (style.visibility === "hidden" || style.display === "none" || style.opacity === "0")) return false;
    return true;
  }

  function refOf(doc, el) {
    const selector = mark(doc, el);
    return selector.slice('[data-ja-id="'.length, -2);
  }

  function kindOf(el) {
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button") return "button";
      if (type === "file") return "file";
      if (type === "checkbox" || type === "radio") return type;
      return "input";
    }
    if (tag === "button" || el.getAttribute("role") === "button") return "button";
    return "control";
  }

  // The agent reads this list the way a person reads a page: numbered things it
  // can touch, each with the words printed on it. Acting on a ref is exact, so a
  // click never lands on the wrong "Apply".
  function outline(doc, limit = 90) {
    const rows = [];
    const nodes = doc.querySelectorAll(
      "a[href], button, input, textarea, select, [role=button], [role=link], [contenteditable='true']",
    );
    for (const el of nodes) {
      const type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
      if (type === "hidden") continue;
      // A drop zone hides its file input; it is still what has to be filled.
      if (!visible(el) && type !== "file") continue;
      const label = (labelFor(doc, el) || controlLabel(el) || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
      const href = el.getAttribute && el.getAttribute("href") || "";
      if (!label && !href) continue;
      const row = {
        ref: refOf(doc, el),
        kind: kindOf(el),
        label: label.slice(0, 90),
      };
      if (href && !href.startsWith("javascript:")) row.href = absUrl(href, baseUrl(doc)).slice(0, 300);
      if (el.value && row.kind !== "button") row.value = String(el.value).slice(0, 60);
      if (el.checked) row.checked = true;
      if (isRequired(el, label)) row.required = true;
      rows.push(row);
      if (rows.length >= limit) break;
    }
    return rows;
  }

  function readingText(doc) {
    const main = doc.querySelector("main, article, [role=main]");
    const value = text(main) || text(doc.body);
    return value.slice(0, 9000);
  }


  // Nearly every careers site loads an invisible reCAPTCHA v3 on every page.
  // Only a challenge a person could actually click counts as a captcha.
  const CAPTCHA_SELECTOR = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]',
    'iframe[src*="captcha"]',
    'iframe[title*="captcha" i]',
    ".g-recaptcha",
    ".h-captcha",
    ".cf-turnstile",
  ].join(",");

  function captchaIn(doc) {
    for (const el of doc.querySelectorAll(CAPTCHA_SELECTOR)) {
      // The floating v3 badge is a logo, and an invisible widget never asks anything.
      if (el.closest && el.closest(".grecaptcha-badge")) continue;
      const src = (el.getAttribute && el.getAttribute("src")) || "";
      const className = String(el.className || "");
      if (/size=invisible/i.test(src)) continue;
      if (/invisible/i.test(className)) continue;
      if (el.getAttribute && el.getAttribute("data-size") === "invisible") continue;
      if (el.hasAttribute && el.hasAttribute("hidden")) continue;

      const style = globalThis.getComputedStyle ? getComputedStyle(el) : null;
      if (style && (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)) continue;

      // A real challenge occupies space. Where nothing can be measured, trust the markup.
      let rect = null;
      try {
        rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      } catch {
        rect = null;
      }
      const measurable = rect && (rect.width || rect.height);
      if (measurable && (rect.width < 60 || rect.height < 30)) continue;

      return {
        what: (el.tagName || "").toLowerCase() === "iframe" ? "a captcha frame" : `a ${className || "captcha"} box`,
        size: measurable ? `${Math.round(rect.width)}×${Math.round(rect.height)}` : "not measurable",
      };
    }
    return null;
  }

  function extract(doc) {
    const url = pageUrl(doc);
    const base = baseUrl(doc);
    const postings = readJsonLd(doc);
    const primary = postings[0] || {};
    const description = primary.description || longestText(doc);
    const job = {
      title: primary.title || text(doc.querySelector("h1")),
      company: primary.company || "",
      location: primary.location || text(doc.querySelector(".location, [class*=location]")),
      description,
      url: primary.url || url,
      host: hostOf(primary.url || url),
    };
    const fields = extractFields(doc);
    const application = fields.some((field) => /e-?mail|resume|curriculum|\bcv\b|phone|cover letter/i.test(`${field.label} ${field.name} ${field.type}`));
    const challenge = captchaIn(doc);
    const password = doc.querySelector('input[type="password"]');
    const body = text(doc.body).slice(0, 5000);
    const confirmation = /thank you for applying|application (has been )?submitted|we received your application|thanks for applying/i.test(body);
    return {
      url,
      title: doc.title || "",
      isTop: isTopFrame(),
      outline: outline(doc),
      text: readingText(doc),
      captcha: Boolean(challenge),
      captchaDetail: challenge,
      loginWall: Boolean(password) && !application && description.length < 80,
      confirmation,
      job,
      listings: extractListings(doc, base).filter((listing) => listing.url && listing.url !== job.url),
      fields,
      apply: application ? null : pickControl(doc, (label) => /^(easy )?apply( now| for this (job|role)| here)?$/i.test(label)),
      submit: application ? pickControl(doc, (label) => /^(submit( your application| application)?|send application|(easy )?apply( now)?)$/i.test(label)) : null,
      next: pickControl(doc, (label) => /^(next|continue|save and continue)$/i.test(label)),
    };
  }


  // A run you cannot watch is a run you cannot trust. The pointer moves to the
  // control, the control lights up, and only then does the click happen.
  const POINTER_ID = "__job-docket-pointer";

  function pointerNode() {
    let node = document.getElementById(POINTER_ID);
    if (node) return node;
    node = document.createElement("div");
    node.id = POINTER_ID;
    node.setAttribute("aria-hidden", "true");
    node.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "width:22px",
      "height:22px",
      "z-index:2147483647",
      "pointer-events:none",
      "transition:transform .28s cubic-bezier(.4,0,.2,1)",
      "will-change:transform",
    ].join(";");
    node.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none">'
      + '<path d="M4 2l13 7-5.5 1.6L9 16 4 2z" fill="#d97757" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>'
      + '</svg>';
    (document.body || document.documentElement).append(node);
    return node;
  }

  function ring(rect) {
    const halo = document.createElement("div");
    halo.setAttribute("aria-hidden", "true");
    halo.style.cssText = [
      `position:fixed`,
      `left:${rect.left - 4}px`,
      `top:${rect.top - 4}px`,
      `width:${rect.width + 8}px`,
      `height:${rect.height + 8}px`,
      "border:2px solid #d97757",
      "border-radius:8px",
      "box-shadow:0 0 0 4px rgba(217,119,87,.22)",
      "z-index:2147483646",
      "pointer-events:none",
      "transition:opacity .45s ease",
    ].join(";");
    (document.body || document.documentElement).append(halo);
    setTimeout(() => {
      halo.style.opacity = "0";
      setTimeout(() => halo.remove(), 500);
    }, 650);
  }

  function showPointer(el) {
    return new Promise((resolve) => {
      try {
        if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = el.getBoundingClientRect();
        if (!rect.width && !rect.height) {
          resolve();
          return;
        }
        const node = pointerNode();
        node.style.transform = `translate(${rect.left + rect.width / 2}px, ${rect.top + rect.height / 2}px)`;
        ring(rect);
        setTimeout(resolve, 320);
      } catch {
        resolve();
      }
    });
  }

function resolve(doc, action) {
  if (action.ref) {
    const byRef = doc.querySelector(`[data-ja-id="${String(action.ref).replace(/"/g, "")}"]`);
    if (byRef) return byRef;
  }
  if (action.selector) {
    const found = doc.querySelector(action.selector);
    if (found) return found;
  }
  const label = String(action.label || action.text || "").trim().toLowerCase();
  if (!label) return null;
  const candidates = doc.querySelectorAll(
    "a, button, input, textarea, select, [role=button], [role=link], [contenteditable='true']",
  );
  let loose = null;
  for (const el of candidates) {
    const name = (labelFor(doc, el) || controlLabel(el) || "").trim().toLowerCase();
    if (!name) continue;
    if (name === label) return el;
    if (!loose && name.includes(label)) loose = el;
  }
  return loose;
}

  function fire(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function act(doc, action) {
    const el = resolve(doc, action);
    if (!el) throw new Error(`Could not find ${action.selector || action.text || "the control"} on the page.`);
    if (action.type === "click") {
      // target="_blank" would hand the page to a tab the docket is not watching.
      const opensElsewhere = el.tagName === "A" && (el.target === "_blank" || el.target === "_new");
      if (opensElsewhere) el.removeAttribute("target");
      el.click();
      return { clicked: controlLabel(el), keptInTab: opensElsewhere, href: el.getAttribute("href") || "" };
    }
    if (action.type === "fill") {
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "select") {
        const option = [...el.options].find((item) => item.value === action.value || text(item) === action.value);
        if (!option) throw new Error("No matching option.");
        el.value = option.value;
      } else if (el.type === "radio" || el.type === "checkbox") {
        el.checked = true;
        if (typeof el.click === "function") el.click();
      } else if (el.getAttribute && el.getAttribute("contenteditable") === "true") {
        el.textContent = action.value;
      } else {
        if (typeof el.focus === "function") el.focus();
        el.value = action.value;
      }
      fire(el);
      return { filled: true };
    }
    if (action.type === "upload") {
      const binary = Uint8Array.from(atob(action.base64), (char) => char.charCodeAt(0));
      const file = new File([binary], action.filename, { type: action.mime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      el.files = transfer.files;
      fire(el);
      return { uploaded: action.filename };
    }
    if (action.type === "select") {
      const option = [...el.options].find((item) => item.value === action.value || text(item) === action.value)
        || [...el.options].find((item) => text(item).toLowerCase().includes(String(action.value || "").toLowerCase()));
      if (!option) throw new Error("No matching option.");
      el.value = option.value;
      fire(el);
      return { selected: text(option) };
    }
    if (action.type === "press") {
      const key = action.key || "Enter";
      if (typeof el.focus === "function") el.focus();
      for (const kind of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(new KeyboardEvent(kind, { key, bubbles: true }));
      }
      const form = el.form || (el.closest && el.closest("form"));
      if (key === "Enter" && form && typeof form.requestSubmit === "function") form.requestSubmit();
      return { pressed: key };
    }
    throw new Error("Unknown action.");
  }

  function scrollPage(action) {
    const amount = Number(action.amount) || 1;
    if (action.ref) {
      const el = document.querySelector(`[data-ja-id="${action.ref}"]`);
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ block: "center" });
        return { scrolledTo: action.ref };
      }
    }
    const before = globalThis.scrollY || 0;
    globalThis.scrollBy(0, Math.round((globalThis.innerHeight || 700) * 0.85) * amount);
    return { from: before, to: globalThis.scrollY || 0, bottom: (globalThis.scrollY || 0) + (globalThis.innerHeight || 0) >= (document.body?.scrollHeight || 0) - 40 };
  }

  globalThis.__JOB_AGENT = { extract, act, outline, scrollPage, showPointer };

  if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || !message.type || !String(message.type).startsWith("JOB_AGENT_")) return;
      if (message.type === "JOB_AGENT_SNAPSHOT") {
        sendResponse({ ok: true, snapshot: extract(document) });
        return;
      }
      if (message.type === "JOB_AGENT_SCROLL") {
        try {
          sendResponse({ ok: true, result: scrollPage(message.action || {}) });
        } catch (error) {
          sendResponse({ ok: false, error: String(error.message || error) });
        }
        return;
      }
      if (message.type === "JOB_AGENT_ACT") {
        const action = message.action || {};
        let target = null;
        try {
          target = resolve(document, action);
        } catch {
          target = null;
        }
        const run = () => {
          try {
            sendResponse({ ok: true, result: act(document, action) });
          } catch (error) {
            sendResponse({ ok: false, error: String(error.message || error) });
          }
        };
        if (target && action.quiet !== true) showPointer(target).then(run);
        else run();
        return true;
      }
    });
  }
})();
