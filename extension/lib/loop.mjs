import { extractJson } from "./tailor.mjs";

export const SYSTEM_PROMPT = `You drive a Chrome tab for a person applying to jobs. You see a compact outline of the page: numbered refs, what each one is, and the words printed on it. You answer with ONE JSON object and nothing else.

Actions:
{"action":"click","ref":"f12","why":"short reason"}
{"action":"type","ref":"f3","text":"value","why":""}
{"action":"select","ref":"f7","value":"Option label","why":""}
{"action":"upload_cv","ref":"f9","why":""}
{"action":"scroll","amount":1,"why":"looking further down"}
{"action":"navigate","url":"https://...","why":""}
{"action":"collect","jobs":[{"title":"","company":"","location":"","url":"https://..."}],"why":""}
{"action":"ask_human","message":"what the person must do in the tab","why":""}
{"action":"ready_to_submit","ref":"f20","why":"the form is complete"}
{"action":"done","summary":"what happened","why":""}

Rules.
Never answer with prose, explanation or markdown. One JSON object.
Answer form fields from WHO YOU ARE APPLYING AS. Never ask the person for something already listed there.
Never invent a reason for a failure. If a step did not work, say exactly what you tried and what came back. There is no file size limit; the docket handles attaching.
Never invent an employer, a title, a date or a number that is not in the CV.
You never submit. When the form is filled, answer ready_to_submit and the person decides.
If a captcha, a sign-in wall, or a question the CV cannot answer is in the way, answer ask_human.
If the page is a list of jobs, answer collect with the postings worth opening.
If the page is not a job and not a list, answer done and say so.
If the page already says applied, application submitted, or you have applied, answer done and say the application is already in.
A button that opens a new tab is fine: the docket follows it. Say what you clicked.
Prefer the ref of a control you can see over navigating away.
If the CV still needs attaching and no file control is listed, click the attach, upload or add-file button first, then look again.
Never type a phone number, a name or an address into a country or dial-code picker.
One step at a time. You will see the result of each step before the next.`;

export const MAX_STEPS = 24;

function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** What the agent sees. Small enough to answer in a second, full enough to act. */
/** The person's own answers, so the agent never asks for what it already has. */
export function whoBlock(profile = {}, cvFacts = "") {
  const rows = [
    ["First name", profile.firstName],
    ["Last name", profile.lastName],
    ["Full name", profile.fullName],
    ["Email", profile.email],
    ["Phone", profile.phone],
    ["Lives in", profile.location],
    ["LinkedIn", profile.linkedin],
    ["GitHub", profile.github],
    ["Website", profile.website],
    ["Allowed to work there", profile.workAuth],
    ["Needs sponsorship", profile.sponsorship],
    ["Salary wanted", profile.salary],
    ["Notice period", profile.notice],
  ].filter(([, value]) => String(value || "").trim());
  const lines = rows.map(([label, value]) => `${label}: ${value}`);
  if (cvFacts) lines.push(`From the CV: ${clip(cvFacts, 700)}`);
  return lines.join("\n") || "nothing on file";
}

export function pageView(page, { mode, note, who = "", attached = "" } = {}) {
  const rows = (page?.outline || []).map((row) => {
    const bits = [`${row.ref}`, row.kind, row.label ? `"${clip(row.label, 70)}"` : ""];
    if (row.value) bits.push(`= ${clip(row.value, 40)}`);
    if (row.required) bits.push("required");
    if (row.checked) bits.push("checked");
    if (row.href && row.kind === "link") bits.push(clip(row.href, 90));
    return bits.filter(Boolean).join(" ");
  });
  return [
    `MODE: ${mode || "apply"}`,
    who ? `WHO YOU ARE APPLYING AS:\n${who}` : "",
    attached ? `CV ALREADY ATTACHED: ${attached}` : "",
    `URL: ${page?.url || ""}`,
    `TITLE: ${clip(page?.title || page?.job?.title || "", 120)}`,
    page?.captcha ? "CAPTCHA: yes" : "",
    page?.loginWall ? "SIGN-IN WALL: yes" : "",
    page?.confirmation ? "CONFIRMATION TEXT: yes" : "",
    note ? `NOTE: ${note}` : "",
    "",
    "CONTROLS:",
    rows.join("\n") || "none visible",
    "",
    "PAGE TEXT:",
    clip(page?.text || page?.job?.description || "", 3500),
  ].filter((part) => part !== "").join("\n");
}

export function parseAction(text) {
  const parsed = extractJson(text);
  const action = String(parsed.action || "").toLowerCase();
  const why = clip(parsed.why || "", 140);
  if (action === "click") return { action, ref: String(parsed.ref || ""), why };
  if (action === "type") return { action, ref: String(parsed.ref || ""), text: String(parsed.text ?? ""), why };
  if (action === "select") return { action, ref: String(parsed.ref || ""), value: String(parsed.value ?? ""), why };
  if (action === "upload_cv") return { action, ref: String(parsed.ref || ""), why };
  if (action === "scroll") return { action, amount: Number(parsed.amount) || 1, why };
  if (action === "navigate") {
    const url = String(parsed.url || "");
    if (!/^https?:\/\//i.test(url)) throw new Error("The agent asked for a link the docket will not open.");
    return { action, url, why };
  }
  if (action === "collect") {
    const jobs = (parsed.jobs || [])
      .filter((job) => /^https?:\/\//i.test(String(job?.url || "")))
      .slice(0, 30)
      .map((job) => ({
        title: clip(job.title, 120),
        company: clip(job.company, 80),
        location: clip(job.location, 80),
        url: String(job.url),
      }));
    return { action, jobs, why };
  }
  if (action === "ask_human") return { action, message: clip(parsed.message || "Take over in the tab.", 300), why };
  if (action === "ready_to_submit") return { action, ref: String(parsed.ref || ""), why };
  if (action === "done") return { action, summary: clip(parsed.summary || "", 300), why };
  throw new Error(`The agent asked for "${action || "nothing"}", which the docket does not do.`);
}

const SEND_WORDS = /submit|send application|apply now|finish|complete application/i;

function rowFor(page, ref) {
  return (page?.outline || []).find((row) => row.ref === ref) || null;
}

/**
 * Runs the loop until it finishes, needs a person, or hits the step cap.
 * Every effect is a dep, so the loop is testable without Chrome.
 */
export async function runLoop(deps, options = {}) {
  const mode = options.mode || "apply";
  const maxSteps = options.maxSteps || MAX_STEPS;
  const collected = [];
  let note = options.note || "";
  let lastAction = "";
  let repeats = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    if (deps.shouldStop?.()) return { status: "stopped", steps: step, collected };

    let page;
    try {
      page = await deps.readPage();
    } catch (error) {
      return { status: "blocked", message: error.message, steps: step, collected };
    }

    if (page.captcha && !options.ignoreCaptcha) {
      const seen = page.captchaDetail;
      return {
        status: "needs-human",
        reason: "captcha",
        message: seen
          ? `There looks to be a captcha on this page — ${seen.what}, ${seen.size}. Solve it in the tab, then continue.`
          : "A captcha is on this page. Solve it in the tab, then continue.",
        page,
        steps: step,
        collected,
      };
    }
    if (page.loginWall) return { status: "needs-human", message: "This page wants you to sign in. Sign in, then continue.", page, steps: step, collected };

    let action;
    try {
      const answer = await deps.ask(pageView(page, { mode, note, who: deps.who || "", attached: deps.attached || "" }));
      action = parseAction(answer);
    } catch (error) {
      return { status: "blocked", message: error.message, page, steps: step, collected };
    }

    const signature = `${action.action}:${action.ref || action.url || ""}`;
    repeats = signature === lastAction ? repeats + 1 : 0;
    lastAction = signature;
    if (repeats >= 2) {
      return { status: "needs-human", message: "The agent is going in circles on this page. Take a look, then continue or skip.", page, steps: step, collected };
    }

    deps.onStep?.({ ...action, step: step + 1 });
    note = "";

    try {
      if (action.action === "done") {
        return { status: "done", message: action.summary, page, steps: step + 1, collected };
      }
      if (action.action === "ask_human") {
        return { status: "needs-human", message: action.message, page, steps: step + 1, collected };
      }
      if (action.action === "collect") {
        collected.push(...action.jobs);
        if (mode === "search") {
          return { status: "collected", collected, page, steps: step + 1 };
        }
        note = "Noted. Now open the posting that fits best, or answer done.";
        continue;
      }
      if (action.action === "ready_to_submit") {
        const row = rowFor(page, action.ref);
        return {
          status: "ready-to-submit",
          message: action.why || "The form is filled.",
          submit: row ? { ref: row.ref, frameId: row.frameId, label: row.label } : null,
          page,
          steps: step + 1,
          collected,
        };
      }
      if (action.action === "navigate") {
        await deps.navigate(action.url);
        continue;
      }
      if (action.action === "scroll") {
        const result = await deps.scroll({ amount: action.amount });
        note = result?.bottom ? "That is the bottom of the page." : "";
        continue;
      }

      const row = rowFor(page, action.ref);
      if (!row) {
        note = `There is no ref ${action.ref} on this page. Use one from the list.`;
        continue;
      }

      // The docket, not the agent, decides what counts as sending an application.
      if (action.action === "click" && SEND_WORDS.test(row.label || "") && !deps.sendApproved?.()) {
        return {
          status: "ready-to-submit",
          message: `The agent wants to press "${row.label}". Read the draft first.`,
          submit: { ref: row.ref, frameId: row.frameId, label: row.label },
          page,
          steps: step + 1,
          collected,
        };
      }

      if (action.action === "click") {
        await deps.act({ type: "click", ref: row.ref, label: row.label, frameId: row.frameId });
        await deps.wait?.();
        continue;
      }
      if (action.action === "type") {
        await deps.act({ type: "fill", ref: row.ref, label: row.label, value: action.text, frameId: row.frameId });
        continue;
      }
      if (action.action === "select") {
        await deps.act({ type: "select", ref: row.ref, label: row.label, value: action.value, frameId: row.frameId });
        continue;
      }
      if (action.action === "upload_cv") {
        if (!deps.cvFile) {
          note = "No CV file is ready to attach. Skip that field.";
          continue;
        }
        await deps.act({
          type: "upload",
          ref: row.ref,
          label: row.label,
          frameId: row.frameId,
          base64: deps.cvFile.base64,
          filename: deps.cvFile.filename,
          mime: deps.cvFile.mime,
        });
        continue;
      }
    } catch (error) {
      note = `That step failed: ${error.message}. Try another way.`;
    }
  }

  return { status: "needs-human", message: `The docket stopped after ${maxSteps} steps on this page.`, steps: maxSteps, collected };
}
