const TAILOR_RULES = `You tailor a software engineer's CV to one posting. You do not invent a career.

Hard rules:
- Never invent employers, titles, dates, degrees, tools, scope, headcount, or metrics.
- Never change an official title, employer, or date.
- Never add a skill the master CV does not already support.
- Never hide keywords. Never paste the job description into the CV.
- If a number would help and the master does not contain it, omit the number. Do not guess.
- Gaps stay gaps. If two or more must-haves have no evidence, set skip to true when skipPoorFit is true.
- Allowed edits: target title line, short summary, skill order, which bullets lead each role, and how tightly older roles are compressed.
- Use the posting's exact term only where the work is real. One or two mentions is enough.
- A cover letter is optional. Write it only from the master CV. Leave coverLetter empty if there is nothing true to add.

The tailoredMarkdown must follow this shape exactly, because it is rendered into a Word document:

# FULL NAME
City, Country · email · phone · linkedin.com/in/handle · github.com/handle
## Summary
Two sentences at most. The target title, the years, the proof.
## Experience
### Job Title — Employer | 2022 – Present
- One line each. Start with the verb. Keep the master CV's own numbers.
### Earlier Title — Employer | 2019 – 2022
- Older roles get fewer lines.
## Skills
Grouped on one or two lines, separated by ·
## Education
### Degree — Institution | 2014 – 2018

Rules for the shape: one # line only, the contact line directly under it, ## for sections, ### for every role with the dates after a single |, - for bullets. No tables, no columns, no emoji, no markdown links, no horizontal rules. Nothing else above the name.

Return JSON only, no markdown fence:
{
  "fit": "strong" | "partial" | "poor",
  "skip": boolean,
  "skipReason": string,
  "summary": string,
  "gaps": string[],
  "claimsToDefend": string[],
  "tailoredMarkdown": string,
  "coverLetter": string
}`;

export function buildTailorPrompt({ masterCv, job, rules }) {
  return `${TAILOR_RULES}

skipPoorFit: ${rules?.skipPoorFit !== false}

Prefer (soft, do not reject only because one is missing):
${(rules?.dos || []).map((line) => `- ${line}`).join("\n") || "- none"}

Hard conflicts. Set skip true when the posting clearly conflicts:
${(rules?.donts || []).map((line) => `- ${line}`).join("\n") || "- none"}

Master CV:
${masterCv}

Posting:
Title: ${job?.title || ""}
Company: ${job?.company || ""}
Location: ${job?.location || ""}
URL: ${job?.url || ""}

${job?.description || ""}`;
}

export function extractJson(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The model did not return JSON.");
  return JSON.parse(body.slice(start, end + 1));
}

export function activeModel(llm) {
  if (!llm?.apiKey) return null;
  if (llm.provider === "openai") return { provider: "OpenAI", model: llm.model || "gpt-4.1" };
  return { provider: "Anthropic", model: llm.model || "claude-sonnet-4-5" };
}

export function parseModelJson(text) {
  const parsed = extractJson(text);
  return {
    fit: parsed.fit || "partial",
    skip: Boolean(parsed.skip),
    skipReason: String(parsed.skipReason || ""),
    summary: String(parsed.summary || ""),
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String) : [],
    claimsToDefend: Array.isArray(parsed.claimsToDefend) ? parsed.claimsToDefend.map(String) : [],
    tailoredMarkdown: String(parsed.tailoredMarkdown || ""),
    coverLetter: String(parsed.coverLetter || ""),
  };
}

export function novelFigures(master, tailored) {
  const figures = (value) =>
    new Set((String(value || "").match(/(?:\$|£|€)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?%/g) || []).map((item) => item.replace(/\s/g, "")));
  const known = figures(master);
  return [...figures(tailored)].filter((item) => !known.has(item));
}

function textFromAnthropic(payload) {
  const blocks = payload?.content || [];
  return blocks.map((block) => block.text || "").join("\n");
}

function textFromOpenAI(payload) {
  return payload?.choices?.[0]?.message?.content || "";
}

const REVIEW_RULES = `You read a software engineer's CV and do two things.
1. Name 3 to 6 role titles this CV can honestly support. Use titles a company would put on a posting. Do not invent seniority the CV does not show.
2. Fine-tune the CV for a recruiter's first scan. This is a cleaner master, not a new career.

Hard rules:
- Never invent employers, titles, dates, degrees, tools, scope, headcount, or metrics.
- Never change an official title, employer, or date.
- Never add a skill the source CV does not support.
- If a number is missing, omit it and mention the gap in questions.
- Put the strongest proof first.
- Return JSON only:
{
  "roles": string[],
  "summary": string,
  "changes": string[],
  "questions": string[],
  "fineTunedMarkdown": string
}`;

export function buildReviewPrompt(masterCv) {
  return `${REVIEW_RULES}

Source CV:
${masterCv}`;
}

async function askModel({ provider, apiKey, model, prompt, maxTokens, json, fetchImpl }) {
  let response;
  if (provider === "openai") {
    response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || "gpt-4.1",
        messages: [{ role: "user", content: prompt }],
        ...(json ? { response_format: { type: "json_object" } } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
    });
  } else {
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-5",
        max_tokens: maxTokens || 8000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Model request failed (${response.status}). ${detail.slice(0, 180)}`);
  }
  const payload = await response.json();
  return provider === "openai" ? textFromOpenAI(payload) : textFromAnthropic(payload);
}

export function buildAdjustPrompt({ masterCv, draft, note, history }) {
  return `You are revising a CV with the person who wrote it. Answer in JSON only:
{
  "reply": string,
  "changes": string[],
  "fineTunedMarkdown": string
}

The reply is one or two sentences they can read in a chat. changes is the list of edits you actually made. fineTunedMarkdown is the full draft after those edits.

Hard rules:
- Never invent employers, titles, dates, degrees, tools, scope, headcount, or metrics.
- Never change an official title, employer, or date.
- If the note asks for a fact the master CV does not support, say so in reply and do not add it.
- If you cannot make the change, return the current draft unchanged.

Earlier notes:
${history || "none"}

Their note:
${note}

Master CV, the source of truth:
${masterCv}

Current draft:
${draft || masterCv}`;
}

export function parseAdjust(text, masterCv) {
  const parsed = extractJson(text);
  const fineTunedMarkdown = String(parsed.fineTunedMarkdown || "").trim();
  const figures = novelFigures(masterCv, fineTunedMarkdown);
  const changes = (Array.isArray(parsed.changes) ? parsed.changes : []).map(String).filter(Boolean).slice(0, 6);
  if (figures.length) {
    return {
      reply: `${String(parsed.reply || "I cannot add that.").replace(/\s+$/, "")} These figures are not in the CV, so the draft stays as it was: ${figures.join(", ")}.`,
      changes: [],
      fineTunedMarkdown: "",
    };
  }
  return {
    reply: String(parsed.reply || "Done."),
    changes,
    fineTunedMarkdown,
  };
}

export async function reviewCv({ provider, apiKey, model, masterCv, fetchImpl = fetch, complete }) {
  if (!String(masterCv || "").trim()) throw new Error("Upload a CV first.");
  const prompt = buildReviewPrompt(masterCv);
  const text = complete
    ? await complete(prompt)
    : await askModel({
      provider,
      apiKey,
      model,
      prompt,
      maxTokens: 8000,
      json: true,
      fetchImpl,
    });
  const parsed = extractJson(text);
  const fineTunedMarkdown = String(parsed.fineTunedMarkdown || "");
  const questions = Array.isArray(parsed.questions) ? parsed.questions.map(String) : [];
  const figures = novelFigures(masterCv, fineTunedMarkdown);
  if (figures.length) questions.push(`These figures are not in the uploaded CV: ${figures.join(", ")}`);
  return {
    roles: (Array.isArray(parsed.roles) ? parsed.roles : []).map(String).filter(Boolean).slice(0, 6),
    summary: String(parsed.summary || ""),
    changes: (Array.isArray(parsed.changes) ? parsed.changes : []).map(String).slice(0, 8),
    questions,
    fineTunedMarkdown,
  };
}

export async function tailorCv({ provider, apiKey, model, masterCv, job, rules, fetchImpl = fetch, complete }) {
  if (!String(masterCv || "").trim()) {
    throw new Error("Upload your CV before applying.");
  }

  const prompt = buildTailorPrompt({ masterCv, job, rules });
  if (!complete && !apiKey) {
    return {
      fit: "unknown",
      skip: false,
      skipReason: "",
      summary: "No local agent answered, so this is the master CV unchanged.",
      gaps: [],
      claimsToDefend: [],
      tailoredMarkdown: masterCv,
      coverLetter: "",
      untailored: true,
    };
  }
  const text = complete
    ? await complete(prompt)
    : await askModel({
      provider,
      apiKey,
      model,
      prompt,
      maxTokens: 8000,
      json: true,
      fetchImpl,
    });
  const result = parseModelJson(text);
  if (!result.tailoredMarkdown.trim()) result.tailoredMarkdown = masterCv;
  result.novelFigures = novelFigures(masterCv, result.tailoredMarkdown);
  if (result.novelFigures.length) {
    result.claimsToDefend = [
      ...result.claimsToDefend,
      `These figures are not in the master CV: ${result.novelFigures.join(", ")}`,
    ];
  }
  if (rules?.skipPoorFit !== false && (result.fit === "poor" || result.skip)) {
    result.skip = true;
    if (!result.skipReason) result.skipReason = "The posting is a poor match for the master CV.";
  }
  return result;
}

export async function testModelConnection({ provider, apiKey, model, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("Add a model key first.");
  await askModel({
    provider,
    apiKey,
    model,
    prompt: "Reply with the word ready.",
    maxTokens: 8,
    json: false,
    fetchImpl,
  });
  const active = activeModel({ provider, apiKey, model });
  return `${active.provider} answered.`;
}
