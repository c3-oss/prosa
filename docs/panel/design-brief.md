# Design brief: prosa panel

## Context

`prosa-panel` is the web binary of `prosa`. It is the first screen of the
day: you open it, you see what you were working on, you search an old
session, you check which devices are active, and you look at aggregates
over your own flow (how many sessions today, which tools you used most,
which model).

The panel is functional and lean:

- Go + `html/template` + `embed.FS` (single binary, no build step);
- HTMX for partial swaps (sidepanel, raw pagination);
- SSE for the "new sessions" badge in real time;
- 7 screens — Home, Insights, Sessions, Projects, Profiles, Devices, Settings;
- Editorial Almanac palette, self-hosted serif and sans-serif fonts, CSS grid layout;
- Auth via GitHub OAuth with a `PROSA_PANEL_DEV_LOGIN` bypass for dev.

This brief describes the design direction: airy, beautiful, dynamic,
richer in details/metrics/charts, without losing speed or the
single-binary lightness.

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

"Editorial Almanac": a warm-ink dark palette with a single petrol accent.
The layout is folio-style: hairline rules separate sections (no bordered
cards or box shadows); section labels are small-caps; the topbar reads as
a magazine header. Generous page margins and comfortable reading distances
reinforce the contemplative register.

Default palette (`:root`):

- `--bg`           `#15140f`   background (warm near-black);
- `--bg-elev-1`    `#1d1b15`   elevated surface (topbar, sidebar);
- `--bg-elev-2`    `#25221a`   hover, inputs, subtle KPI background;
- `--text-1`       `#ece6d7`   primary text (warm near-white);
- `--text-2`       `#a8a193`   secondary text;
- `--text-3`       `#76705f`   tertiary text (timestamps, labels);
- `--accent`       `#2f8f7f`   links, charts, active states (petrol teal);
- `--accent-soft`  `#2f8f7f33` sparkline / heatmap fills;
- `--ok`           `#6fae6a`   live indicator, success;
- `--danger`       `#cf6b4a`   errors;
- `--divider`      `#2a2820`   very thin lines between rows.

The chart palette (`--chart-1` through `--chart-8`) is warm-neutral with
petrol as the primary series color. Each named theme (Colorblind, Nord,
Solarized, etc.) overrides the color tokens under its own
`[data-theme="<id>"]` block; the editorial layout and type are global and
apply to every theme.

Typography:

- Serif display: **Newsreader** (`--font-serif`) for h1/h2 headings,
  the wordmark, and large KPI numerals;
- Body sans-serif: **Geist** (`--font-sans`) for prose, tables, labels,
  and general UI chrome;
- Monospace: **Geist Mono** (`--font-mono`) for IDs, timestamps, costs,
  and raw transcript;
- All three families are self-hosted `woff2` files embedded in the binary
  (see `internal/panel/assets/fonts/`); no web-font or CDN requests;
- Base 16 px, line-height 1.5;
- Scale: 12, 14, 16, 18, 22, 28, 36, 44;
- Large KPIs: 44 px, Newsreader, weight 300;
- Numerals always `font-variant-numeric: tabular-nums`.

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

## Flows

Per-screen details are in [`screens.md`](screens.md).

### 1. Home `/`

KPI strip at the top (sessions, projects, active models, tokens, spend,
error rate), heatmap card, and two-column rows of analytics cards.
Collapsible filters block with window + multi-select agent/project/device
dropdowns; submits as a plain GET form.

### 2. Analytics

Analytics reports are embedded in the Home dashboard cards and the
Sessions/Projects pages. Each surfaces a **featured chart + support
table**. The heatmap follows the GitHub-style daily contribution graph:
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

The Home dashboard re-renders fully when the filters form submits; there
is no HTMX chart-swap pattern on that page.

### 3. Devices `/devices`

Admin table with approve, rename, revoke. Table with breathing room,
friendly_name in medium weight, status in color (`--ok`/`--danger`).
Approval form in a simple card at the top.

### 4. Sidepanel (session detail)

HTMX swap from a Sessions row. Metadata grid with larger labels. Stats
cluster above the transcript: turn count, tool count, duration, model.
Chat-style transcript with markdown rendering for assistant turns.

### 5. Command palette

`Cmd-K` / `Ctrl-K` opens a centered modal: search input + a list of
recent sessions + quick links to pages. Live suggestions via HTMX on
`/search`. Native `<dialog>` + Alpine for open/close.

### 6. Login `/login`

Centered card with OAuth button and dev-login form. Large tagline,
marked vertical rhythm.

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
6. **Sidepanel open** with the masthead + five-up stats cluster +
   metadata + iMessage-style chat transcript + paginated raw transcript.
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

The ideal prosa panel should look like a **well-designed editorial
notebook**, not an operations console.

When you open it in the morning, it orients you quietly: a few large
numbers, a beautiful chart, yesterday's list and today's list. When you
want to dig deeper, the reports are there. When you want to find
something, the command palette resolves it in two keystrokes. Everything
loads instantly. Everything fits in one binary.

It doesn't need to impress through density. It needs to convey **clarity**
— I opened the panel, I understood where I was, I saw what mattered, I
found what I wanted, and nothing else got in the way.
