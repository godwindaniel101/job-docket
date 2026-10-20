// Most of the "You" answers are already written at the top of a CV. Reading them
// there saves the person retyping, and a blank field is what makes a run stop to
// ask a question mid-application.

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/;
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d[\d\s-]{7,15}\d/;
const LINKEDIN = /(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/in\/[\w%-]+/i;
const GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+/i;
const SITE = /(?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:dev|io|com|co|me|net|org|app|ng|xyz)(?:\/[\w\-./]*)?/i;

function tidyUrl(value) {
  return String(value || "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

// Words that mean the line is a job title, not a person. "Godwin Damiel |
// Senior Software Engineer" and a PDF that flattens the header into one line
// are both normal, so the name is taken from the front of the line.
const ROLE_WORDS = /\b(engineer|developer|manager|lead|architect|designer|analyst|consultant|director|officer|intern|student|specialist|scientist|founder|head|principal|staff|senior|junior|curriculum|vitae|resume|profile|contact)\b/i;

function cleanNamePart(value) {
  return value.replace(/^#+\s*/, "").replace(/[,;:·|–—-]+$/, "").trim();
}

function nameFromWords(words) {
  if (words.length < 2 || words.length > 4) return "";
  const shaped = words.every((word) => /^[A-Za-z][\w'’.-]*$/.test(word));
  if (!shaped) return "";
  if (ROLE_WORDS.test(words.join(" "))) return "";
  return words.join(" ");
}

function looksLikeName(line) {
  // A PDF often flattens the whole header onto one line, email and all.
  const text = cleanNamePart(
    line
      .replace(EMAIL, " ")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/\S+\.(?:com|io|dev|me|net|org|ng|app|co)\S*/gi, " ")
      .replace(/[+\d][\d()\s-]{6,}/g, " ")
      .replace(/\s+/g, " "),
  );
  if (!text) return "";
  // A title, a pipe or a long dash after the name: keep the front.
  const front = cleanNamePart(text.split(/\s*[|·•]\s*|\s[–—]\s/)[0]);
  const direct = nameFromWords(front.split(/\s+/));
  if (direct) return direct;
  // A flattened header: the name is the capitalised run before the job title.
  const words = text.split(/\s+/);
  for (let take = 4; take >= 2; take -= 1) {
    const head = words.slice(0, take);
    if (!head.every((word) => /^[A-Z][\w'’.-]*$/.test(word) || word === word.toUpperCase())) continue;
    const rest = words.slice(take).join(" ");
    if (!rest || ROLE_WORDS.test(rest)) {
      const candidate = nameFromWords(head);
      if (candidate) return candidate;
    }
  }
  return "";
}

function titleCase(value) {
  if (value !== value.toUpperCase() && value !== value.toLowerCase()) return value;
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function findLocation(lines) {
  for (const line of lines.slice(0, 8)) {
    // A city line sits near the contacts, carries a comma, and is not an address of the job kind.
    const parts = line.split(/[|·•]/).map((part) => part.trim());
    for (const part of parts) {
      if (!part || part.length > 48 || EMAIL.test(part) || /https?:|@|\.com|\.io/.test(part)) continue;
      if (!/^[A-Za-z][\w .'-]*,\s*[A-Za-z][\w .'-]*$/.test(part)) continue;
      if (/\d/.test(part)) continue;
      return part.replace(/\s+/g, " ");
    }
  }
  return "";
}

/** Reads the header of a CV. Returns only what it is confident about. */
export function profileFromCv(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const head = lines.slice(0, 12).join("\n");
  const found = {};

  for (const line of lines.slice(0, 6)) {
    const name = looksLikeName(line);
    if (name) {
      found.fullName = titleCase(name);
      break;
    }
  }

  const email = head.match(EMAIL);
  if (email) found.email = email[0];

  const linkedin = head.match(LINKEDIN);
  if (linkedin) found.linkedin = tidyUrl(linkedin[0]);

  const github = head.match(GITHUB);
  if (github) found.github = tidyUrl(github[0]);

  const phoneSource = head.replace(EMAIL, " ").replace(/\b(19|20)\d{2}\s*[–-]\s*((19|20)\d{2}|present)\b/gi, " ");
  const phone = phoneSource.match(PHONE);
  if (phone) {
    const digits = phone[0].replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 15) found.phone = phone[0].trim();
  }

  const location = findLocation(lines);
  if (location) found.location = location;

  const site = head
    .replace(LINKEDIN, " ")
    .replace(GITHUB, " ")
    .replace(EMAIL, " ")
    .match(SITE);
  if (site && !/\.(png|jpg|pdf)$/i.test(site[0])) found.website = tidyUrl(site[0]);

  return found;
}

/** Only fills what the person has left blank. Their own answer always wins. */
export function mergeProfile(profile, found) {
  const merged = { ...profile };
  const filled = [];
  for (const [key, value] of Object.entries(found)) {
    if (!value) continue;
    if (String(merged[key] || "").trim()) continue;
    merged[key] = value;
    filled.push(key);
  }
  return { merged, filled };
}

export const FIELD_NAMES = {
  fullName: "name",
  email: "email",
  phone: "phone",
  location: "location",
  linkedin: "LinkedIn",
  github: "GitHub",
  website: "website",
};

export const PROFILE_PROMPT = `Read the header of this CV and return what is written there. Return JSON only:
{"fullName":"","email":"","phone":"","location":"City, Country","linkedin":"","github":"","website":""}

Copy only what the CV actually says. Leave a field as "" when it is not there. Never guess a phone number, never invent a city, never turn a job title into a name. Strip "https://" from links.

CV:
`;

/** Fields the regexes missed, read by the agent. Only ever fills blanks. */
export async function profileFromAgent(cv, ask, parse) {
  const text = await ask(`${PROFILE_PROMPT}${String(cv || "").slice(0, 3000)}`);
  const parsed = parse(text);
  const found = {};
  for (const key of Object.keys(FIELD_NAMES)) {
    const value = String(parsed?.[key] || "").trim();
    if (value && value.length < 120) found[key] = value.replace(/^https?:\/\//i, "");
  }
  return found;
}
