import { extractJson } from "./tailor.mjs";

// Ranking by arithmetic — word overlap, a freshness bonus — cannot tell a
// Backend Engineer who has run payment rails from one who has not. It never
// reads the CV and never reads the posting. This asks the model to do both, in
// batches, and to say what it would cost you to apply.

export const AUDIT_SYSTEM = `You judge how well one person's CV fits each job in a list. You answer with one JSON object and nothing else.

For every job return:
{"url":"","fit":0-100,"why":"one line, concrete, from the CV","gap":"the single thing that would sink this application, or empty"}

Scoring:
90+ they are an obvious hire: the CV shows the same work, at the same level.
70-89 a real fit with one gap they can defend in a first call.
50-69 a stretch: adjacent work, or the level is off by one.
Under 50 they cannot support the claim without inventing something.

Judge the work, not the words. Same job under a different title scores high. A keyword that collides by accident scores low: a CV that says "GTM" meaning a tax product is not go-to-market experience.
Count the blockers that actually sink an application: no right to work in the stated country, a required licence or clearance the CV lacks, a seniority gap of more than one level.
Never invent experience the CV does not show.

Return {"jobs":[ ... ]} covering every job you were given, in any order.`;

export function auditBatchPrompt({ jobs, cv, profile, rules }) {
  const rows = jobs.map((job, index) => [
    `${index + 1}. ${job.title}`,
    job.company ? `company: ${job.company}` : "",
    job.location ? `location: ${job.location}` : "",
    `url: ${job.url}`,
    job.summary ? `about: ${String(job.summary).replace(/\s+/g, " ").slice(0, 400)}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");

  return `The person lives in ${profile?.location || "an unstated place"}${profile?.workAuth ? `, work authorisation: ${profile.workAuth}` : ""}${profile?.sponsorship ? `, needs sponsorship: ${profile.sponsorship}` : ""}.
What they want: ${(rules?.roles || []).join(", ") || "not stated"}.
What they prefer: ${(rules?.dos || []).join(", ") || "nothing stated"}.
What they refuse: ${(rules?.donts || []).join(", ") || "nothing stated"}.

CV:
${String(cv || "").slice(0, 6000)}

Jobs:
${rows}`;
}

export function parseAudit(text, jobs) {
  const allowed = new Map(jobs.map((job) => [job.url, job]));
  const parsed = extractJson(text);
  const out = [];
  for (const row of parsed.jobs || []) {
    const job = allowed.get(String(row?.url || ""));
    if (!job) continue;
    const fit = Math.max(0, Math.min(100, Number(row.fit) || 0));
    out.push({
      ...job,
      fit,
      why: String(row.why || "").slice(0, 220),
      gap: String(row.gap || "").slice(0, 220),
    });
  }
  return out;
}

export function batch(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * Judges a shortlist and returns the best, worst gaps named. `ask` is one call
 * to the agent; batches run one after another so the session keeps its context
 * small and each answer stays cheap.
 */
export async function auditJobs({ jobs, cv, profile, rules, ask, size = 25, top = 10, onBatch }) {
  const judged = [];
  const batches = batch(jobs, size);
  for (const [index, group] of batches.entries()) {
    onBatch?.(index + 1, batches.length);
    try {
      const text = await ask(auditBatchPrompt({ jobs: group, cv, profile, rules }));
      judged.push(...parseAudit(text, group));
    } catch (error) {
      onBatch?.(index + 1, batches.length, error.message);
    }
  }
  judged.sort((a, b) => b.fit - a.fit);
  return { judged, best: judged.slice(0, top) };
}
