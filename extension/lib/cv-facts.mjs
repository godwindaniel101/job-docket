// The questions forms ask that live in the CV rather than the profile: school,
// degree, discipline, years, the current employer and title.

const HEADINGS = /^(#+\s*)?(education|academic|qualifications|skills|technical skills|experience|employment|work history)\b/i;

function sections(text) {
  const found = new Map();
  let current = "";
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(HEADINGS);
    if (heading) {
      current = heading[2].toLowerCase();
      if (!found.has(current)) found.set(current, []);
      continue;
    }
    if (current) found.get(current).push(line.replace(/^[-*•]\s*/, ""));
  }
  return found;
}

function pick(found, names, limit) {
  for (const name of names) {
    const rows = found.get(name);
    if (rows?.length) return rows.slice(0, limit);
  }
  return [];
}

/** A short digest the agent can answer school, degree and skill questions from. */
export function cvFacts(masterCv) {
  const text = String(masterCv || "");
  if (!text.trim()) return "";
  const found = sections(text);
  const parts = [];

  const education = pick(found, ["education", "academic", "qualifications"], 2);
  if (education.length) parts.push(`Education — ${education.join(" | ")}`);

  const skills = pick(found, ["skills", "technical skills"], 2);
  if (skills.length) parts.push(`Skills — ${skills.join(" ")}`);

  const roles = pick(found, ["experience", "employment", "work history"], 4)
    .filter((line) => /\|/.test(line) || /\b(19|20)\d{2}\b/.test(line))
    .slice(0, 2);
  if (roles.length) parts.push(`Recent roles — ${roles.join(" | ")}`);

  const years = text.match(/\b(\d{1,2})\+?\s*years?\b/i);
  if (years) parts.push(`Experience — ${years[0]}`);

  return parts.join("; ");
}
