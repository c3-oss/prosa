# Screens: prosa-panel

Screen-by-screen specification. Each section describes layout, blocks,
data shown, states, behavior, and keyboard shortcuts. For reusable
components see [components.md](components.md). For the overall direction
see the [design brief](design-brief.md).

---

## Global structure

All authenticated pages share:

```
+----------------------------------------------------------+
| Topbar (56 px)                                           |
|  prosa                              [12 today] [logout]  |
+-----------+----------------------------------------------+
| Sidebar   | Main                                         |
| (220 px)  |                                              |
|           |                                              |
|  Home     |                                              |
|  Insights |                                              |
|  Sessions |     (content)                                |
|  Projects |                                              |
|  Profiles |                                              |
|  Devices  |                                              |
|  Settings |                                              |
+-----------+----------------------------------------------+
```

When the session sidepanel is open it enters from the right, taking
~44% of the main area's width:

```
+-----------+--------------------+-------------------------+
| Sidebar   | Main (partial)     | Session sidepanel       |
+-----------+--------------------+-------------------------+
```

The sidebar is seven entries: **Home**, **Insights**, **Sessions**,
**Projects**, **Profiles**, **Devices**, **Settings**. Analytics
content lives in the Home, Insights, and Profiles dashboard cards and
the Sessions list; there is no separate Analytics group.

Topbar and sidebar use `--bg-elev-1`. Main uses `--bg`. Region dividers
are 1 px `--divider`. The topbar carries the brand, the "new sessions"
badge (links to `/sessions?last=12h`), and the logout form.

Global shortcuts:

- `/` navigates to `/sessions` and focuses its search input;
- `Cmd-K` / `Ctrl-K` opens the command palette;
- `Esc` closes the sidepanel or the command palette;
- `j` / `k` moves the selection in lists;
- `Enter` opens the current selection.

---

## Home `/`

Default page after login. Dashboard composed of cards drawn from the
analytics service. Top to bottom: filters (collapsed), KPI strip,
heatmap card, activity trend card, then two-column rows of cards.

### Filters

A single `<details>` block sits at the top of the page so it doesn't
crowd the dashboard.

```
▸ filters
```

When open it reveals five controls:

- **Window** (single-select): `12h`, `7d`, `30d`, `1y`, `all`. The
  default comes from Settings and starts at `30d`.
- **Agent** (multi-select dropdown): all known agent names. Multiple
  picks submit as repeated `agent=` query params.
- **Project** (multi-select dropdown): distinct project labels from the
  projects analytics report.
- **Profile** (multi-select dropdown): distinct profile names from the
  profiles analytics report. Profile names are matched across devices.
- **Device** (multi-select dropdown): friendly names from the device
  registry.

The block submits as a plain GET form. The whole page re-renders; no
HTMX. State lives in the URL so bookmarks reproduce the view.

The heatmap card ignores `window` by design; everything else honors it.

### KPI strip

Six KPIs across the top, each in a [`kpi`](components.md#kpi-card) card.
The strip wraps on narrow widths.

```
   12 +20%    3 +50%     2 0%     1.5m +8%  $4.70 -5%   7% -2%
   sessions   projects   models   tokens    est spend   error rate
```

- **Sessions** in window;
- **Projects** active in window (distinct project labels);
- **Models** active in window;
- **Tokens** measured in window;
- **Est. spend** — summed cost of priced models (`n/a` when none priced);
- **Error rate** — flagged sessions ÷ total (heuristic; see Issues).

Each KPI carries a small **delta badge** comparing the selected window
to the immediately-preceding window of equal length (e.g. 30d vs the
30d before). Tone semantics: volume KPIs up = `--ok`, error rate up =
`--danger` (inverted), est. spend is always muted (spending more is
informational, not a regression). `prev == 0 && curr > 0` renders
"new"; both-zero renders no badge. The badges are skipped entirely for
`last=all` (there is no previous "everything").

No sparkline in this cut.

### Heatmap card

Full-width `<section class="card">` with the daily contribution heatmap.

```
Heatmap · trailing 53 weeks

Sun ░ ░ ▒ ▓ ░
Mon ░ ▒ ▓ █ ░
Tue ░ ░ ░ ▒ ▓
...
```

- Fixed trailing 53 weeks; **does not honor the window picker** — call
  this out under the card title so the user is not surprised.
- Scope filters (agent, project, device) still apply.
- Cells are 16 × 16 CSS-grid blocks (not SVG), gap 2 px; color scaled
  from `--accent` against surface tokens.
- Cell hover surfaces a tooltip with date, total count, and per-agent
  breakdown. Cells expose `aria-label="<date>: N sessions"` and stay
  keyboard-focusable.
- Discreet legend in the corner: scale gradient + "less / more".

### Activity trend card

Full-width card under the heatmap: sessions per day in the **filtered**
window as a [stacked-column](components.md#stacked-columns) chart,
one color band per agent (top 4 by volume + "other"), with a
palette-matched legend. Past ~120 days the columns collapse into ISO
weeks ("per week" in the subtitle); `last=all` clamps to the trailing
365 days (subtitle says so). Data: the `heatmap` report re-run with the
filtered window — the 53-week heatmap call above is untouched.

### Cards

Two-column rows under the heatmap, with the full-width Issues section
between the second and third rows.

```
+---------------------+   +---------------------+
| Tools               |   | Models              |
| ▶ bar leaderboard   |   | ▶ bar leaderboard   |
+---------------------+   +---------------------+

+---------------------+   +---------------------+
| Projects            |   | Hour of day         |
| ▶ bar leaderboard   |   | ▶ area chart (SVG)  |
+---------------------+   +---------------------+

+----------------------------------------------+
| Issues                                       |
| flagged · rate · top model                   |
| ▶ errors per model      ▶ recent flagged     |
+----------------------------------------------+

+---------------------+   +---------------------+
| Tokens & cost / model|   | Usage               |
| ▶ donut + bars      |   | ▶ totals + per-agent|
+---------------------+   +---------------------+
```

- **Tools**: HTML bar leaderboard from the `tools` report. No SVG.
- **Models**: HTML bar leaderboard from the `models` report.
- **Projects**: HTML bar leaderboard from the `projects` report,
  aggregated per project (sessions summed across agents), labeled with
  the friendly project display.
- **Hour of day**: an [area chart](components.md#area-chart) from
  the `hours` report. UTC buckets are rotated into the panel's local
  zone for display (whole-hour, DST-naive); the subtitle names the peak
  hour.
- **Issues** (full-width): An error-rate
  indicator, the most error-prone model, an **errors per model** bar
  leaderboard (`errors_by_model`), and a **recent flagged sessions**
  list — each row links to the transcript (agent badge + project +
  timestamp). All from the FTS heuristic
  (`error|exception|traceback|panic|fatal`); labeled as such.
- **Tokens & cost per model**: token bar leaderboard plus a cost-share
  [donut](components.md#donut) with a color-matched legend, from
  `usage_by_model`.
- **Usage**: total tokens + estimated cost, with a per-agent breakdown.

All cards re-render with the rest of the page when the filters form
submits. No HTMX chart-swap pattern here; the dashboard is one GET away
from any state change.

### States

- **No sessions in window**: KPIs show `0`; cards render their own
  empty messages. The heatmap still draws (its window is fixed).
- **Loading**: the server renders with values ready before sending the
  response — no skeleton.

---

## Insights `/insights`

Progression and work-rhythm dashboard. Shares Home's filter chrome
(same drawer, chips, and URL state, posting back to `/insights`) via
the `dashboard_filters.html` partial. Top to bottom: rhythm KPI strip,
spend & tokens card, model share + punch card row, across-the-day
card, durations + fan-out row, delegation card, top delegators +
by-parent-agent row.

```
   4 days     11 days    62% (45/72)  18%       31%        Tuesday
   current    longest    active days  weekend   outside    busiest
   streak     streak                  sessions  09–18h     weekday

+----------------------------------------------+
| Spend & tokens                               |
| ▶ est. spend columns + cumulative line (SVG) |
| ▶ tokens area chart (SVG)                    |
+----------------------------------------------+

+---------------------+   +---------------------+
| Model share         |   | Punch card          |
| ▶ normalized stacks |   | ▶ 7×24 level grid   |
+---------------------+   +---------------------+

+----------------------------------------------+
| Across the day                               |
| ▶ sessions per local hour, stacked by model  |
| ▶ tokens per local hour area chart           |
+----------------------------------------------+

+---------------------+   +---------------------+
| Session duration    |   | Fan-out             |
| ▶ bucket histogram  |   | ▶ bucket histogram  |
+---------------------+   +---------------------+

+----------------------------------------------+
| Delegation                                   |
| ▶ KPI row + delegated-share trend (SVG)      |
+----------------------------------------------+

+---------------------+   +---------------------+
| Top delegating      |   | By parent agent     |
| ▶ linked list       |   | ▶ per-agent table   |
+---------------------+   +---------------------+
```

- **Rhythm KPI strip**: current streak (consecutive active days ending
  today — or yesterday when today is still quiet), longest streak over
  the trailing 53 weeks, % active days in the window, weekend-session
  share, outside-09–18h share, busiest weekday. Streak days are **UTC
  dates** (same caveat as the heatmap: a late-evening local session may
  count toward "tomorrow"). Streaks come from the trailing 53-week
  `heatmap` report; active days from the windowed one; the schedule
  KPIs from the rotated punch card grid, so they agree with what it
  shows.
- **Spend & tokens**: estimated spend per day as a
  [bar chart](components.md#stacked-columns), plus a tokens
  [area chart](components.md#area-chart) on the same buckets. (Frappe
  Charts has no secondary axis, so the running total lives in the card
  subtitle rather than as a cumulative overlay line.) Data: the `usage_by_day` report (per UTC day, per
  model), priced panel-side via `internal/pricing` — rows with no
  measured usage or an unknown model count tokens but no spend, the
  same honesty rule as the Usage card. Past ~120 days, buckets collapse
  into ISO weeks; `last=all` clamps to trailing 365d (subtitle says
  so).
- **Model share**: weekly share of sessions per model as normalized
  stacked columns (top 4 + "other"), with a palette-matched legend —
  model migration reads as share shifts. Same `usage_by_day` rows.
- **Punch card**: 7 weekday rows × 24 local hours from the `punchcard`
  report, colored with the heatmap's level classes. UTC cells are
  rotated into the panel's local zone (whole-hour, DST-naive, weekday
  carry across midnight — same approach as Hour of day). Cell hover
  carries "<weekday> <hour>h: N sessions".
- **Across the day**: sessions per local hour as stacked columns per
  model (top 4 + "other", palette-matched legend) plus a tokens area
  chart on the same 24 slots, from the `usage_by_hour` report. UTC
  hours are rotated into the panel's local zone (whole-hour, DST-naive
  — same approach as Hour of day). Subtitle carries the peak hour, the
  busiest model, and the window's token total.
- **Session duration**: histogram over fixed buckets (`<5m`, `5-15m`,
  `15-30m`, `30-60m`, `1-2h`, `>2h`) from the `durations` report,
  rendered in canonical order (not count order); subtitle carries
  median / p90 / longest from `duration_stats`. Duration is
  `last_activity_at − started_at` — wall-clock span, not active time.
- **Fan-out**: histogram of subagents per spawning session over fixed
  buckets (`1`, `2`, `3-4`, `5-8`, `9+`) from the `subagent_parents`
  report, in canonical order.
- **Delegation**: KPI row — spawning sessions, subagent sessions, and
  max fan-out from `subagent_parents`; tokens-delegated share and
  estimated subagent spend from `subagent_usage_by_day` (priced
  panel-side, same honesty rule as Spend & tokens) — plus a weekly
  delegated-token-share line chart. The share is token-based: subagent
  tokens over all tokens in the window. Counts come from two reports
  with slightly different reach: the usage split needs only the child's
  parent edge, while the parent-grouped KPIs require the parent row to
  exist, so a child whose parent was never imported counts in the share
  but not under spawning sessions.
- **Top delegating sessions**: the highest-fan-out spawning sessions
  (capped at 8) with agent badge, project link, child count, and a deep
  link into the session's transcript.
- **By parent agent**: the per-parent-agent table from the `subagents`
  report (children started in the window, grouped by the parent's
  agent).

### States

- **No sessions in window**: every card renders its own empty message;
  KPIs show `—` / `0 days`.
- `last=all`: daily-resolution charts (spend & tokens, model share,
  active-days %, delegation trend) clamp to the trailing 365 days and
  say so in their subtitles; punch card, across-the-day, durations, and
  the subagent KPIs/tables stay unclamped.

---

## Sessions `/sessions`

The primary browsing surface. Filtered, searchable, sortable, paginated.
All state lives in the querystring.

### Layout

```
Sessions

  +-------------------------------------------------------+
  |  / search prompts and tool output                     |
  +-------------------------------------------------------+

  [ 30d ▾ ]   [ all agents ▾ ]   [ all projects ▾ ]   [ all devices ▾ ]   [ all profiles ▾ ]   [ columns ▾ ]

  +--------+--------+----------------+--------+--------+--------+
  | AGENT  | PROJECT| FIRST PROMPT   | TOKENS▾| COST   | DEVICE |
  +--------+--------+----------------+--------+--------+--------+
  | row    | row    | row            | row    | row    | row    |
  | row    | row    | row            | row    | row    | row    |
  +--------+--------+----------------+--------+--------+--------+

  Page 2 of 7  ·  Total 312                  ◂ prev   next ▸
```

### Search

A prominent full-width `<input name="q" type="search">` sits above the
table inside a GET form pointing at `/sessions`. Submission preserves
every other filter via hidden inputs so search composes with the
window, agent, project, device, profile, sort, columns, and page state.

The `/` global shortcut focuses this input (the topbar search is gone).

Server side, a non-empty `q` switches `Sessions.List` into FTS mode —
the proto's `query` field joins on `turns.content_tsv` and ranks by
`ts_rank` desc. FTS rank wins over any explicit sort.

### Filters

Five controls under the search input. Same pattern as Home, with the
window as single-select and the others as
[multi-select dropdowns](components.md#multi-select-dropdown).

- **Window**: `12h`, `7d`, `30d`, `1y`, `all`. The default comes from
  Settings and starts at `30d`.
- **Agent** (multi): hardcoded slice of known agents.
- **Project** (multi): distinct project labels.
- **Device** (multi): friendly names.
- **Profile** (multi): distinct profile names from the profiles report.

### Column chooser

A **Columns** button opens the same multi-select dropdown pattern as
agent/project/device. Seven keys: `agent`, `project`, `first_prompt`,
`tokens`, `cost`, `device`, `id`. Submitting sets
`?cols=agent,project,first_prompt,...`. When `?cols` is missing the table
renders the default set: all columns **except** `id`. See
[components.md](components.md#column-chooser).

### Table

`<thead>` carries sortable header links. Each header cycles three
states on repeat clicks:

1. Sort by that column in its default direction (`started_at`,
   `total_tokens`, and `cost` default to descending; `agent`, `project`,
   and `device` default to ascending). Sets `?sort=<key>`; `dir` is
   omitted when it matches the default.
2. Reverse direction — sets `?sort=<key>&dir=<asc|desc>` (opposite of
   the default).
3. Clear sort — removes `sort` and `dir`; the table returns to the
   default view (`started_at`, newest first).

The active column shows an arrow in the header (▴ ascending, ▾
descending). Cost sorts in the panel after loading all matching rows and
computing `pricing.CostUSD`; other columns sort server-side via
`Sessions.List` (`sort_by` + `sort_dir`). FTS search (`q` set) still
overrides explicit sort (rank wins).

The **First message** column is not sortable; long prompts truncate with ellipsis
and the full text is in the `title` tooltip. Rows without a first
prompt show `(no prompt)` but remain clickable (whole row HTMX-swaps
the side panel and pushes `?session=<id>` without reloading the list).
**Tokens** render in compact notation (`1.2k`, `3.4m`, `2.4b`); the exact
comma-grouped count is in the cell `title` tooltip.
**Started** shows relative time (`12h ago`) with the
full timestamp on hover. Git remotes in **Project** render as
`owner/repo` with a provider icon and HTTPS link.

### Pagination

Fixed 50 rows per page. `Sessions.List` returns `total_count` for the
same WHERE clause (sans LIMIT/OFFSET) so the footer can compute
`Page N of M (Total T)` with prev/next anchors. Each anchor carries
the full filter+sort+cols state plus `?page=N`.

### State

Every filter, every sort key, every visible-column toggle, every page
number lives in the querystring. URLs are bookmarkable and shareable.
No cookies, no localStorage beyond what auth already uses.

### States

- **No matches**: "nothing matched. try a wider window or fewer filters."
- **Empty FTS**: "nothing matched that search."
- **Side panel open**: the panel docks on the right; clicking another
  row swaps its contents and replaces `?session=` in the URL.

---

## Projects `/projects`

Lightweight landing page. Table of projects in the chosen window;
clicking a row navigates into a filtered Sessions view.

### Layout

```
Projects

  [ 30d ▾ ]   (window: 12h · 7d · 30d · 1y · all)

  +------------------+----------+----------+
  | PROJECT          | AGENT    | SESSIONS |
  +------------------+----------+----------+
  | prosa            | claude   |       48 |
  | mz-iac           | codex    |       21 |
  | brain            | claude   |       11 |
  +------------------+----------+----------+
```

- Projects data served by `Analytics.GetReport("projects", since, until)`.
- The first cell of each row is an `<a href="/sessions?project=<label>&last=<window>">`
  so clicking lands on a Sessions view already filtered by that
  project, preserving the current window.
- Sort/paginate client-side only if the table grows past ~200 rows.
  Projects-per-window is small in practice.

### States

- **No projects in window**: "no projects in the selected window. try
  expanding."

---

## Profiles `/profiles`

Profile analytics dashboard. Shares the dashboard filter chrome (same
drawer, chips, and URL state, posting back to `/profiles`). Top to
bottom: KPI strip, trend + usage row, the device × agent × profile
table.

```
   3            40%             1.5m       $4.70
   active       sessions        tokens     est. spend
   profiles     outside default

+---------------------+   +---------------------+
| Sessions per profile|   | Tokens & cost per   |
| ▶ stacked weekly    |   | profile             |
|   columns + legend  |   | ▶ bars + cost donut |
+---------------------+   +---------------------+

+----------------------------------------------+
| By device                                    |
| ▶ device × agent × profile table             |
+----------------------------------------------+
```

- **KPI strip**: active profiles (distinct device × agent × profile
  groups in the window), share of sessions outside the `default`
  profile, token total, and estimated spend — all from the
  `profile_usage` report, priced panel-side per model.
- **Sessions per profile**: stacked weekly columns per `agent·profile`
  (top 4 + "other", same fold as Home's activity trend), from the
  `profiles_by_day` report. Charts label `agent·profile` with devices
  folded — the same logical account may sync from several devices.
  `last=all` clamps to the trailing 365 days and says so.
- **Tokens & cost per profile**: token bars per `agent·profile` plus a
  cost-share donut with a palette-matched legend; unpriced models count
  tokens but no spend.
- **By device**: one row per device × agent × profile with sessions,
  tokens, estimated cost, and last activity. Device, agent, and profile
  cells deep-link into the filtered `/sessions` view.

### States

- **No profiles in window**: "no profiles in this window."; KPIs show
  `—` / `0`.
- Installs with only `default` profiles render honestly: one profile
  per agent, `0%` outside default.

---

## Devices `/devices`

Device admin. Approval form on top, table below. The Hostname cell of
each row navigates into a filtered Sessions view.

```
Devices

  [ form: approve new device ]
   user code [______]   [ approve ]

  +----------------+----------+-----------+------+
  | HOSTNAME       | STATE    | LAST SEEN | ACT  |
  +----------------+----------+-----------+------+
  | laptop-caian   | active   | 2 min     | edit |
  | mz-server      | active   | 1 h       | edit |
  | old-desktop    | revoked  | 12 d      |  -   |
  +----------------+----------+-----------+------+
```

- Approval form in a top card, padding 32 px;
- Table with row height 48 px, light dividers;
- **Hostname** column is an `<a href="/sessions?device=<friendly_name>">`
  — clicking navigates to a Sessions view already filtered by that
  device. The cell is not a rename trigger; rename lives behind the
  Edit button as before;
- State in color: `--ok` for active, `--text-3` for revoked;
- Edit reveals the rename input + Save / Cancel; the form posts to
  `/devices/<id>/rename` (POST-Redirect-GET, no HTMX). Esc inside the
  input cancels;
- Revoke remains a POST to `/devices/<id>/revoke`;
- Flash messages in a subtle banner above the table when arriving from
  a redirect.

---

## Settings `/settings`

Four cards for the logged-in owner: identity, appearance, time window,
and reset.

```
Settings

  +---------------------------------------------------+
  |  Logged in as                                     |
  |  hi@caian.org                                     |
  |  [ log out ]                                      |
  +---------------------------------------------------+
  +---------------------------------------------------+
  |  Appearance                                       |
  |  (o) Colorblind   ( ) Light       ( ) Nord        |
  |  ( ) Solar. Dark  ( ) Solar. Light( ) Dracula     |
  |  ( ) Gruvbox      ( ) High Contr. ( ) System      |
  +---------------------------------------------------+
  +---------------------------------------------------+
  |  Time window                                      |
  |  Default window [ 30d v ]                         |
  +---------------------------------------------------+
  +---------------------------------------------------+
  |  Reset preferences                                |
  |  [ reset preferences ]                            |
  +---------------------------------------------------+
```

- Email comes from the session cookie (`p.cookie.FromRequest(r)`).
- Logout button posts to `/logout` (same as the topbar form).
- The theme picker is a swatch grid of nine options: the colorblind
  (Okabe–Ito) default, seven alternates (`light`, `nord`,
  `solarized-dark`, `solarized-light`, `dracula`, `gruvbox`,
  `high-contrast`), and `system`. Picking one sets `data-theme` on
  `<html>` immediately — recoloring chrome and charts — and POSTs to
  `/settings/theme`.
- `/settings/theme` persists the choice server-side via
  `PreferencesService.Set`, keyed by owner email. The panel renders
  `data-theme` from the stored value on first paint, so the theme
  follows the owner across browsers with no flash.
- The default-window picker uses the same window catalog as the page
  filters (`12h`, `7d`, `30d`, `1y`, `all`) and POSTs to
  `/settings/window`.
- Page window filters persist per page through `PreferencesService.Set`.
  Home, Insights, Sessions, Projects, and Profiles each have their own
  saved window. A page without its own saved window uses the Settings
  default.
- `/settings/reset` clears the stored theme, default window, and page
  window preferences. The rendered defaults are Colorblind and `30d`.
- The catalog is `panel.Themes`: the picker renders from it and the
  handler validates the submitted value against it, so the two never
  drift.

---

## Sidepanel (session detail)

Triggered by a click on a `/sessions` row or by `?session=<id>` in the
URL. Slide-in 180 ms from the right.

```
+----------------+
| sticky header  |
|  claude-code   |
|  "refactor..." |
|                |
| stats cluster  |
|  18 / 3        |  ← turns / tools
|  18min / opus  |  ← duration / model
|                |
| metadata grid  |
|  ID      ...   |
|  Started ...   |
|  Project ...   |
|  ...           |
|                |
| transcript     |
|  (chat-style — see F2+)
|                |
| raw transcript |
|  paginated     |
|  [load more]   |
+----------------+
```

- Width 44% of main, max 720 px;
- Background `--bg-elev-1`, 1 px left divider;
- Sticky header (`.sp-header`) at the top of the panel, padding
  `--space-5 --space-6`. Shows the agent name (mono, `--text-3`) and
  the first prompt (`--text-md` weight 500). `esc`-style close button
  on the right.
- Stats cluster (`.stats-cluster`): 2 × 2 grid, gap `--space-4
  --space-5`. Each KPI is a number at `--text-lg` tabular plus a
  `--text-xs` uppercase label in `--text-3`. Cells: **turns**
  (user+assistant message count), **tools** (sum of tool invocations),
  **duration** (last_activity − started_at, `humanDuration`-formatted),
  **model**.
- Metadata grid (`.sp-meta`): labels in `--text-xs` uppercase
  `--text-3`, values in `--text-sm` `--text-1`, monospace for IDs and
  hashes.
- Subagents: when the session spawned children (Claude Code Agent
  tool, Codex `thread_spawn`), a "Subagents · N" section sits above
  the raw transcript with one card per child. Each card shows agent,
  start time, and the child's first prompt; clicking it
  HTMX-swaps the sidepanel to the child without losing the route.
- Transcript: chat-style bubbles. **User** aligns right with a
  filled `--bg-elev-2` surface and `<br>`-preserving escaped plain
  text; the raw boilerplate agents inject (`<command-name>`,
  `<system-reminder>`, `<environment_context>`,
  `<local-command-stdout>`, …) is stripped via
  `sessiontext.ParseUserMessage` — slash commands surface as a tiny
  `/cmd` chip in the bubble meta, everything else attaches as
  discrete `<details>` blocks below the body ("3 system reminders",
  "command stdout", "environment context"). **Assistant** aligns left
  and is rendered as markdown (goldmark/GFM, `WithUnsafe` off) with
  prose styles for headings, lists, code, tables. Consecutive
  `Role="tool"` turns coalesce into a single collapsible **tool
  group** with a one-line summary ("Read ×3 · Bash ×1"); each tool
  inside expands independently via native `<details>`. **Thinking**
  turns (Claude `content[].type="thinking"`, Codex `reasoning.summary`)
  coalesce into a discreet "Processed" card between dashed rules,
  body italic in `--text-3`. Between turn groups with a Ts gap
  ≥ `render.DividerThreshold` (30 s), a `time-divider` line shows
  "Worked for 2m 14s" so long agent runs stay visible without
  reading every cell.
- Raw transcript in `<pre class="raw">` at font-mono 11 px,
  white-space pre-wrap, kept as the verbatim source-of-truth panel.
- "load more" is an HTMX link with `hx-swap="beforeend"`.

`Esc` closes. Clicking outside also closes.

---

## Command palette (global overlay)

Triggered by `Cmd-K` / `Ctrl-K`. Native `<dialog>` + Alpine for
open/close.

```
        +-------------------------------+
        | / search anything             |
        +-------------------------------+
        |                               |
        |  Recent sessions              |
        |    18 min  prosa     refacto..|
        |    32 min  mz-iac    setup t..|
        |     4 min  brain     audit o..|
        |                               |
        |  Pages                        |
        |    Home · Insights · Sessions |
        |    Projects · Profiles        |
        |    Devices · Settings         |
        |                               |
        +-------------------------------+
```

- Modal 560 px × content height (max 70 vh);
- Dark backdrop with a light blur (only if
  `prefers-reduced-motion: no-preference`);
- Input with `hx-get="/search"` debounced 200 ms, swaps only the
  "Recent" section with the results;
- Arrow keys move focus; Enter opens the selection; Esc closes.

---

## Login `/login`

Public page. No sidebar, no topbar.

```
                          prosa


                  [ continue with github ]

                          or

                          [ dev login ]


              your first screen of the day
```

- Large logo at 36 px weight 200;
- Tagline at 14 px `--text-3` at the card footer;
- OAuth button full-width, primary;
- Dev-login only appears when `PROSA_PANEL_DEV_LOGIN` is set (loud
  warning at binary boot);
- Login error in a banner above the button, color `--danger`.

---

## Empty and error states

Never use emoji. Single-line messages, `--text-3`, horizontally centered.

| Scenario                | Message                                              |
| ----------------------- | ---------------------------------------------------- |
| No sessions in window   | "nothing in the selected window. try expanding."     |
| No search results       | "nothing matched that search."                       |
| No projects in window   | "no projects in the selected window. try expanding." |
| No devices              | "no device registered yet. run prosa setup."         |
| Loading error           | "failed to load. try refreshing the page."           |
| No permission           | "this account doesn't have access to this panel."    |
