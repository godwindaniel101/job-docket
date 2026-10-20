// Finding work nobody sent you. Search engines refuse scripted queries, but every
// company using Greenhouse, Lever, Ashby or SmartRecruiters publishes its whole
// board as plain JSON. Reading those boards directly beats any keyword search:
// four boards alone carry more than a thousand open roles.

import { normalize } from "./policy.mjs";
import { dedupe } from "./sources.mjs";

export const SYSTEMS = {
  greenhouse: {
    name: "Greenhouse",
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    read: (data, slug) => (data.jobs || []).map((job) => ({
      title: job.title,
      company: slug,
      location: job.location?.name || "",
      url: job.absolute_url,
      posted: job.updated_at || "",
      source: "Greenhouse",
    })),
  },
  lever: {
    name: "Lever",
    url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    read: (data, slug) => (Array.isArray(data) ? data : []).map((job) => ({
      title: job.text,
      company: slug,
      location: job.categories?.location || "",
      url: job.hostedUrl,
      posted: job.createdAt ? new Date(job.createdAt).toISOString() : "",
      summary: job.descriptionPlain || "",
      source: "Lever",
    })),
  },
  ashby: {
    name: "Ashby",
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    read: (data, slug) => (data.jobs || []).map((job) => ({
      title: job.title,
      company: slug,
      location: job.location || "",
      url: job.jobUrl || job.applyUrl,
      posted: job.publishedAt || "",
      source: "Ashby",
    })),
  },
  smartrecruiters: {
    name: "SmartRecruiters",
    url: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`,
    read: (data, slug) => (data.content || []).map((job) => ({
      title: job.name,
      company: job.company?.name || slug,
      location: [job.location?.city, job.location?.country].filter(Boolean).join(", "),
      url: `https://jobs.smartrecruiters.com/${slug}/${job.id}`,
      posted: job.releasedDate || "",
      source: "SmartRecruiters",
    })),
  },
  workable: {
    name: "Workable",
    url: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
    read: (data, slug) => (data.jobs || []).map((job) => ({
      title: job.title,
      company: data.name || slug,
      location: [job.city, job.country].filter(Boolean).join(", "),
      url: job.url || job.application_url,
      posted: job.published_on || "",
      summary: job.description || "",
      source: "Workable",
    })),
  },
  bamboohr: {
    name: "BambooHR",
    url: (slug) => `https://${slug}.bamboohr.com/careers/list`,
    read: (data, slug) => (data.result || []).map((job) => ({
      title: job.jobOpeningName,
      company: slug,
      location: [job.location?.city, job.location?.state, job.location?.country].filter(Boolean).join(", "),
      url: `https://${slug}.bamboohr.com/careers/${job.id}`,
      posted: job.datePosted || "",
      source: "BambooHR",
    })),
  },
};

const ATS_HOSTS = [
  [/job-boards\.greenhouse\.io\/([\w-]+)/i, "greenhouse"],
  [/boards\.greenhouse\.io\/([\w-]+)/i, "greenhouse"],
  [/jobs\.lever\.co\/([\w-]+)/i, "lever"],
  [/jobs\.ashbyhq\.com\/([\w-]+)/i, "ashby"],
  [/jobs\.smartrecruiters\.com\/([\w-]+)/i, "smartrecruiters"],
  [/apply\.workable\.com\/([\w-]+)/i, "workable"],
  [/([\w-]+)\.bamboohr\.com\/careers/i, "bamboohr"],
];

/** Every posting seen on a feed names a company board worth reading in full. */
export function boardFromUrl(url) {
  for (const [pattern, system] of ATS_HOSTS) {
    const found = String(url || "").match(pattern);
    if (found) return { system, slug: found[1].toLowerCase() };
  }
  return null;
}

export function slugFor(company) {
  return String(company || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(inc|ltd|limited|llc|gmbh|plc|corp|co|group|technologies|technology|labs)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

async function readBoard(system, slug, fetchJson) {
  const spec = SYSTEMS[system];
  if (!spec) return [];
  const response = await fetchJson(spec.url(slug), { signal: AbortSignal.timeout(14000) });
  if (!response.ok) return [];
  return spec.read(await response.json(), slug);
}

/** Runs the board reads a few at a time so a wide sweep does not stall. */
export async function pool(items, worker, size = 6) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const mine = index;
      index += 1;
      if (mine >= items.length) return;
      try {
        results.push(...(await worker(items[mine])) || []);
      } catch {
        // One dead board must not end the sweep.
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export function scoreJob(job, { roles = [], dos = [], location = "" } = {}) {
  const title = normalize(job.title);
  const blob = normalize(`${job.title} ${job.location} ${job.summary || ""}`);
  let score = 0;
  for (const role of roles) {
    const words = normalize(role).split(" ").filter((word) => word.length > 2);
    if (!words.length) continue;
    const hit = words.filter((word) => title.includes(word)).length / words.length;
    score = Math.max(score, hit * 60);
  }
  for (const want of dos) {
    if (normalize(want) && blob.includes(normalize(want))) score += 8;
  }
  if (location && blob.includes(normalize(location))) score += 10;
  if (/remote|anywhere/i.test(job.location || "")) score += 6;
  const age = job.posted ? (Date.now() - Date.parse(job.posted)) / 86400000 : 90;
  if (Number.isFinite(age)) score += Math.max(0, 14 - age / 3);
  return Math.round(score);
}

/**
 * Sweeps company boards and ranks what comes back. `seen` carries the slugs a
 * feed has already revealed, so the reach grows every time it runs.
 */
export async function sweepBoards(targets, { fetchJson = fetch, concurrency = 6, onNote } = {}) {
  const tried = new Set();
  const jobs = await pool(targets, async (target) => {
    const key = `${target.system}:${target.slug}`;
    if (tried.has(key)) return [];
    tried.add(key);
    const found = await readBoard(target.system, target.slug, fetchJson);
    if (found.length) onNote?.(`${target.slug}: ${found.length} open roles on ${SYSTEMS[target.system].name}`);
    return found;
  }, concurrency);
  return dedupe(jobs);
}

/** Tries one company name on every system, so a name is enough to search it. */
export function targetsForCompany(name) {
  const slug = slugFor(name);
  if (!slug) return [];
  return Object.keys(SYSTEMS).map((system) => ({ system, slug }));
}

export function rank(jobs, wants, limit = 200) {
  return jobs
    .map((job) => ({ ...job, score: scoreJob(job, wants) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
