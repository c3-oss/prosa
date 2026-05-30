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
|  prosa     [/ to search]    [12 today]    [logout]       |
+-----------+----------------------------------------------+
| Sidebar   | Main                                         |
| (220 px)  |                                              |
|           |                                              |
|  Home     |                                              |
|  Devices  |     (content)                                |
|  Analytics|                                              |
|           |                                              |
|           |                                              |
+-----------+----------------------------------------------+
```

When the session sidepanel is open it enters from the right, taking
~44% of the main area's width:

```
+-----------+--------------------+-------------------------+
| Sidebar   | Main (partial)     | Session sidepanel       |
+-----------+--------------------+-------------------------+
```

Topbar and sidebar use `--bg-elev-1`. Main uses `--bg`. Region dividers
are 1 px `--divider`.

Global shortcuts:

- `/` focuses the topbar search;
- `Cmd-K` / `Ctrl-K` opens the command palette;
- `Esc` closes the sidepanel or the command palette;
- `j` / `k` moves the selection in lists;
- `Enter` opens the current selection.

---

## Home `/`

Default page after login. Two stacked sections: **Today** and **Recent**.

### Today block

Container with 48 px padding, horizontally centered.

```
Today                                            [* live]

   12              3               2
   sessions        projects        active models

   sparkline 14d (240 x 48 px) in accent-soft
```

- KPI: number at 44 px weight 300; label at 14 px `--text-3` weight 500
  uppercase, letter-spacing 0.06em.
- Gap between KPIs ≥ 64 px.
- Sparkline below the KPIs is at most 320 px wide.
- The live dot (`--ok`, 8 px, pulsing) appears only when there is an
  active session in the last 10 minutes. "live" label at 12 px next to it.

States:

- **No sessions today**: KPIs show `0`, sparkline hides, discreet message
  below: "no sessions today. see recent below".
- **Loading**: do not show a skeleton; the server renders with the
  numbers ready before sending the response.

### Filter pills block

A collapsible chip row between Today and Recent. Component documented in
[components.md#filter-pill](components.md#filter-pill).

```
[ 7d ▾ ]   [ all agents ▾ ]   [ all devices ▾ ]   [ all projects ▾ ]
```

Clicking the chip opens the Alpine-managed dropdown; the selection
triggers an `hx-get` that swaps the Recent block alone (not the full
page).

### Recent block

Vertical list of sessions grouped by day. Day heading at 18 px weight 500
plus a relative date in `--text-3`.

```
Today
  09:14  claude-code   prosa       "refactor sync logic"     18 min
  11:02  codex         mz-iac      "setup terraform vpc"     32 min

Yesterday
  16:40  claude-code   brain       "audit obsidian vault"     4 min
  14:22  codex         prosa       "tests for sqlite store"  47 min
```

- Row height 56 px;
- Hover: background `--bg-elev-2`, cursor pointer;
- Click: opens the sidepanel (HTMX swap, push URL with `?session=<id>`);
- Active session: the timestamp receives `*` in `--ok`;
- Columns: timestamp 70 px, agent 110 px, project 140 px, first_prompt
  flex, duration 70 px right-aligned;
- Row typography: 14 px, weight regular, `--text-1` for project and
  prompt, `--text-2` for agent, `--text-3` for timestamp and duration;
- Row divider: 1 px `--divider`.

States:

- **Empty**: "nothing in the selected window. try expanding the time
  filter."
- **Many sessions**: do not paginate aggressively; the default 7-day
  window rarely exceeds ~50 rows. For broader windows, consider an
  HTMX-driven "fetch more" at the end of the list (not implemented now).

---

## Analytics `/analytics/<report>`

Report list in the sidebar:

```
Analytics
  sessions   *
  projects
  tools
  models
  errors
  heatmap
```

The active item gets a small `--accent` dot before its name. Clicking
swaps only the main area (HTMX).

### Common layout

```
sessions               [ 30d ▾ ]   [ all agents ▾ ]   ...

[ featured chart spans full width, height 280-320 px ]

support table below
+----------+----------+--------+
| header   | header   | header |
| row      | row      | row    |
+----------+----------+--------+
```

- Report title at 28 px weight 400, margin-bottom 24 px;
- Filters right under the title;
- Featured chart in a subtle card (background `--bg-elev-1`, radius
  8 px, padding 32 px);
- Table with row height 40 px, `--divider` separators, numbers in
  tabular-nums right-aligned.

Each chart is [HTMX-swappable](components.md#htmx-chart-swap) when the
filter changes.

### Report `sessions`

Chart: **trend line** of sessions/day, last 30 days.

- X axis: days, labels only at multiples of 5 days;
- Y axis: count, discreet label in `--text-3`;
- Line in `--accent`, fill in `--accent-soft`;
- Hover on a point: enlarged circle + `<title>` showing "12 sessions on
  2026-05-23".

Table: by agent — `AGENT | SESSIONS | TURNS`.

### Report `tools`

Chart: **bar leaderboard** top 20 + 14-day sparkline per row on the top
5.

```
Read     ████████████████████  234   ▁▂▃▅█▇▅▃
Bash     ██████████             102   ▁▂▂▃▄▃▂▁
Edit     ████                    48   ▁▁▂▃▂▂▁▁
Glob     ███                     34
Grep     ██                      28
...
```

- Each bar 24 px tall;
- Width proportional to the maximum (Read = 100%);
- Number on the right in mono tabular;
- Sparkline only on the top 5 (max 80 × 20 px) between the number and
  the row end.

Auxiliary table: `TOOL | USES | SESSIONS`.

### Report `models`

Chart: **donut** (180 × 180 px, centered) + vertical list with mini-bars.

```
        ┌──┐
       /    \                  sonnet 87%   ███████████
      |      |                 opus    11%  ██
       \    /                  haiku    2%  ▏
        └──┘
```

- Slice in `--accent`, gradient tones (`--accent`, `--accent-soft`,
  gray);
- 50% hole with the total number at the center (28 px tabular);
- Right-hand list: name + percent + mini-bar.

Auxiliary table: `MODEL | SESSIONS`.

### Report `projects`

Chart: **bar leaderboard** top 15 with a 14-day sparkline per row.

Same structure as tools but with agent-aware identity
(`project_remote` > `project_marker` > `project_path`).

Auxiliary table: `PROJECT | AGENT | SESSIONS`.

### Report `errors`

Chart: **trend line** of error sessions per day (FTS5 heuristic:
`error|exception|traceback|panic|fatal`).

- Line in `--danger`, fill in `--danger` with alpha;
- Y axis starts at 0;
- Click on a point: filters the table below to that day.

Table: `STARTED | AGENT | PROJECT | SESSION`.

### Report `heatmap` (new)

Chart: **daily contribution heatmap** for the selected window.

```
Sun ░ ░ ▒ ▓ ░
Mon ░ ▒ ▓ █ ░
Tue ░ ░ ░ ▒ ▓
...
```

- Cells 16 × 16 px, gap 2 px;
- Color scale uses `--accent` mixed with panel surface tokens by count;
- Grid flows by week with 7 day rows;
- Cell hover: `<title>` "2026-05-23: 5 sessions";
- Discreet legend in the corner: scale gradient + "less / more".

Optional auxiliary table: daily totals across the selected window.

---

## Devices `/devices`

```
Devices

  [ form: approve new device ]
   user code [______]   [ approve ]

  +----------------+----------+-----------+------+
  | NAME           | STATE    | LAST SEEN | ACT  |
  +----------------+----------+-----------+------+
  | laptop-caian   | active   | 2 min     | edit |
  | mz-server      | active   | 1 h       | edit |
  | old-desktop    | revoked  | 12 d      |  -   |
  +----------------+----------+-----------+------+
```

- Approval form in a top card, padding 32 px;
- Table with row height 48 px, light dividers;
- State in color: `--ok` for active, `--text-3` for revoked;
- "edit" opens an inline input for renaming (POST-Redirect-GET, no HTMX
  for now);
- Flash messages in a subtle banner above the table when arriving from
  a redirect.

---

## Sidepanel (session detail)

Triggered by a click on a Home row or by `?session=<id>` in the URL.
Slide-in 180 ms from the right.

```
+----------------+
| sticky header  |
|  prosa         |
|  claude-code   |
|  2026-05-30    |
|                |
| stats cluster  |
|  18 turns      |
|  3 tools       |
|  18 min        |
|  sonnet-4-6    |
|                |
| metadata grid  |
|  device  laptop|
|  project prosa |
|  marker  .prosa|
|  ...           |
|                |
| raw transcript |
|  paginated     |
|  [load more]   |
+----------------+
```

- Width 44% of main, max 720 px;
- Background `--bg-elev-1`, 1 px left divider;
- Sticky header at the top of the sidepanel, padding 24 px;
- Stats cluster: 4 mini-KPIs in a 2 × 2 grid, numbers at 22 px tabular;
- Metadata grid: labels in `--text-3`, values in `--text-1`, monospace
  for IDs;
- Raw transcript in `<pre>` at font-mono 13 px, line-height 1.5;
- "load more" is an HTMX link with `hx-swap="beforeend"` (current
  behavior).

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
        |  Reports                      |
        |    sessions  · tools  · models|
        |    projects  · errors · heatm.|
        |                               |
        |  Devices                      |
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
| No sessions today       | "no sessions today. see recent below"                |
| Nothing in window       | "nothing in the selected window. try expanding."     |
| No search results       | "nothing matched that search."                       |
| No devices              | "no device registered yet. run prosa setup."         |
| Loading error           | "failed to load. try refreshing the page."           |
| No permission           | "this account doesn't have access to this panel."    |
