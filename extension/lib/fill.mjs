const QUESTION_RULES = [
  { key: "email", test: /e-?mail/i },
  { key: "phone", test: /phone|mobile|\btel\b/i },
  { key: "firstName", test: /first name|given name/i },
  { key: "lastName", test: /last name|family name|surname/i },
  { key: "fullName", test: /^\s*(full |legal |preferred )?name\b|your (full |legal )?name/i },
  { key: "linkedin", test: /linkedin/i },
  { key: "github", test: /github/i },
  { key: "website", test: /website|portfolio|personal site/i },
  { key: "location", test: /\bcity\b|\blocation\b|where do you live|where are you based/i },
  { key: "workAuth", test: /authori[sz]ed to work|work authori|eligible to work|right to work|legally (allowed|eligible)/i },
  { key: "sponsorship", test: /sponsor/i },
  { key: "salary", test: /salary|compensation|pay expectation/i },
  { key: "notice", test: /notice period|when can you start|earliest start/i },
  { key: "coverNote", test: /cover letter|why (do you|this|are you)|additional information|anything else/i },
];

const SENSITIVE = /credit card|card number|\bcvv\b|\bssn\b|social security|password|bank account|routing number/i;
const LEGAL = /privacy|terms of|consent|\bgdpr\b|i agree|i acknowledge|i certify/i;
const SEARCH = /\bsearch\b|\bquery\b|\bfilter\b|\bkeyword\b/i;

// A phone widget puts a country picker inside the phone label, so the picker
// inherits the word "phone" and used to be filled with the number itself.
const COUNTRY_PICKER = /country|dial code|calling code|area code/i;

// "Name" in these questions is somebody else's.
const SOMEONE_ELSE = /referr|refere(e|nce)|manager|supervisor|emergency|next of kin|company|employer|organi[sz]ation|school|university|college|institution|previous|spouse|guardian/i;

export function deriveNames(profile) {
  const next = { ...profile };
  if (next.firstName || next.lastName || !next.fullName) return next;
  const parts = String(next.fullName).trim().split(/\s+/);
  if (parts.length === 1) {
    next.firstName = parts[0];
    return next;
  }
  next.firstName = parts[0];
  next.lastName = parts.slice(1).join(" ");
  return next;
}

export function isApplicationForm(fields) {
  const blob = (fields || [])
    .map((field) => `${field.label || ""} ${field.question || ""} ${field.name || ""} ${field.type || ""}`)
    .join(" ");
  return /e-?mail|resume|curriculum|\bcv\b|phone|first name|last name|cover letter/i.test(blob);
}

function blob(field) {
  return `${field.question || ""} ${field.label || ""} ${field.name || ""} ${field.placeholder || ""} ${field.aria || ""}`;
}

function isFilled(field) {
  if (field.type === "checkbox" || field.type === "radio") return Boolean(field.checked);
  if (field.type === "file") return Boolean(field.filled);
  return Boolean(String(field.value || "").trim());
}

function optionMatches(optionText, answer) {
  const left = String(optionText || "").trim().toLowerCase();
  const right = String(answer || "").trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  if (right.length < 3) {
    return new RegExp(`(^|[^a-z0-9])${right.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(left);
  }
  return left.includes(right);
}

function answerFor(field, profile) {
  const text = blob(field);
  if (SEARCH.test(text) && (field.type === "search" || /search|filter/.test(field.type || ""))) return { skip: true };
  if (COUNTRY_PICKER.test(`${field.name || ""} ${field.aria || ""} ${field.placeholder || ""}`)) return { skip: true };
  if (SOMEONE_ELSE.test(text)) return { unmapped: true };
  if (/company name/i.test(text)) return { missing: "company" };
  if (SENSITIVE.test(text)) return { sensitive: true };
  if (LEGAL.test(text)) return { legal: true };
  const rule = QUESTION_RULES.find((item) => item.test.test(text));
  if (!rule) return {};
  const value = profile[rule.key];
  if (value == null || String(value).trim() === "") return { missing: rule.key };
  return { value: String(value).trim(), key: rule.key };
}

function planControl(field, answer) {
  if (field.type === "select") {
    const option = (field.options || []).find((item) => optionMatches(item.label, answer) || optionMatches(item.value, answer));
    if (!option) return null;
    return { type: "fill", selector: field.selector, frameId: field.frameId, value: option.value || option.label, kind: "select" };
  }
  if (field.type === "radio" || field.type === "checkbox") {
    if (!optionMatches(field.label, answer) && !optionMatches(field.value, answer)) return null;
    return { type: "fill", selector: field.selector, frameId: field.frameId, value: "true", kind: field.type };
  }
  return { type: "fill", selector: field.selector, frameId: field.frameId, value: answer, kind: field.type || "text" };
}

export function planFields(fields, rawProfile) {
  const profile = deriveNames(rawProfile || {});
  const planned = [];
  const unknown = [];
  const groups = new Map();

  for (const field of fields || []) {
    if (!field || field.type === "hidden" || field.type === "password") continue;
    if (field.type === "radio") {
      const key = field.name || field.question || field.selector;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(field);
      continue;
    }
    if (isFilled(field)) continue;
    if (field.type === "file") {
      planned.push({ type: "upload", selector: field.selector, frameId: field.frameId, label: field.label || "Resume" });
      continue;
    }
    const answer = answerFor(field, profile);
    if (answer.skip) continue;
    if (answer.unmapped) {
      if (field.required) unknown.push({ ...field, because: "unmapped" });
      continue;
    }
    if (answer.sensitive || answer.legal) {
      unknown.push({ ...field, because: answer.sensitive ? "sensitive" : "legal" });
      continue;
    }
    if (answer.value) {
      const action = planControl(field, answer.value);
      if (action) {
        planned.push(action);
        continue;
      }
    }
    if (field.required) unknown.push({ ...field, because: answer.missing ? "missing-profile" : "unmapped" });
  }

  for (const group of groups.values()) {
    if (group.some((field) => field.checked)) continue;
    const sample = group[0];
    const answer = answerFor({ ...sample, label: sample.question || sample.label }, profile);
    if (answer.sensitive || answer.legal) {
      unknown.push({ ...sample, because: answer.sensitive ? "sensitive" : "legal" });
      continue;
    }
    if (answer.value) {
      const match = group.find((field) => optionMatches(field.label, answer.value) || optionMatches(field.value, answer.value));
      if (match) {
        planned.push({ type: "fill", selector: match.selector, frameId: match.frameId, value: "true", kind: "radio" });
        continue;
      }
    }
    if (group.some((field) => field.required)) {
      unknown.push({ ...sample, label: sample.question || sample.label, because: "unmapped" });
    }
  }

  return { planned, unknown };
}
