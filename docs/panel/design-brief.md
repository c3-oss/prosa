# Design brief: prosa panel

## Context

`prosa-panel` is the web binary of `prosa`. It is the first screen of the
day: you open it, you see what you were working on, you search an old
session, you check which devices are active, and you look at aggregates
over your own flow (how many sessions today, which tools you used most,
which model).

Today the panel is functional and lean:

- Go + `html/template` + `embed.FS` (single binary, no build step);
- HTMX already integrated (sidepanel swap, raw pagination);
- SSE for the "new sessions" badge in real time;
- 3 screens — Home (timeline), Devices (admin), Analytics (5 reports
  rendered as flat tables);
- ~72 KB of assets, dark palette, system fonts, CSS grid layout;
- Auth via GitHub OAuth with a `PROSA_PANEL_DEV_LOGIN` bypass for dev.

This brief describes what the panel should **become**: more beautiful,
more dynamic, richer in details/metrics/charts, without losing speed or
the single-binary lightness.

## Central direction

The panel should be **airy, elegant, and contemplative**.

Airy here means:

- generous breathing room between blocks;
- larger typography, comfortable reading;
- hierarchy by size, not by marked borders;
- thin dividers in place of cards with aggressive shadows;
- big, tabular numerals in KPIs;
- one featured chart per section, not six crowded ones;
- short smooth transitions (120–180 ms), never showy.

Contemplative means: the panel is a screen you open at the start of the
day to orient yourself. It is not Grafana, it is not a 24/7 operations
console. Medium density, low visual weight, focus on what matters in that
moment.

## Not an SPA

We don't want to turn the panel into an SPA with client routing, a global
store, a bundler, or a heavy reactive framework.

The server-first stack stays:

- `html/template` remains the renderer;
- HTMX remains the swap engine;
- charts render with **Frappe Charts** (a vendored ~19 KB SVG library) fed
  CSS-token colors via a JSON island the server builds in
  `internal/panel/charts`; no other client charting library;
- Alpine.js (~15 KB) joins for local UI state only (toggle, modal, hover,
  command palette);
- no new build step, no `npm`, no `node_modules` — vendored libraries are
  prebuilt single files embedded via `embed.FS`, like htmx and alpine.

Everything must still ship as **a single binary** with embedded assets.

## Visual language

Dark palette (light mode is a hook in CSS vars, not implemented now):

- `--bg`           `#0f1117`   background;
- `--bg-elev-1`    `#1a1d27`   elevated surface (topbar, sidebar);
- `--bg-elev-2`    `#232733`   hover, inputs, subtle KPI background;
- `--text-1`       `#e8eaf0`   primary text;
- `--text-2`       `#aab0bf`   secondary text;
- `--text-3`       `#6b7186`   tertiary text (timestamps, labels);
- `--accent`       `#6b7afc`   links, charts, active states;
- `--accent-soft`  `#6b7afc33` sparkline / heatmap fills;
- `--ok`           `#4ade80`   live indicator, success;
- `--danger`       `#f04a5c`   errors;
- `--divider`      `#232733`   very thin lines between rows.

Typography:

- system fonts (`-apple-system, BlinkMacSystemFont, "Segoe UI", …`);
- base 16 px, line-height 1.5;
- scale: 12, 14, 16, 18, 22, 28, 36, 44;
- large KPIs: 44 px, weight 300, letter-spacing -0.02em;
- numerals always `font-variant-numeric: tabular-nums`;
- mono for IDs, timestamps, raw transcripts.

Spacing: scale 4-8-12-16-24-32-48-64. Generous padding in main
containers (32–48 px). Gap between KPIs ≥ 48 px.

Motion:

- default transition 120 ms ease-out;
- side panel slide-in 180 ms ease-out;
- live dot: 2s infinite pulse;
- filter pill toggle: 80 ms.

No complex skeleton loaders, no exhibitionist loading spinners, no
parallax, no scroll-jacking, no entrance animation on page load.

## Principal surface

The principal experience is desktop browser, full window (≥ 1280 px). The
panel does **not** need to be mobile-responsive in this phase: it is the
first-screen-of-the-day on a laptop.

Accessibility:

- minimum AA contrast on text;
- visible focus rings (outline `--accent` 2 px + 2 px offset);
- `prefers-reduced-motion` disables transitions;
- charts expose hover tooltips and a matching HTML legend; the CSS-grid
  heatmap / punch card cells carry `aria-label`s;
- keyboard shortcuts don't block input in forms.

## Flows that need to be designed

The flows already exist in the current panel. The exercise is to
**visually redesign** while keeping the logic. Per-screen details are in
[`screens.md`](screens.md).

### 1. Home `/`

Today: a list of sessions grouped by day, filters via querystring, no
aggregates.

Direction: a **Today** block at the top with 3 large KPIs (sessions,
projects, active models), a 14-day sparkline, a live dot if there's been
a session in the last 10 minutes. Below, a **Recent** list with more
breathing room and light dividers. Collapsible filter pills with Alpine
toggle + HTMX swap.

### 2. Analytics `/analytics/<report>`

Today: analytics reports render server-side from the fixed API surface
(sessions, projects, tools, models, errors, heatmap, usage).

Direction: each report becomes a page with **title + featured chart +
support table**. Heatmap follows the GitHub-style daily contribution graph:
one cell per day, with intensity scaled by session count.

| Report     | Featured chart                                       |
| ---------- | ---------------------------------------------------- |
| sessions   | trend line of sessions per day (30 d) + by agent     |
| tools      | bar leaderboard top 20 + sparkline per top-5         |
| models     | donut + list with bars                               |
| projects   | bar leaderboard top 15 + sparkline per row           |
| errors     | trend line of errors per day                         |
| heatmap    | trailing 53-week contribution graph, scaled in `--accent` |
| usage      | token totals and estimated cost by agent             |

Each chart is HTMX-swappable when the filter changes (window, agent,
device, project).

### 3. Devices `/devices`

Today: admin table with approve, rename, revoke.

Direction: airy pass. Table with more breathing room, friendly_name in
medium weight, status in color (`--ok`/`--danger`). Approval form in a
simple card at the top. No functional rewrite.

### 4. Sidepanel (session detail)

Today: HTMX swap shows metadata + paginated raw transcript.

Direction: metadata becomes a grid with larger labels. A new "stats"
cluster above the raw: turn count, tool count, duration, model. Raw
transcript with more leading and subtle color on JSON prefixes.

### 5. Command palette

New. `Cmd-K` / `Ctrl-K` opens a centered modal: search input + a list of
recent sessions + quick links (report shortcuts). Live suggestions via
HTMX on `/search`. Native `<dialog>` + Alpine for open/close.

### 6. Login `/login`

Today: a centered card with OAuth button and dev-login.

Direction: airy pass. Larger tagline, more marked vertical rhythm. No
functional change.

## Mocks requested

I want visual mocks (HTML/CSS or raster) that help me feel the result
before coding. Each mock represents either a screen or an isolated
component.

1. **Home — Today + Recent** in a 1440 px window. Today with 3 large
   KPIs, 14-day sparkline, live dot active. Recent with 8–10 sessions of
   the day, grouped.
2. **Analytics: sessions** with 30-day trend line and an auxiliary table
   below.
3. **Analytics: tools leaderboard** top 20 with horizontal bars and a
   sparkline per row on the top 5.
4. **Analytics: models donut** with 3–4 models and a compact legend.
5. **Analytics: heatmap** calendar 30 d × 24 h in a single-color scale.
6. **Sidepanel open** with metadata + stats cluster + paginated raw
   transcript.
7. **Filter pills** active and inactive, with hover state.
8. **Command palette** open with an input, 5 recent-session suggestions,
   3 report shortcuts.
9. **Devices** with three devices listed in different states (active,
   pending, revoked).
10. **Login** with the OAuth button + dev-login form in an airy layout.
11. **Isolated KPI card** showing "12 sessions" + 14-day sparkline + live
    dot.
12. **Mood board** — the palette + typography + spacing scale.

Ready-to-use prompts to generate each mock live in
[`mock-prompts.md`](mock-prompts.md).

## Expected result

The ideal prosa panel should look like a **well-designed digital
notebook**, not an operations console.

When you open it in the morning, it orients you quietly: a few large
numbers, a beautiful chart, yesterday's list and today's list. When you
want to dig deeper, the reports are there. When you want to find
something, the command palette resolves it in two keystrokes. Everything
loads instantly. Everything fits in one binary.

It doesn't need to impress through density. It needs to convey **clarity**
— I opened the panel, I understood where I was, I saw what mattered, I
found what I wanted, and nothing else got in the way.
