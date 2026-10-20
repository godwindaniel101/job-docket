export const DEFAULTS = {
  profile: {
    fullName: "",
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    location: "",
    linkedin: "",
    github: "",
    website: "",
    workAuth: "",
    sponsorship: "",
    salary: "",
    notice: "",
    coverNote: "",
  },
  masterCv: "",
  rules: {
    avoidCompanies: "",
    avoidRegions: "",
    dos: "",
    donts: "",
    roles: "",
    boards: "",
    pageSize: "a4",
    skipPoorFit: true,
    pauseBeforeSubmit: true,
    showPointer: true,
    maxApplications: 5,
  },
  llm: {
    provider: "anthropic",
    apiKey: "",
    model: "",
  },
  agent: {
    id: "auto",
  },
  applications: [],
  queue: [],
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    profile: { ...DEFAULTS.profile, ...(stored.profile || {}) },
    masterCv: stored.masterCv ?? DEFAULTS.masterCv,
    rules: { ...DEFAULTS.rules, ...(stored.rules || {}) },
    llm: { ...DEFAULTS.llm, ...(stored.llm || {}) },
    agent: { ...DEFAULTS.agent, ...(stored.agent || {}) },
    applications: stored.applications || [],
    queue: stored.queue || [],
  };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({
    profile: settings.profile,
    masterCv: settings.masterCv,
    rules: settings.rules,
    llm: settings.llm || DEFAULTS.llm,
    agent: settings.agent || DEFAULTS.agent,
  });
}

/** The queue outlives the panel: closing it must not throw away a search. */
export function trimQueue(queue, limit = 400) {
  const seen = new Set();
  const kept = [];
  for (const job of queue || []) {
    if (!job?.url || seen.has(job.url)) continue;
    seen.add(job.url);
    kept.push({
      title: job.title || "",
      company: job.company || "",
      location: job.location || "",
      url: job.url,
      source: job.source || "",
      posted: job.posted || "",
      summary: String(job.summary || "").slice(0, 500),
      fit: job.fit ?? null,
      why: job.why || "",
      gap: job.gap || "",
    });
    if (kept.length >= limit) break;
  }
  return kept;
}

export async function saveQueue(queue) {
  const kept = trimQueue(queue);
  await chrome.storage.local.set({ queue: kept });
  return kept;
}

export const APPLICATION_STATES = ["applied", "skipped", "declined", "interviewing", "offer"];

export async function rememberApplication(entry) {
  const current = await loadSettings();
  const applications = [
    { ...entry, at: new Date().toISOString() },
    ...current.applications.filter((item) => item.url !== entry.url),
  ].slice(0, 1000);
  await chrome.storage.local.set({ applications });
  return applications;
}
