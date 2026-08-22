# Engineering Activity Tracker

Shared daily tracking for engineering jobs across eight registers, with the team's
Excel workbooks as the way data goes in and comes out.

Everyone opens the **same URL** and sees the **same live data**. When someone
uploads a sheet or edits a job, it is there for the rest of the team on their next
refresh — no emailing workbooks around to find out which copy is current.

---

## What it tracks

| Register | What it holds | Due date comes from |
|---|---|---|
| Action Notice | Action notices raised on plant equipment | ETC |
| IWS | Inspection work scopes | Target Date |
| PZV | Safety-valve calibration and overhaul | Due Date |
| EIS | Equipment inspection strategy (vessels, tanks) | Next Inspection |
| Routine Inspection | Recurring routines by interval | Next Inspec Date |
| CTS Recommendation | Recommendations from CTS investigations | ETC |
| PDM | Predictive maintenance findings (VA, OA) | Target Date |
| QC Report | Quality audits of completed work orders | — (see below) |

Each register keeps **its own columns** — an IWS row really is not a PDM row, and
flattening them would lose the Notification and WO numbers, the calibration dates
and the vibration findings that make each sheet worth keeping.

What makes one dashboard possible is that every register declares which of its own
columns answers each shared question: *what is this, who owns it, when is it due,
how urgent is it.* That mapping lives in one place —
[`src/registers.js`](src/registers.js) — and adding a ninth register is a change
to that file and nothing else.

---

## The dashboard

- **Total Jobs · Open · Closed · Due in 30 days · Completed · Overdue** across
  every register the reader may open.
- **A ring per register** — overdue, due within 30 days, open, closed — summing to
  that register's total, with all four printed beside it.
- **Needs attention** — everything overdue or due inside a month, soonest first.
- **Recent changes** — who changed what, and when.

**The department as a landscape** — a column per register on a floor you can
turn, stacked by state: closed at the base, then open, then due within the
month, with the overdue work crowning it. Drag to look around, point at a column
for its exact figures, click it to open that register.

Drawn on a canvas with a hand-rolled projection rather than a 3D library: there
is no build step, and it has to keep working inside the single-file offline
build, where a CDN script would not be there. Three things in it are less
obvious than they look:

- **Height follows the square root of the total.** Linearly, a register holding
  eight hundred audits makes one holding six notices a smear on the floor — and
  those six are the ones somebody has to act on. Within a column the bands stay
  strictly proportional to each other.
- **A band that exists is never invisible.** One overdue job among a hundred and
  twenty-six is a hairline nobody sees, and that one job is the whole reason to
  look; any band holding something gets a floor of a few percent, taken pro rata
  from the bands with room to give. A band holding *nothing* stays absent — four
  colours on a register that is only in one state would be a picture of
  something untrue. The readout gives the real numbers.
- **Shortest at the front, rows laid like brickwork.** On a square grid a back
  column sits directly behind a front one and its lower bands — Closed first,
  being at the base — disappear entirely. Sorting by size and offsetting
  alternate rows by half a cell means every column shows through the gap between
  the two in front of it.
- **Faces are shaded against a fixed light**, so turning the floor changes them.
  Tinting by which axis a face lay on is enough to read a box as solid but stays
  put as the scene turns, which made the columns look like flat cut-outs
  rotating.
- **Name pills lift to clear each other**, with a hairline back to their column.
  Short registers sit close together and their labels landed on top of one
  another.
- **The animation runs only while it is spinning.** A loop left running to poll
  a flag wakes the browser sixty times a second to decide to do nothing, which
  on a phone is battery spent on a still picture.

Priority, status, action owner, initiator and due window are all filterable inside
each register, and the table sorts on any column.

**Enter saves** in the entry drawer, as it does on the sign-in form — except in a
description or remarks box, where Enter is a new line, and on a date field, where
the browser's own picker uses it to accept a date.

---

## The duty rota

**Duty rota** in the sidebar shares the safety duties out across the team, in
place of the spreadsheet that was being juggled by hand. It covers the three
rotas the team keeps:

| Rota | What it covers |
| --- | --- |
| **Safety KPI** | Each week, every task (WPA, UCO, BOP, SM) filled to its target in both SHP and DCU |
| **Internal walkthrough** | Two people per area, every Monday |
| **Weekend coverage** | One person on each Saturday |

The band at the top always answers **who is on this week**, on whichever tab is
open. **By person** gives one person's duties week by week, ready to copy and
send to them.

### How the fill decides

Every slot goes to whoever is carrying the least work at that moment. Ties break
by who went longest without a turn, then by position on the team list, so the
result is deterministic — pressing Fill twice does not reshuffle the team, which
is what makes a printed copy worth trusting. Two rules are always enforced:

- nobody covers both areas of the same task in one week;
- nobody does two walkthroughs on the same date.

Weekend cover is a strict rotation: nobody takes a second Saturday until
everybody has taken a first.

### Overriding it

Click a KPI cell to move a name in or out; on the walkthrough and weekend tabs,
pick a different name from the list. An edited group is marked and the next fill
works around it — still counting that person's load, so the rest of the rota
adjusts rather than handing them a double week. **Clear edits** releases them.

Untick **Available** on the Team tab for somebody on leave and the next fill
skips them. Their existing duties stay put, so it is visible what needs handing
over. **Workload balance** shows how evenly the window has come out.

Editing needs an editor or admin account; a viewer sees the rota read-only. The
whole rota is one shared document — everyone sees the same one, and a save from a
page that has gone stale is refused rather than overwriting a colleague's change.

---

## Document numbers

Action Notices are numbered by the app: **`PA-2608-01`** — `PA`, the two-digit
year, the two-digit month, then a serial that **restarts at 01 each month**.

Opening a new entry fills the field in. It is still a normal field: type over it
and the app uses what you wrote, which is what carrying a number over from
another series requires. Imported rows keep whatever numbers the sheet already
carries; only entries created by hand are numbered.

Two details that are not obvious and both matter:

**The number shown is a preview, not a reservation.** It is issued for real when
Save is pressed. Opening the form and thinking better of it therefore consumes
nothing and leaves no gap in the sequence.

**The server allocates it, never the browser.** "Read the highest, add one,
insert" is a race, and it is not theoretical: with a database round trip between
the read and the insert, ten notices saved at the same moment all came back as
`PA-2608-01`. Allocations are chained so the next read happens after the previous
insert has landed. This holds because the app runs as a single process — if it is
ever scaled past one instance, this needs a unique index and a retry instead, and
a promise chain cannot see across processes.

The next serial is the highest issued this month plus one, never the count of
records: counting would reissue a number as soon as an entry was deleted, and
these appear on paperwork that has already left the building. Past 99 the number
simply gets longer.

Adding this to another register is two lines — an `autoNumber: { field, prefix }`
on it in [`src/registers.js`](src/registers.js).

---

## Excel import

Upload a workbook and **every sheet becomes its own choice**. For each one you pick
the register it belongs to and whether to *replace* that register or *add* to it.

The reader is built around the team's real files rather than an idealised table:

- **The header row is found, not assumed.** Row 1 in these files is a merged banner
  (`Solid Handling Plant's IWS Track`), so the header is on row 2 — and it is
  located by matching column names, not by counting rows.
- **Columns are found by position.** `Routine Inspection` starts in column B.
- **Spelling drift is expected.** `Action By ` with a trailing space, `Refrence`,
  `Plan date for callibration` — matching ignores case, spacing and punctuation, and
  each field carries the spellings seen in the real workbooks.
- **Blank rows stay blank.** The Action Notice sheet carries pre-numbered empty rows
  20–31 waiting for next month; a serial number alone never makes a job.
- **Unknown columns are kept**, not dropped, and are editable in the app.
- **Phrases in date columns survive.** `Next Shutdown` and `SEP` are real, deliberate
  entries. They are kept and shown; the job simply has no calendar date behind it.
  In the form a due date is a date picker, with an **Enter text instead** switch
  beside it for those phrases — and a row that already holds one opens as a text
  box, so editing it cannot silently discard what it says. `Next Inspec Date` on
  Routine Inspection stays a plain text box: every value in that column is a
  month name, so a picker there would be the wrong default.
- **Impossible dates are refused.** The EIS sheet holds several `1935-03-25` values
  where a five-year addition wrapped. Accepting them would park permanently overdue
  rows at the top of every dashboard, so they are kept as text and left undated.

Sheet names alone never decide a register — three of the uploaded workbooks contain
a sheet called `Sheet1`. Columns decide; the name only breaks a tie.

### QC is shaped differently, and it matters

The other seven registers track work that is *going to* happen, so each has a
target date. A QC row records an audit that has **already** happened, and the
workbook has no due-date column at all.

So QC rows never appear in Overdue, in Due-in-30-days, or in a reminder email.
They are counted as undated, which is the honest answer — deriving a due date
from the audit date would park hundreds of permanently overdue rows at the top of
every dashboard and in everybody's inbox. The `Target Date` and `Action By`
fields are declared anyway: the day those columns are added to the sheet, QC
joins the overdue counts and the reminders with no change to the code.

Three things about that sheet were worth handling explicitly:

- **The status column holds sentences, not statuses.** Sixteen distinct values
  across 850 rows — `Found normal`, `To be attend`, `REQUESTED FOR THE
  MATERIALS`, and `job completed` in six capitalisations. None matches a known
  status word, so all 850 would have defaulted to *Not Started* and the register
  would have read as 850 jobs nobody had begun. Phrases are matched when the
  whole cell is not a known word, testing "still outstanding" before "finished"
  — a sentence can hold both, and reading `TO BE DONE` as done is the more
  expensive mistake. The seven registers that do use a proper vocabulary are
  matched exactly and never reach it.
- **`Quality Overall %` is an Excel percentage**, so 90% is stored as `0.9`.
  Anything at or below 1 is scaled to a whole percent; anything above is taken as
  already being one, so a sheet holding a plain `90` reads correctly too.
- **A running total sat below the data** — one lone `0.89` and three
  `SUM`/`AVERAGE` formulas, the last at row 1,048,568. Each satisfied "some field
  is filled" and would have imported as an audit with no work order and no
  findings. A number alone no longer makes a record; something has to name it.

`Finding Classification` is the only urgency signal the sheet carries —
`Execution` means the audit found work to do — so it fills the priority role. The
table shows the derived priority with the sheet's own word beneath it, rather
than replacing `Execution` with `High`.

## Excel export

**Export all** produces one workbook: a Summary sheet plus one sheet per register,
laid out like the Engineering Master file it replaces — the two logos across the
banner row with the title centred between them, then a pale header, black text, a
thin border on every cell, and no row colours.

The right-hand logo is anchored to the right edge of each sheet's own table
rather than to a fixed column: every register has a different number of columns
and different widths, so a fixed index lands mid-table on the wide ones and off
the end of the narrow ones.

**Columns are sized to what is in them**, and the sheet arrives ready to print:
landscape, scaled to one page wide, running to as many pages down as the rows
need, with the banner and headings repeated at the top of each. Fixed widths
meant Priority, Status and Remarks took their full allowance while sitting empty
and Description — the column people actually read — was cramped into two wrapped
lines beside them, and the total came to more than a page, so printing began with
dragging every column by hand.

Each sheet is headed **`Engineering <register>`** — a document title, since the
file goes out to other departments. It was the register's name followed by its
description, which read as a tooltip that had escaped onto a form; the
description belongs on the register page in the app. A register can name its own
heading with `exportTitle` if the default does not suit.

**Dates are written as dates**, not as the text they happened to be stored as.
The same ETC column held `16/08/2026`, `25-08-2026` and `2026-09-03` at once —
imported rows kept the spelling their own sheet used, typed ones were ISO — so
the column could not be read at a glance, sorted, or filtered by date. Every date
column now carries a real Excel date shown as `mm/dd/yyyy`, set in one place in
[`src/excel.js`](src/excel.js); the printed report and the reminder emails share
one formatter with it, so the three cannot drift apart.

Worth knowing: the workbooks this replaces were written day/month/year
(`16/08/2026` meaning 16 August), and the two conventions disagree for any day up
to the twelfth. Changing `DATE_FORMAT` to `dd/mm/yyyy` switches back.

A phrase is not a date and is left exactly as written — `Next sulfur Shutdown`
stays text, with no date format on it, since one would render it blank.

An empty column is sized to its own heading and no more. When a register is still
too wide, its wrapping columns give way first, down to a floor: a description
reflows onto another line, whereas a date or a tag would simply be cut off. That
is a mitigation rather than a cure — QC has seventeen columns including two
long-text ones, and no amount of reflowing makes that a comfortable single page;
it prints at about half size, which is honest.

The sheet carries the register's own columns and nothing else. `Tracker Priority`,
`Tracker Status`, `Tracker Due Date`, `Due State`, `Last Updated` and `Updated By`
used to be appended and were removed at the team's request: an export is a
document they forward to other people, and it should carry their columns rather
than the app's bookkeeping, most of which restated a column already there.
`Days To Due` is kept, being the one that answers something the sheet cannot.

Overdue rows were tinted red and due-soon amber for the same reason and are now
plain. The dashboard, the PDF report and the reminder emails all still say what
is late.

Exports **re-import cleanly** — download the master file, edit it offline, upload it
back. All seven of those headers are still ignored on the way in, so a workbook
exported before this change does not turn its old columns into data.

**Blank template** gives an empty workbook with the right headers for one register —
the quickest way to start one from scratch.

---

## The PDF report

**↓ PDF report** on the dashboard produces *Engineering Department Updates* — a
landscape A4 sheet with the six headline figures, each register's position, and
everything overdue or due inside the month. It is built from the same
`summarise()` output the dashboard reads, so the sheet somebody takes into a
meeting and the screen somebody is looking at cannot disagree.

**Two logos**, uploaded once under **Settings → Logos**: the contractor's mark at
the left, the client's at the right, with the heading between them — the
arrangement the team's own workbooks use. They appear on the PDF report and in
the banner row of every Excel export.

They are uploaded rather than shipped with the app. Nobody's trademark belongs in
somebody else's source tree; the file is then whatever the brand team actually
issued rather than something redrawn from a screenshot; and the next site to use
this supplies its own two without a code change. Each is stored as a data URI, so
a report needs nothing from the network to print, and each is embedded once per
workbook however many sheets it has.

A restricted account's report covers only its own registers and says so on the
page — otherwise a partial view reads as the whole department's position.

The standard 14 PDF fonts are used, so no font binary ships with the app. They
are WinAnsi-encoded, which is worth knowing before adding a character to the
report: one outside that encoding does not fail, it silently prints as something
else. `Due ≤30d` came out as `Due "d30d`.

The offline single-file build has no server to render a PDF, so its button opens
the browser's own print dialogue — "Save as PDF" there produces the same content
from the page.

---

## Daily email reminders

Every morning each person is emailed the jobs that need them, and nobody has to
open the dashboard to find out that something is late.

**The rule the team asked for**, and what it means in practice:

| Band | Reminded |
|---|---|
| Overdue | Every day |
| Due within 15 days | Every day |
| Due in 16–30 days | Once a week, on Sunday |
| Beyond 30 days, or no date set | Not at all |

The middle band is the whole point of the design. Emailing everything inside a
month every morning would mean the same twenty rows arriving daily for three
weeks, and a message that always says the same thing stops being read — taking
the genuinely urgent ones with it. All four thresholds are configurable under
**Settings → Daily email reminders**.

**Each person's digest is their own.** An account limited to IWS is reminded
about IWS; the same allow-list that hides PDM in the app keeps PDM out of their
inbox, or the email would be a way around a permission enforced everywhere else.
Their own rows lead the message, matched from the free-text `Action By` column
against their account name, and the rest of the department's position follows —
a digest showing only your own work hides the fact that the register you share
is on fire.

Nobody is emailed when they have nothing due.

### Connecting a mail account

Credentials live in the environment, never in the database — a mail password in
a table leaves in a database backup, and that table sits beside the team's
records. Settings can see *whether* mail works and say what is missing; it can
never show or set the password.

Set `TRACKER_MAIL_FROM` and one transport:

| Transport | Variables | Worth knowing |
|---|---|---|
| **Microsoft Graph** | `TRACKER_GRAPH_TENANT_ID`, `TRACKER_GRAPH_CLIENT_ID`, `TRACKER_GRAPH_CLIENT_SECRET` | For a company Microsoft 365 / Outlook mailbox — see below |
| **SMTP** | `TRACKER_SMTP_HOST`, `TRACKER_SMTP_PORT`, `TRACKER_SMTP_USER`, `TRACKER_SMTP_PASSWORD` | Gmail works with an **app password**, not the account password. Port 587, or 465 for implicit TLS |
| **Brevo** | `TRACKER_BREVO_API_KEY` | 300 a day free, and a sender verified by clicking a link — no domain needed |
| **Resend** | `TRACKER_RESEND_API_KEY` | Wants a verified domain before it will send to anyone but you |

The transport is detected from whichever key is present; `TRACKER_MAIL_PROVIDER`
overrides that if two are set.

### A company Outlook mailbox

Reach for Graph rather than SMTP. Microsoft has been retiring Basic
authentication for SMTP in Exchange Online; SMTP AUTH is disabled per-mailbox by
default and has to be turned on deliberately; and Microsoft 365 has no
app-password equivalent, so a mailbox with MFA generally cannot authenticate over
SMTP at all. Graph is the supported route and does not stop working when that
retirement completes.

Trying SMTP first is still worth five minutes, because it costs nothing to find
out. Point `TRACKER_SMTP_HOST` at `smtp.office365.com` on port 587 and press
**Send a test to me**: if the tenant allows it, it simply works. If it does not,
Exchange answers `535 5.7.139 Authentication unsuccessful, the request did not
meet the criteria to be authenticated successfully` — the same sentence for a
wrong password, a mailbox with SMTP AUTH off, and a tenant blocking Basic auth,
so the app prints what that actually means alongside it.

It needs an app registration in Entra ID, which usually means asking IT:

1. **Entra ID → App registrations → New registration.** Single tenant. No
   redirect URI — this app never signs a person in.
2. **Certificates & secrets → New client secret.** Copy the *Value* immediately;
   it is not shown again.
3. **API permissions → Microsoft Graph → Application permissions → `Mail.Send`**,
   then **Grant admin consent**. Application, not Delegated: the app signs in as
   itself, so there is no password to rotate when somebody leaves and no mailbox
   that stops sending when their account is disabled.
4. **Scope it to one mailbox.** `Mail.Send` as an application permission is
   tenant-wide by default — it would let this app send as anybody in the company.
   An application access policy restricts it to the one mailbox:

   ```powershell
   New-ApplicationAccessPolicy -AppId <client-id> `
     -PolicyScopeGroupId engineering@company.com `
     -AccessRight RestrictAccess `
     -Description "Engineering tracker reminders"
   ```

   Asking for this up front is usually the difference between the request being
   approved and being refused.

Then set `TRACKER_MAIL_FROM` to that mailbox — Graph names it in the request
path, so it has to be a real mailbox rather than any valid address.

Graph's JSON message object carries a single body, which would drop the
plain-text alternative every other transport keeps, so the assembled MIME message
is posted instead. Whatever Entra says when it refuses a sign-in is passed
through unchanged: an expired secret and a wrong tenant ID are indistinguishable
once flattened into "login failed".

### The schedule

`POST /api/reminders/run` sends the day's digests. It takes the shared secret in
an `x-reminder-secret` header, or an admin session with a recent password
confirmation. With `TRACKER_REMINDER_SECRET` unset the endpoint stays closed to
unauthenticated callers rather than defaulting to open.

**The schedule cannot live inside the app.** A free instance sleeps after fifteen
minutes idle, so a timer in the process would not be running at seven in the
morning — and the first request of the day is what wakes it.
[`.github/workflows/tracker-reminders.yml`](../../.github/workflows/tracker-reminders.yml)
is that request: a free GitHub Actions cron that wakes the service, waits for it,
and then triggers the run. It needs two repository secrets, `TRACKER_URL` and
`TRACKER_REMINDER_SECRET`.

A run refuses to repeat on a date it has already sent, so a cron that
double-fires cannot send the team the same digest twice. **Send now** in Settings
overrides that, because that is what pressing it means.

Set `TZ` on the host to the plant's timezone. "Due today" is otherwise today in
UTC, and a run just after local midnight would work from yesterday's date.

The offline single-file build has no server and no accounts, so it has no
reminders either — there is nobody to remind and nothing running to do it.

---

## Running it

```bash
pnpm install
pnpm --filter @intoto/tracker dev      # http://localhost:4100
```

With no `DATABASE_URL`, data goes to `apps/tracker/data/tracker.json` — good for
trying it out on one machine, and gitignored. Point `DATABASE_URL` at Postgres and
it uses that instead; the tables are created on boot.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4100` | Port to listen on |
| `DATABASE_URL` | — | Postgres connection string. Unset → local JSON file |
| `DATABASE_SSL` | — | `no-verify` for managed Postgres (Neon, Supabase, Render external); `disable` to force plain TCP |
| `TRACKER_ACCESS_CODE` | — | Authorises creating the first admin account, and gates the app until one exists |
| `TRACKER_SESSION_SECRET` | generated | Signs session tokens. Generated once and stored if unset |
| `TRACKER_ADMIN_EMAIL` · `TRACKER_ADMIN_PASSWORD` · `TRACKER_ADMIN_NAME` | — | Create the first admin on boot instead of through the setup screen |
| `TRACKER_DATA_FILE` | `data/tracker.json` | Where the JSON store lives |
| `TZ` | host default | The plant's timezone, so "due today" means today locally |
| `TRACKER_REMINDER_SECRET` | — | Lets the scheduler trigger a reminder run. Unset → no schedule |
| `TRACKER_MAIL_FROM` · `TRACKER_GRAPH_*` · `TRACKER_SMTP_*` · `TRACKER_BREVO_API_KEY` · `TRACKER_RESEND_API_KEY` | — | Reminder email — see above |

```bash
pnpm --filter @intoto/tracker test     # 80 tests, no database needed
```

---

## Deploying it

The blueprint in [`render.yaml`](../../render.yaml) defines an `intoto-tracker`
service. It shares the existing free Postgres instance but keeps its tables in a
separate `tracker` schema, so the ERP's `prisma db push` — which drops tables in
`public` it does not know about — cannot reach them.

There is no build step: the tracker is plain JavaScript on both sides, so a deploy
is an install and a start.

Two things worth knowing about Render's free tier before the team relies on it:
services sleep after 15 minutes idle and take about 50 seconds to wake, and **the
free database is deleted after 30 days**. Before this holds work you cannot lose,
move to a paid database or to Neon's free tier, which persists.

### The cold start

A sleeping service shows Render's own "service waking up" screen for about fifty
seconds — served before this app is running, so it cannot be styled or skipped
from here. Any inbound request resets the idle timer, so
[`.github/workflows/tracker-keep-awake.yml`](../../.github/workflows/tracker-keep-awake.yml)
pings `/api/health` every five minutes, Sunday to Thursday, 05:00–17:55 local.
Nobody on the plant meets the screen during the working day.

It stops outside those hours on purpose. Render's free tier allows 750
instance-hours a month per workspace; awake around the clock is about 730 of
them, which would spend the entire allowance and starve any other service
sharing it. The working-hours window is roughly 280.

Five minutes rather than ten because GitHub's scheduled runs are best effort and
often late — at a ten minute interval one delayed run is enough to let the
service sleep. A failed ping logs a warning rather than failing the job: it runs
150 times a week, and a red cross every time Render blips would train everyone to
ignore the Actions tab, including when the reminder job fails.

This is a workaround for a free plan, not a fix. Render's paid instance never
sleeps, and the workflow can be deleted the day you move to one.

---

## Accounts and permissions

Everyone signs in with their own email and password. Passwords are hashed with
scrypt, so the database holds no readable password even if it leaks, and sessions
are signed tokens that survive the free tier's frequent restarts.

**Setting it up.** The first person to open a fresh deployment is asked to create
the administrator account, and must supply `TRACKER_ACCESS_CODE` to do it — so
somebody who merely finds the URL first cannot claim it. Alternatively, set
`TRACKER_ADMIN_EMAIL` and `TRACKER_ADMIN_PASSWORD` and the account is created on
first boot.

**Three roles**, set per person under **Settings**:

| Role | Can |
|---|---|
| Viewer | Read every permitted register and export to Excel. Nothing else. |
| Editor | Add, edit, delete and import. |
| Admin | Everything, plus managing accounts and permissions. |

**Plus a register list.** Independently of the role, an account can be limited to
particular registers — an editor restricted to IWS cannot open PDM, cannot import
into it, and does not see it on the dashboard or in an export. The two are
separate because they answer different questions: the role is *what kind of thing*
someone may do, the register list is *where*. Folding them together would mean
inventing a role per combination.

Restrictions are enforced on the server, not by hiding buttons. Hidden buttons are
for clarity; the API refuses the request either way, and the tests check the
refusals rather than the hiding.

**Opening Settings asks for the password again**, even for an admin who is already
signed in — an admin who steps away from an unlocked browser would otherwise be
leaving the team's permissions open to whoever sits down next. The confirmation
lasts fifteen minutes and is held in memory only, so closing the tab ends it. A
session token cannot be replayed as a confirmation; the two are signed for
different purposes.

An admin cannot demote or switch off the last remaining admin — it is the one
change that could not be undone from inside the app.

The offline single-file build has no accounts at all. The file *is* the
permission: whoever can open it can already read and change everything in it, so
a login there would be theatre. It asks for a name, for the audit trail.

## How it is built

Plain ES modules, no build step and no framework, on both sides. The file in the
repository is the file that runs: open `public/app.js`, change it, reload.

```
src/registers.js   the eight registers, and how each maps onto the shared shape
src/excel.js       reading real workbooks; writing ones that read back in
src/store.js       Postgres or a JSON file, behind one interface
src/server.js      the API and the static app, one process
public/            the browser app — app.js, styles.css, index.html
src/auth.js        passwords, sessions, roles and register permissions
src/report.js      the printable Engineering Department Updates sheet
src/autonumber.js  the PA-YYMM-NN rule for Action Notice document numbers
src/reminders.js   who is reminded about what, and the digest they receive
src/mailer.js      Microsoft Graph, SMTP, Brevo or Resend behind one send()
test/              80 tests over the parts that would fail silently
```

The browser never carries its own copy of the register definitions — it reads them
from `/api/config`, so the columns, their labels and their types have exactly one
source of truth.
