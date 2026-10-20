// Job boards that answer a plain request. LinkedIn, Indeed and Google Jobs render
// their listings in JavaScript behind a bot check, so those are read by driving a
// tab you are already signed into; these are read directly.

const TIMEOUT = 15000;

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function clean(value, max = 160) {
  return stripTags(value).slice(0, max);
}

export function normalize(job) {
  if (!job?.url || !/^https?:\/\//i.test(job.url)) return null;
  const title = clean(job.title, 140);
  if (!title) return null;
  return {
    title,
    company: clean(job.company, 90),
    location: clean(job.location, 90) || "Not stated",
    url: job.url.split("#")[0],
    source: job.source || "",
    posted: job.posted || "",
    summary: clean(job.summary, 400),
  };
}

export function dedupe(jobs) {
  const seen = new Set();
  const out = [];
  for (const job of jobs) {
    const row = normalize(job);
    if (!row) continue;
    const key = row.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function matches(job, terms) {
  if (!terms.length) return true;
  const hay = `${job.title} ${job.company} ${job.summary}`.toLowerCase();
  return terms.some((term) => {
    const words = term.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
    if (!words.length) return false;
    return words.every((word) => hay.includes(word));
  });
}

async function getJson(url, fetchJson) {
  const response = await fetchJson(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} answered ${response.status}`);
  return response.json();
}

export const FEEDS = {
  async remoteok(query, fetchJson) {
    const data = await getJson("https://remoteok.com/api", fetchJson);
    return (Array.isArray(data) ? data : []).slice(1).map((job) => ({
      title: job.position || job.title,
      company: job.company,
      location: job.location || "Remote",
      url: job.url || job.apply_url,
      posted: job.date,
      summary: job.description,
      source: "RemoteOK",
    }));
  },
  async jobicy(query, fetchJson) {
    const data = await getJson(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${encodeURIComponent(query)}`, fetchJson);
    return (data.jobs || []).map((job) => ({
      title: job.jobTitle,
      company: job.companyName,
      location: job.jobGeo || "Remote",
      url: job.url,
      posted: job.pubDate,
      summary: job.jobExcerpt,
      source: "Jobicy",
    }));
  },
  async remotive(query, fetchJson) {
    const data = await getJson(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=40`, fetchJson);
    return (data.jobs || []).map((job) => ({
      title: job.title,
      company: job.company_name,
      location: job.candidate_required_location,
      url: job.url,
      posted: job.publication_date,
      summary: job.description,
      source: "Remotive",
    }));
  },
  async arbeitnow(query, fetchJson) {
    const data = await getJson("https://www.arbeitnow.com/api/job-board-api", fetchJson);
    return (data.data || []).map((job) => ({
      title: job.title,
      company: job.company_name,
      location: [job.location, job.remote ? "Remote" : ""].filter(Boolean).join(" · "),
      url: job.url,
      posted: job.created_at ? new Date(job.created_at * 1000).toISOString() : "",
      summary: job.description,
      source: "Arbeitnow",
    }));
  },
  async himalayas(query, fetchJson) {
    const data = await getJson(`https://himalayas.app/jobs/api?limit=50&search=${encodeURIComponent(query)}`, fetchJson);
    return (data.jobs || []).map((job) => ({
      title: job.title,
      company: job.companyName,
      location: (job.locationRestrictions || []).join(", ") || "Remote",
      url: job.applicationLink || job.guid,
      posted: job.pubDate,
      summary: job.excerpt || job.description,
      source: "Himalayas",
    }));
  },
};

export const BOARDS = {
  async greenhouse(slug, fetchJson) {
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`, fetchJson);
    return (data.jobs || []).map((job) => ({
      title: job.title,
      company: slug,
      location: job.location?.name || "",
      url: job.absolute_url,
      posted: job.updated_at,
      source: "Greenhouse",
    }));
  },
  async lever(slug, fetchJson) {
    const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`, fetchJson);
    return (Array.isArray(data) ? data : []).map((job) => ({
      title: job.text,
      company: slug,
      location: job.categories?.location || "",
      url: job.hostedUrl,
      posted: job.createdAt ? new Date(job.createdAt).toISOString() : "",
      summary: job.descriptionPlain,
      source: "Lever",
    }));
  },
  async ashby(slug, fetchJson) {
    const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`, fetchJson);
    return (data.jobs || []).map((job) => ({
      title: job.title,
      company: slug,
      location: job.location || "",
      url: job.jobUrl || job.applyUrl,
      posted: job.publishedAt,
      source: "Ashby",
    }));
  },
};

export function companySlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(inc|ltd|limited|llc|gmbh|plc|corp)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** Tries a company's own board on the three systems most teams use. */
export async function companyJobs(name, { fetchJson = fetch, onNote } = {}) {
  const slug = companySlug(name);
  if (!slug) return [];
  const tries = await Promise.allSettled([
    BOARDS.greenhouse(slug, fetchJson),
    BOARDS.lever(slug, fetchJson),
    BOARDS.ashby(slug, fetchJson),
  ]);
  const found = tries.filter((entry) => entry.status === "fulfilled" && entry.value.length).flatMap((entry) => entry.value);
  if (!found.length) onNote?.(`No public board for ${name}.`);
  return found;
}

/**
 * Reads the open feeds for the roles asked for. Returns what matched, and what
 * failed, so the panel can say which source was down rather than showing nothing.
 */
export async function feedJobs(roles, { fetchJson = fetch, limit = 60 } = {}) {
  const terms = (roles || []).map((role) => String(role).trim()).filter(Boolean);
  const query = terms[0] || "engineer";
  const runs = await Promise.allSettled([
    FEEDS.remotive(query, fetchJson),
    FEEDS.arbeitnow(query, fetchJson),
    FEEDS.himalayas(query, fetchJson),
    FEEDS.remoteok(query, fetchJson),
    FEEDS.jobicy(query, fetchJson),
  ]);
  const problems = [];
  const jobs = [];
  const names = ["Remotive", "Arbeitnow", "Himalayas", "RemoteOK", "Jobicy"];
  runs.forEach((run, index) => {
    if (run.status === "fulfilled") jobs.push(...run.value);
    else problems.push(`${names[index]}: ${run.reason?.message || "no answer"}`);
  });
  const rows = dedupe(jobs).filter((job) => matches(job, terms));
  return { jobs: rows.slice(0, limit), problems, searched: query };
}

export const SITE_SEARCHES = [
  { id: "linkedin", name: "LinkedIn", needsLogin: true, url: (q, where) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}&location=${encodeURIComponent(where || "")}&f_TPR=r604800` },
  { id: "indeed", name: "Indeed", needsLogin: false, url: (q, where) => `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&l=${encodeURIComponent(where || "")}&fromage=7` },
  { id: "wellfound", name: "Wellfound", needsLogin: true, url: (q) => `https://wellfound.com/jobs?query=${encodeURIComponent(q)}` },
  { id: "weworkremotely", name: "We Work Remotely", needsLogin: false, url: (q) => `https://weworkremotely.com/remote-jobs/search?term=${encodeURIComponent(q)}` },
  { id: "otta", name: "Welcome to the Jungle", needsLogin: true, url: (q) => `https://www.welcometothejungle.com/en/jobs?query=${encodeURIComponent(q)}` },
];

export function siteSearchUrl(id, query, where) {
  const site = SITE_SEARCHES.find((entry) => entry.id === id);
  return site ? site.url(query, where) : "";
}
