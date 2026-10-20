# Job Docket

A Chrome side panel that works a job page the way you would. It reads the page, decides the next click, tailors a copy of your master CV, fills the form, and stops the moment a person is needed: a captcha, a sign-in, a question the CV cannot answer, or the step before anything is sent.

The thinking runs on Claude Code already signed in on this Mac. No API key, no second subscription.

## Install

```sh
npm install
node bridge/install-host.mjs     # registers the bridge Chrome talks to
```

Then:

1. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, select the `extension` folder.
2. Quit Chrome completely and open it again. Chrome only picks up a new bridge at startup.
3. Pin Job Docket and click the icon.

The dot in the panel is green when the bridge answers.

## Use it

Type what you want, or use the row of chips.

- **Find jobs** reads every company board it knows — 99 shipped with it, carrying over ten thousand open roles — plus five keyword feeds (Remotive, Arbeitnow, Himalayas, RemoteOK, Jobicy). Results are ranked by how close the title is to your roles, what you said you prefer, your location and how fresh the posting is.

  No search engine is involved. Google and DuckDuckGo refuse scripted queries, so the docket reads the source instead: every company on Greenhouse, Lever, Ashby or SmartRecruiters publishes its whole board as plain JSON, no key and no login. The list grows by itself — each posting names a board, and that board is read in full next time.

  **Also search a company** takes a name and tries it on all four systems.
- **Search LinkedIn / Indeed in a tab** opens the site and lets the agent scroll and collect, using the session you are already signed into. Those sites render their listings in JavaScript and block scripted reading, so this is the honest way in.
- **Read this page** says what the open tab is and offers to queue or apply.
- **Apply here** works the tab in front of you.
- **Run the queue** goes through the saved list, up to the cap in Rules.
- **Stop** holds everything.
- **Check setup** runs five checks — bridge, agent, tab, page reading, page control — and prints the exact error for whichever one fails.

Every step the agent takes carries a **what exactly?** link: the control it touched, what it typed, why it did it, and the page it was on.

A skipped job is never silent. The reason is shown with **Apply anyway** next to it, because you are the one who knows what you can defend in a first call.

When the panel says **Over to you**, do the thing it names in the tab and press **I've done it**. When it says **Ready to send**, read the draft, then send or skip.

## What it will not do

It never presses submit on its own. The docket, not the agent, decides what counts as sending: any control named submit, send application, apply now or finish stops the run and waits for you, even when the agent asks to click it.

It never adds an employer, a title, a date or a number that is not already in your CV. A send is capped at five applications per run until you raise it in Rules.

It does not sign in, solve a captcha, or agree to a privacy box.

## How it works

- `extension/content/page-agent.js` turns a page into a numbered outline of the things you can touch, and acts on one by reference.
- `extension/lib/loop.mjs` is the agent loop: read, decide one action, act, repeat. It caps steps, breaks out of circles, and gates sending.
- `extension/lib/sources.mjs` reads the open job boards directly.
- `bridge/` holds one streaming Claude Code session open for the life of the panel. A cold `claude -p` with every setting source loaded costs about fourteen seconds and eighty thousand tokens of context; this costs one to three seconds and a few hundred.

```sh
npm test
```

## Testing it for real

`npm test` covers the pure parts. The end-to-end script loads the real extension into a real Chrome and drives the side panel the way you would:

```sh
npm run e2e:chrome     # once: Chrome for Testing, because stable Chrome refuses --load-extension
npm run e2e -- "https://job-boards.greenhouse.io/<company>/jobs/<id>"
```

It opens the posting, points the docket at that tab, presses Apply here, and prints every step, the state of the form afterwards, and any error the panel threw. It never presses send.

There is a second script for search:

```sh
node test/e2e/search.mjs "Engineering Manager"
```

Last runs, both in the loaded extension: searching *Engineering Manager* read 10,336 roles across 99 boards and queued 60; applying to a live GitLab posting tailored the CV, filled seven fields, attached the document and stopped on two questions only a person can answer.

## How it actually works

Four pieces, worth reading in this order if you want to see how an agent loop is built.

**`extension/content/page-agent.js`** turns a web page into something a model can act on: a numbered list of the things you can touch, each with the words printed on it (`f12 button "Submit application" required`). Acting on a ref is exact, so a click never lands on the wrong Apply. It also moves a visible cursor to the control before touching it.

**`extension/lib/loop.mjs`** is the agent loop. Read the page, send a compact view to the model, get back exactly one JSON action, carry it out, repeat. The view is capped at about 90 controls and 3,500 characters of text, which is what keeps a step at one to three seconds. The loop caps steps, breaks out of repeated actions, and — this part matters — the *code*, not the model, decides what counts as sending an application. A click on anything labelled submit or send stops the run and asks you.

**`bridge/`** holds one streaming Claude Code session open for the life of the panel. A cold `claude -p` loads every setting source, skill and memory file on the machine: about fourteen seconds and eighty thousand tokens of context before anything useful happens. With a written system prompt and `--setting-sources ""`, the same step costs one to three seconds and a few hundred tokens. That one change is most of what makes this usable.

**`extension/lib/audit.mjs`** is the difference between ranking and judging. `discover.mjs` ranks by arithmetic — word overlap, a freshness bonus — which cannot tell a backend engineer who has run payment rails from one who has not. The audit sends the CV and the postings to the model in batches of 25 and asks for a fit score, one concrete reason, and the single gap that would sink the application.

Two rules run through all of it: the model is never trusted with an irreversible action, and nothing may be invented that is not already in your CV.
