export function parseLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeReg(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesList(value, patterns) {
  const hay = normalize(value);
  if (!hay) return null;
  for (const pattern of patterns) {
    const needle = normalize(pattern);
    if (!needle) continue;
    if (needle.includes(" ")) {
      if (hay.includes(needle)) return pattern;
      continue;
    }
    const re = new RegExp(`(^|[^a-z0-9])${escapeReg(needle)}([^a-z0-9]|$)`, "i");
    if (re.test(hay)) return pattern;
  }
  return null;
}

export function companyBlob(job) {
  return [job?.company, job?.host].filter(Boolean).join(" ");
}

export function locationBlob(job) {
  const description = String(job?.description || "");
  const lines = description
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /location|based in|located in|office in|hybrid in|onsite in|on-site in/i.test(line))
    .slice(0, 6);
  return [job?.location, ...lines].filter(Boolean).join("\n");
}

// "Backend Engineer" should match "Senior Backend Engineer, VGo Carrier
// Technology" and "Engineer, Backend Platform" alike. A listing title is written
// by the employer, not by you, so the words have to be allowed to move.
const WEAK_WORDS = /^(a|an|the|and|of|for|in|at|to|senior|snr|sr|junior|jr|staff|lead|principal|mid|level|i|ii|iii|1|2|3)$/;

export function titleMatchesRole(title, role) {
  const hay = normalize(title);
  const needle = normalize(role);
  if (!hay || !needle) return false;
  if (hay.includes(needle)) return true;
  const words = needle.split(" ").filter((word) => word.length > 1 && !WEAK_WORDS.test(word));
  if (!words.length) return false;
  return words.every((word) => new RegExp(`(^|[^a-z0-9])${escapeReg(word)}`, "i").test(hay));
}

export function screenJob(job, rules) {
  const roles = rules?.roles || [];
  const avoidCompanies = rules?.avoidCompanies || [];
  const avoidRegions = rules?.avoidRegions || [];
  const donts = rules?.donts || [];
  const dos = rules?.dos || [];
  const title = job?.title || "";
  const posting = [title, job?.location, job?.description].filter(Boolean).join("\n");

  if (roles.length && title) {
    const matched = roles.find((role) => titleMatchesRole(title, role));
    if (!matched) {
      return {
        decision: "skip",
        reason: `Title is outside the roles you listed (${title})`,
        dos: [],
      };
    }
  }

  const companyHit = matchesList(companyBlob(job), avoidCompanies);
  if (companyHit) {
    return {
      decision: "skip",
      reason: `Company is on your avoid list (${companyHit})`,
      dos: [],
    };
  }

  const regionHit = matchesList(locationBlob(job), avoidRegions);
  if (regionHit) {
    return {
      decision: "skip",
      reason: `Location is on your avoid list (${regionHit})`,
      dos: [],
    };
  }

  const dontHit = donts.find((rule) => {
    const needle = normalize(rule);
    return needle && normalize(posting).includes(needle);
  });
  if (dontHit) {
    return {
      decision: "skip",
      reason: `Posting conflicts with a don't (${dontHit})`,
      dos: [],
    };
  }

  const matchedDos = dos.filter((rule) => {
    const needle = normalize(rule);
    return needle && normalize(posting).includes(needle);
  });

  return { decision: "keep", reason: "", dos: matchedDos };
}
