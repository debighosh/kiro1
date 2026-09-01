# MSS LivePulse — Moderator Operating Guide

This guide explains how to run an MSS LivePulse event end to end: creating and
configuring an event, moving it through its lifecycle, moderating questions,
driving the presenter view, running polls and word clouds, using the optional AI
features, and exporting results afterwards.

## Audience and prerequisites

This guide is written for **event moderators and administrators**. In V1 a
moderator has the same authenticated interface and the same permissions as an
administrator — there is no separate fine-grained role.

Before you begin you need:

- **An admin account** and the ability to sign in at `/admin/login`. Every admin
  screen under `/admin/*` requires an authenticated session; unauthenticated
  visits are redirected to the login page.
- **An event** to run (see [Creating and configuring an event](#creating-and-configuring-an-event)).

A few facts that shape everything below:

- **Participants are anonymous.** They join from any modern mobile browser by
  scanning a QR code, opening the audience link, or typing the event code — no
  app install and no account. Their browser holds a random, non-personal
  identifier used only to enforce one vote / one response per person.
- **Participation is only possible while the event is `live`.** Draft, ended,
  and archived events withhold all participant controls.
- **Security is enforced server-side.** The admin UI is convenience and
  defence-in-depth; the database (Row Level Security) is the authoritative
  boundary. Participants never see pending or hidden questions regardless of
  what the UI does.

---

## Creating and configuring an event

Open the event editor at `/admin/events/new` and fill in the **Create event**
form. Fields:

- **Event name** (required) — 1 to 100 characters. This is a durable limit; a
  name that is empty or longer than 100 characters is rejected and your entered
  values are retained so you can correct them.
- **Description** (optional) — up to 500 characters.
- **Event code** (optional) — a short, human-enterable slug of 1 to 64
  characters using letters, digits, and hyphens. It must be unique; if the code
  is already in use, the form reports the conflict and changes nothing.
- **Starts at / Ends at** (required) — the end must be later than the start.
- **Brand colour** (optional) — e.g. `#0af`.
- **Moderation mode** (see below).

You submit with **Create event**. On success the editor shows a confirmation and
the sharing assets for the new event:

- The **Audience link** and a **QR code** that both resolve to the audience join
  page. Share either with attendees.
- The **Presenter link**, which contains the presenter token. Keep it private —
  anyone with the link can open the presenter display.

New events are created as **drafts**, so nothing is public until you make the
event live.

### Moderation mode: pre vs post

The moderation mode controls what happens to a question the moment it is
submitted:

- **Pre-moderation (approve before showing)** — new questions arrive as
  `pending` and are invisible to the audience and the presenter until you
  approve them. This is the default and is recommended for higher-stakes
  sessions (it is the default for the MSS AI Demo Day event).
- **Post-moderation (show, then remove if needed)** — new questions arrive
  already `approved` and are visible immediately; you can still hide anything
  inappropriate afterwards.

### Word-cloud stop words

Each event carries an optional **stop-word / exclusion list**. Any term that
matches the list (after the same normalisation applied to responses) is removed
before the word cloud is rendered, so noise or unwanted terms never appear.

### Logo / brand

An event may carry an optional logo asset (up to 2 MB) and a brand colour used
in the audience and presenter views.

> **Note.** For Milestone 1 the editor focuses on the create flow; editing an
> existing event is limited until the event-update capability is enabled. Set
> the fields you need at creation time.

---

## Event status lifecycle

Every event is in exactly one status. Transitions are driven from the admin
status control, which only ever offers the **allowed** next step (so you cannot
mis-click an illegal transition), and shows the current status as text:

| Status     | What it means                           | Participants can…                          | Action offered |
| ---------- | --------------------------------------- | ------------------------------------------ | -------------- |
| `draft`    | Created but not yet public              | Nothing — the event is admin-only          | **Go live**    |
| `live`     | Open for participation                  | Join, ask, vote, respond to polls / clouds | **End event**  |
| `ended`    | Closed; data retained                   | Nothing — submissions are closed           | **Archive**    |
| `archived` | Terminal; kept for reporting, read-only | Nothing                                    | (none)         |

Guidance on when to transition:

1. **`draft` → `live` ("Go live").** Do this when you are ready to open
   participation — typically as the session starts. Once live, the audience link,
   QR code, and event code resolve to a participating view.
2. **`live` → `ended` ("End event").** Do this to stop the session. Question
   submission, voting, poll responses, and word-cloud responses all close.
3. **`ended` → `archived` ("Archive").** Do this to lock the event for reporting.
   Archived events and all their data are retained but can no longer be modified.

**Archived is terminal.** Archived events cannot be reactivated in V1; the
control states this and offers no further actions.

---

## Running the moderation queue

Open the moderation queue at `/admin/events/:id/moderation`. It lists **every**
question for the event — including `pending` and `hidden` rows the audience never
sees — read through your authenticated admin session. Participant identifiers are
never shown.

### Filters

Narrow the queue with three combinable filters (all selected criteria are
AND-combined):

- **Status** — All statuses, or one of Pending / Approved / Featured / Answered /
  Hidden.
- **AI category** — All categories, or one of the AI categories present in the
  queue (only populated after you run categorisation; see
  [AI features](#ai-features-optional)).
- **Search text** — case-insensitive match against the question text.

An empty result shows either "No questions match the current filters" or "No
questions have been submitted for this event yet".

### Actions and their effect

Each question row shows its current status, any AI category, its vote count, the
question text, and four action buttons. The action that would be a no-op for the
current status is disabled.

| Action            | New status | Effect on audience / presenter                                          |
| ----------------- | ---------- | ----------------------------------------------------------------------- |
| **Approve**       | `approved` | Becomes visible to the audience and eligible for voting/presenter       |
| **Feature**       | `featured` | Visible and eligible to be highlighted in the presenter's featured view |
| **Mark answered** | `answered` | Recorded as answered (removed from the audience's open list)            |
| **Hide**          | `hidden`   | Removed from the audience view, the presenter view, and voting          |

Only questions with status `approved` or `featured` are shown to the audience.
`pending` and `hidden` questions are excluded from both the audience and
presenter views. In **pre-moderation** you must approve a question before anyone
sees it; in **post-moderation** questions arrive approved and you use **Hide** to
remove anything unsuitable.

---

## Presenter view and modes

The presenter view lives at `/present/:eventRef` and is opened with the presenter
token (or an admin session). It is a full-screen, projector-optimised display
that shows **only** the content you select as moderator. When you change the
active mode, the presenter screen updates live (within a couple of seconds),
without a manual refresh. If the live connection drops, the presenter keeps the
last content and shows an interruption indicator.

The presenter supports exactly these modes:

| Mode                                        | Presenter shows                                             | Use it to…                                       |
| ------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| **Join** (`join`)                           | The QR code and event code that resolve to the audience URL | Let people scan in at the start                  |
| **Featured question** (`featured_question`) | The single featured question                                | Spotlight one question you are about to address  |
| **Top questions** (`top_questions`)         | The highest-voted approved/featured questions               | Show what the room most wants answered           |
| **Poll results** (`poll_results`)           | The active poll's question and live results                 | Run and reveal a poll on the big screen          |
| **Word cloud** (`word_cloud`)               | The aggregated, sized word cloud                            | Visualise sentiment on a prompt                  |
| **AI themes** (`ai_themes`)                 | The AI theme-insights panel (when available)                | Surface audience themes (requires AI configured) |
| **Waiting** (`waiting`)                     | A neutral "please wait" holding screen                      | Between segments, or before going live           |

Pending and hidden questions and hidden word-cloud entries never appear in any
presenter mode.

**Choosing a mode:** use _Featured question_ when you are answering one specific
question, _Top questions_ to let vote counts drive the agenda, _Poll results_
while a poll is open (or to reveal a closed poll), _Word cloud_ during a
word-cloud prompt, and _AI themes_ to summarise recurring topics when AI is set
up. Fall back to _Waiting_ whenever you want the screen parked.

---

## Polls

Create polls from the poll editor for the event. When creating a poll you set:

- A **poll question** (1 to 200 characters).
- Between **2 and 10 options**, each 1 to 100 characters.
- A **display order**.
- A **results visibility** setting (see below).

Polls are single-choice only in V1. A poll starts as `draft`.

### Opening a poll

Opening a poll moves it to `open`. **At most one poll per event can be open at a
time** — if another poll is already open, the request is rejected and both polls
keep their current status. Close the open poll first.

While a poll is open, each participant may submit exactly one response, and may
change it — the latest choice replaces the previous one.

### Results visibility

- **Show always (`show_always`)** — the audience and presenter see the live
  tallies while the poll is open.
- **Hide until closed (`hide_until_closed`)** — results are withheld from the
  audience and presenter until you close the poll. Participants still see the
  options and can respond; only the tallies are hidden.

When results are visible, they update live for connected clients.

### Closing a poll

Closing a poll moves it to `closed` and stops accepting responses. A closed
`hide_until_closed` poll then reveals its final results.

---

## Word cloud

Create word-cloud prompts from the word-cloud editor for the event. When creating
a prompt you set:

- **Prompt text** (1 to 200 characters).
- **Maximum words per response** (1 to 10).
- Whether **results are visible while collecting**.

A prompt starts as `draft`.

### Opening a prompt

Opening a prompt moves it to `open`. **At most one prompt per event can be open at
a time** — trying to open a second while one is already open is rejected and both
keep their status. While open, each participant may submit one response (1 to 50
characters) and update it any number of times.

### Normalisation, aggregation, and hiding entries

- Responses are **normalised** before counting: lower-cased, trimmed, and each run
  of internal whitespace collapsed to a single space.
- Identical normalised terms are **aggregated** into one term, sized so that more
  frequent terms render larger.
- Any configured **stop words** are removed before rendering.
- You can **hide an individual entry**; hidden entries are excluded from the
  audience view, the presenter view, and all frequency aggregation.

If "results visible while collecting" is on, the cloud updates live while the
prompt is open; otherwise the final cloud appears once the prompt is closed.

### Closing a prompt

Closing a prompt moves it to `closed` and stops accepting responses.

---

## AI features (optional)

AI features are **optional**. The entire core event flow — Q&A, moderation,
voting, polls, word clouds, presenter control, analytics, and CSV export — works
fully with no AI configured. AI is set up once, globally, on the **AI settings**
screen (`/admin/ai-settings`); see the deployment and rollback documentation for
provider configuration and credential handling. AI must be enabled and configured
there before any of the actions below will run.

When AI is available you can:

- **Categorise questions** — from the moderation queue, the **Categorise
  questions** action tags questions with an AI category, after which the queue's
  **AI category** filter becomes useful. You can override any question's category
  per row.
- **Cluster questions** — group semantically similar approved questions into an
  additive layer. Clustering never edits or deletes the original questions.
- **Theme insights** — surface recurring audience themes, shown in the presenter
  **AI themes** mode.
- **End-of-event summary** — from `/admin/events/:id/summary`, **Generate
  summary** produces a Markdown report. The report always contains a **Calculated
  Data** section computed directly from the database, plus a separate **AI
  Interpretation** section produced only when AI is available.

**Graceful degradation.** If AI is disabled, not configured, or the provider is
unavailable, these actions return a clear "AI unavailable" notice and the rest of
the app is unaffected. The end-of-event summary still produces its calculated
data and shows an "AI interpretation unavailable" banner in place of the AI
section.

**Advisory and inert.** AI output is advisory. AI-produced text (including the
summary) is displayed as plain text and is never executed or rendered as HTML.
Before any AI operation runs, the relevant event text (question text and
aggregate metadata — never participant identifiers) is sent to the configured
provider; only enable AI for endpoints you trust with this data.

---

## Exports

Export results from the export panel for the event (`/admin/events/:id/export`).
Four exports are available:

- **Questions CSV** — one row per question with its text and vote count.
- **Polls CSV** — one row per poll option with the poll text, option text, and
  response count.
- **Word-cloud CSV** — one row per distinct word with the word and its frequency.
- **End-of-event summary (Markdown)** — the event summary as a Markdown file.

Two things to expect:

- **No personal data.** Exports exclude participant identifiers and any other
  personal information.
- **Empty datasets.** If an event has no data of the requested type, a CSV export
  produces a **header-only** file (columns but no rows) and the Markdown summary
  produces an empty-state file, and you are told no data was available. A failed
  export produces no partial file and reports which export type failed.

You can export at any time, but the natural point is after you **End** the event
so the results are final.

---

## Troubleshooting and tips

- **Participants say they can't join or interact.** Confirm the event is `live` —
  draft, ended, and archived events withhold all participation controls. Check
  they are using the current audience link / QR / event code.
- **A question isn't showing to the audience.** In pre-moderation it stays hidden
  until you **Approve** it. Also check it hasn't been **Hidden**, and clear any
  moderation-queue filters that might be excluding it.
- **"Only one poll may be open per event."** Close the currently open poll before
  opening another. The same one-at-a-time rule applies to word-cloud prompts.
- **Poll results aren't visible.** A `hide_until_closed` poll withholds tallies
  until you close it; switch it to `show_always` or close it to reveal results.
- **A word-cloud term shouldn't be there.** Hide the individual entry, or add the
  term to the event's stop-word list so it is excluded before rendering.
- **The presenter screen didn't update / shows an interruption notice.** It
  retains the last content on a dropped connection and recovers automatically;
  if needed, reselect the mode. Verify the presenter link/token is correct.
- **AI actions show "AI unavailable".** This is expected when AI is disabled, not
  configured, or the provider is unreachable — the core flow keeps working. Check
  the AI settings and the connection test (see the deployment documentation).
- **An export looks empty.** A header-only CSV means there was no data of that
  type yet — run the export again after participation has occurred.
- **Keep the presenter link private.** It grants presenter access; share only the
  audience link / QR / event code with attendees.
