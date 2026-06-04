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
|  Sessions |                                              |
|  Projects |     (content)                                |
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

The sidebar is five entries: **Home**, **Sessions**, **Projects**,
**Devices**, **Settings**. There is no Analytics group; the per-report
pages were folded into the Home dashboard and the Sessions list.

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
heatmap card, then two-column rows of cards.

### Filters

A single `<details>` block sits at the top of the page so it doesn't
crowd the dashboard.

```
▸ filters
```

When open it reveals four controls:

- **Window** (single-select): `12h`, `7d`, `30d`, `1y`, `all`. Default
  `30d`.
- **Agent** (multi-select dropdown): all known agent names. Multiple
  picks submit as repeated `agent=` query params.
- **Project** (multi-select dropdown): distinct project labels from the
  projects analytics report.
- **Device** (multi-select dropdown): friendly names from the device
  registry.

The block submits as a plain GET form. The whole page re-renders; no
HTMX. State lives in the URL so bookmarks reproduce the view.

The heatmap card ignores `window` by design; everything else honors it.

### KPI strip

Three KPIs across the top, each in a [`kpi`](components.md#kpi-card)
card.

```
   12             3              2
   sessions       projects       models
```

- **Sessions** in window;
- **Projects** active in window;
- **Models** active in window.

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

### Tools / Models / Errors / Usage cards

Two-column rows under the heatmap.

```
+---------------------+   +---------------------+
| Tools               |   | Models              |
| ▶ bar leaderboard   |   | ▶ bar leaderboard   |
+---------------------+   +---------------------+

+---------------------+   +---------------------+
| Errors              |   | Usage               |
| ▶ recent error rows |   | ▶ totals + per-agent|
+---------------------+   +---------------------+
```

- **Tools**: HTML bar leaderboard from the `tools` analytics report.
  Same `.usage-bar`-style markup the old analytics page used. No SVG.
- **Models**: HTML bar leaderboard from the `models` report. The donut
  SVG sketched in [components.md](components.md#donut) is deferred —
  bars stay consistent with Tools.
- **Errors**: table of recent error sessions (FTS heuristic
  `error|exception|traceback|panic|fatal`). Columns: started, agent,
  project, session id.
- **Usage**: total tokens + total estimated cost in the window, with a
  per-agent breakdown.

All four cards re-render with the rest of the page when the filters
form submits. No HTMX chart-swap pattern here; the dashboard is one
GET away from any state change.

### States

- **No sessions in window**: KPIs show `0`; cards render their own
  empty messages. The heatmap still draws (its window is fixed).
- **Loading**: the server renders with values ready before sending the
  response — no skeleton.

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

  [ 30d ▾ ]   [ all agents ▾ ]   [ all projects ▾ ]   [ all devices ▾ ]   [ columns ▾ ]

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
window, agent, project, device, sort, columns, and page state.

The `/` global shortcut focuses this input (the topbar search is gone).

Server side, a non-empty `q` switches `Sessions.List` into FTS mode —
the proto's `query` field joins on `turns.content_tsv` and ranks by
`ts_rank` desc. FTS rank wins over any explicit sort.

### Filters

Four controls under the search input. Same pattern as Home, with the
window as single-select and the others as
[multi-select dropdowns](components.md#multi-select-dropdown).

- **Window**: `12h`, `7d`, `30d`, `1y`, `all`. Default `30d`.
- **Agent** (multi): hardcoded slice of known agents.
- **Project** (multi): distinct project labels.
- **Device** (multi): friendly names.

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

- Same projects data the old analytics report drew, served by
  `Analytics.GetReport("projects", since, until)`.
- The first cell of each row is an `<a href="/sessions?project=<label>&last=<window>">`
  so clicking lands on a Sessions view already filtered by that
  project, preserving the current window.
- Sort/paginate client-side only if the table grows past ~200 rows.
  Projects-per-window is small in practice.

### States

- **No projects in window**: "no projects in the selected window. try
  expanding."

---

## Devices `/devices`

Device admin. Same shape as before — approval form on top, table below
— with one change: the Hostname cell of each row now navigates into a
filtered Sessions view.

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

Single-card surface for the logged-in owner. Spartan by design.

```
Settings

  +---------------------------------------------------+
  |  Signed in as                                     |
  |  hi@caian.org                                     |
  |                                                   |
  |  [ logout ]                                       |
  +---------------------------------------------------+
```

- One card, no tabs, no preferences sub-pages.
- Email comes from the session cookie (`p.cookie.FromRequest(r)`).
- Logout button posts to `/logout` (same as the topbar form).
- No SSE, no Alpine, no charts. If a future setting earns its place,
  it joins this card.

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
        |    Home · Sessions · Projects |
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
