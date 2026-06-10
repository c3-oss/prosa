# Components and tokens: prosa-panel

Catalog of reusable components and design tokens. For per-screen usage
see [screens.md](screens.md). For visual direction see the
[design brief](design-brief.md).

---

## Design tokens

CSS vars defined in `internal/panel/templates/assets/css/tokens.css`. All
other layers reference these vars — never a literal value.

### Dark palette

```
--bg               #0f1117
--bg-elev-1        #1a1d27
--bg-elev-2        #232733
--text-1           #e8eaf0
--text-2           #aab0bf
--text-3           #6b7186
--accent           #6b7afc
--accent-soft      #6b7afc33
--ok               #4ade80
--danger           #f04a5c
--divider          #232733
```

Future hook for light mode: `prefers-color-scheme: light` re-defines
these vars on `:root`. Not implemented now.

### Typography

```
--font-sans        -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
--font-mono        "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace

--text-xs          12px
--text-sm          14px
--text-base        16px   /* base */
--text-md          18px
--text-lg          22px
--text-xl          28px
--text-2xl         36px
--text-3xl         44px

--w-regular        400
--w-medium         500
--w-light          300
--w-thin           200
```

Apply `font-variant-numeric: tabular-nums` to any element with a number
(KPI, table, duration, count).

### Spacing

Fixed scale; do not use values outside it:

```
--space-1   4px
--space-2   8px
--space-3   12px
--space-4   16px
--space-5   24px
--space-6   32px
--space-7   48px
--space-8   64px
```

Main containers: padding `--space-7` (48 px). Cards: padding `--space-6`
(32 px). Gap between KPIs: `--space-7` or `--space-8`.

### Other

```
--radius-sm        4px      /* small buttons, pills */
--radius-md        8px      /* cards */
--radius-lg        12px     /* command palette modal */
--radius-full      9999px   /* dots */

--elev-1           0 1px 0 var(--divider)            /* subtle divider */
--elev-2           0 1px 2px rgba(0,0,0,0.3)         /* card */
--elev-3           0 8px 24px rgba(0,0,0,0.4)        /* modal */

--duration-fast    80ms
--duration-base    120ms
--duration-slow    180ms
--ease             cubic-bezier(0.2, 0.0, 0.0, 1)
```

Respect `prefers-reduced-motion: reduce` by disabling non-essential
transitions.

---

## KPI card

Used in the Home Today block and in the Sidepanel (stats cluster).

```html
<div class="kpi">
  <div class="kpi-value">12</div>
  <div class="kpi-label">sessions</div>
  <div class="kpi-sparkline">{{ .Sparkline }}</div>
</div>
```

```
+-----------------+
|       12        |    <- 44 px weight 300, tabular
|    sessions     |    <- 14 px uppercase letter-spacing 0.06em --text-3
|   ▁▂▅█▇▅▃▂▁    |    <- optional sparkline, 80 x 24 px
+-----------------+
```

- No border, no visible background (let the breathing room do the
  hierarchy);
- Internal gap: `--space-3` (12 px) between value, label, sparkline;
- When grouped in a grid (Today): `gap: --space-7` minimum between
  cards.

Variants:

- **default** — value + label;
- **with sparkline** — value + label + sparkline;
- **with delta** — value + label + delta vs previous period. **Landed**
  on the Home KPI strip (`.kpi-delta`): movement vs the
  immediately-preceding window of equal length. Tone classes
  `kpi-tone-good` (`--ok`), `kpi-tone-bad` (`--danger`), and
  `kpi-tone-muted` (`--text-3`) carry the reading — the error rate
  inverts (rising is bad), est. spend is always muted.

---

## Sparkline

**Deferred.** Home cards in the current cut render HTML bars and
tables, not inline SVG. The signatures below sketch the intended
server-side helper for when this lands; routes and proto do not
change when it does. Live targets: `internal/panel/charts/sparkline.go`,
returning `template.HTML`.

### Signature

```go
type SparklineOpts struct {
    Width  int    // default 80
    Height int    // default 24
    Class  string // default "sparkline"
    Color  string // default "currentColor"
}

func Sparkline(values []float64, opts SparklineOpts) template.HTML
```

### Resulting SVG

```html
<svg class="sparkline" viewBox="0 0 80 24" width="80" height="24">
  <path d="M0,18 L10,14 L20,8 L30,2 L40,4 L50,9 L60,15 L70,20 L80,22"
        fill="none" stroke="currentColor" stroke-width="1.5" />
  <path d="M0,18 L10,14 L20,8 L30,2 L40,4 L50,9 L60,15 L70,20 L80,22 L80,24 L0,24 Z"
        fill="var(--accent-soft)" opacity="0.4" />
  <circle cx="80" cy="22" r="2" fill="currentColor">
    <title>14d ago: 3 — today: 7</title>
  </circle>
</svg>
```

- Dataset min and max map to 22 and 2 (2 px top/bottom margins);
- Fill in `--accent-soft` from the line to the baseline;
- The last point always has a highlighted `<circle>`.

### Behavior

- CSS `:hover` on the circle scales it to r=3 and reveals the tooltip
  via `<title>`;
- Determinism: same values + same opts produce a byte-identical SVG
  (tests check against golden files).

---

## Bar row

Used in leaderboards (tools, projects, models).

### Signature

```go
type Bar struct {
    Label   string
    Value   float64
    Max     float64 // if 0, uses the slice max
    Sparkline []float64 // optional
}

type BarRowOpts struct {
    Width int    // default 100 (%)
    BarHeight int // default 24
}

func BarRows(bars []Bar, opts BarRowOpts) template.HTML
```

### Visual

```
Read     ████████████████████  234   ▁▂▃▅█▇▅▃
Bash     ██████████             102   ▁▂▂▃▄▃▂▁
Edit     ████                    48
```

- Label on the left, 100 px fixed, truncated with ellipsis;
- Bar in the center, flex, height 24 px, fill `--accent`, background
  `--bg-elev-2`;
- Value on the right, mono tabular, 80 px right-aligned;
- Optional sparkline (top-N only), 80 × 20 px after the value.

---

## Donut

**Landed** in `internal/panel/charts/donut.go`. Used by the Home
"Tokens & cost per model" card for cost share. For percentual
distribution (models, agents).

### Signature

```go
type Slice struct {
    Label string
    Value float64
}

type DonutOpts struct {
    Size        int    // square viewBox edge, default 180
    Class       string // root element class, default "donut"
    CenterLabel string // big text in the hole (e.g. "$12.34")
    CenterSub   string // small text under it (e.g. "spend")
    UnitSuffix  string // appended to each slice value in its <title>
}

func Donut(slices []Slice, opts DonutOpts) template.HTML

// PaletteColor returns the segment color for index i, so a legend
// rendered outside the SVG matches the segments.
func PaletteColor(i int) string
```

### Visual

- 180 × 180 viewBox (CSS sizes it; the card renders it at 160 px);
- Drawn as a thick stroked circle with `stroke-dasharray` segments over
  a `--bg-elev-2` track ring — deterministic, no arc-path rounding;
- Center carries `CenterLabel` (total) + `CenterSub`;
- Slices cycle accent→text-3 tones via `PaletteColor` (token-based);
- Each segment carries a `<title>` (`label: value (pct%)`);
- Determinism: same input → byte-identical SVG (golden-tested).

---

## Heatmap

Daily contribution heatmap: one cell per UTC day across the trailing
**53 weeks** (52 prior weeks plus the current one), aligned to Sunday.
The window is fixed — the component does not take a window argument and
the analytics page hides its window chips on this report.

### Signature

```go
type HeatmapOpts struct {
    CellSize int // default 16
    Gap      int // default 2
    MaxScale float64 // optional, default = grid max
}

func Heatmap(days []HeatmapDay, opts HeatmapOpts) template.HTML
```

### Visual

- Cell `<rect>` 16 × 16 with fill derived from `--accent` and surface tokens,
  proportional to `value/max`;
- Cells with value 0 use the quiet surface token;
- `<title>` on each cell: "2026-05-23: 5 sessions";
- Grid flows by week with 7 day rows, GitHub-style;
- Discreet legend: 5 example cells from the scale + "less" and "more"
  in `--text-3`.

---

## Area chart

**Landed** in `internal/panel/charts/area.go` (the deferred "trend"
sketch, card-sized). Used by the Home "Hour of day" card.

### Signature

```go
type Point struct {
    Label string
    Value float64
}

type AreaOpts struct {
    Width      int    // viewBox width, default 520
    Height     int    // viewBox height, default 140
    Class      string // root element class, default "area-chart"
    UnitSuffix string // appended to each point value in its <title>
    PeakColor  string // peak marker fill, default "var(--accent)"
}

func Area(points []Point, opts AreaOpts) template.HTML
```

### Visual

- Line in `currentColor` (the card sets it to `--accent` via CSS);
- Soft fill below the line in `--accent-soft`;
- The peak point gets a highlighted `<circle>` with a `<title>`;
- Empty input renders an empty canvas; all-zero values render a flat
  baseline (no peak marker);
- Determinism: same input → byte-identical SVG (golden-tested).

---

## Stacked columns

**Landed** in `internal/panel/charts/stacked.go`. Used by the Home
"Activity trend" card (series per agent), the Insights "Spend &
tokens" card (single series + cumulative `Overlay`), and the Insights
"Model share" card (`Normalize`).

### Signature

```go
type Series struct {
    Name   string
    Values []float64 // one per label; missing trailing values are zero
}

type StackedOpts struct {
    Width         int       // viewBox width, default 520
    Height        int       // viewBox height, default 140
    Class         string    // root element class, default "stacked-chart"
    UnitSuffix    string    // appended to each segment value in its <title>
    Normalize     bool      // scale every column to 100% (share view)
    Overlay       []float64 // optional line on its own max-scale
    OverlaySuffix string    // appended to the overlay end-marker <title>
}

func StackedColumns(labels []string, series []Series, opts StackedOpts) template.HTML
```

### Visual

- One column per label, stacked `<rect>` segments bottom-up, one per
  series;
- Segment color comes from `PaletteColor(seriesIndex)` — an HTML legend
  rendered beside the chart matches by index (same pattern as the donut
  cost legend);
- Each segment carries `<title>label · name: value</title>`; with
  `Normalize`, the title appends the column share (`(80%)`);
- `Overlay` draws a `--accent` polyline scaled to its own max with an
  end-marker circle (used for cumulative spend);
- Non-positive values render no rect; empty labels render an empty
  canvas;
- Determinism: same input → byte-identical SVG (golden-tested).

---

## Punch card

**Landed** as an HTML grid in `insights.html` (no SVG — same approach
as the heatmap). 7 weekday rows × 24 local-hour columns of
`heatmap-cell level-N` spans, so it inherits the heatmap's 5-level
`--accent` color scale for free. A small hour axis (00h … 23h) sits on
top; each cell carries `title`/`aria-label`
`"<weekday> <hour>h: N sessions"`. Data is the `punchcard` report (UTC)
rotated into the panel's local zone with weekday carry across midnight.

---

## Filter pill

Clickable chip with an Alpine dropdown + HTMX swap.

```html
<div class="filter-pill"
     x-data="{ open: false }"
     @click.outside="open = false">
  <button class="filter-pill-button"
          @click="open = !open"
          :class="{ active: open }">
    <span class="filter-pill-label">{{ .Label }}</span>
    <span class="filter-pill-value">{{ .Value }}</span>
    <span class="filter-pill-caret">▾</span>
  </button>

  <ul class="filter-pill-menu" x-show="open" x-transition>
    {{ range .Options }}
      <li>
        <a hx-get="{{ .URL }}"
           hx-target="#recent"
           hx-push-url="true"
           @click="open = false">
          {{ .Label }}
        </a>
      </li>
    {{ end }}
  </ul>
</div>
```

### Visual

```
[ 7d ▾ ]   [ all agents ▾ ]   [ all devices ▾ ]   [ all projects ▾ ]
```

- Chip: padding 8 px 16 px, radius `--radius-sm`, background
  `--bg-elev-1`;
- Hover: background `--bg-elev-2`;
- Open: background `--accent` with 20% alpha, 1 px border `--accent`;
- Dropdown menu: card `--bg-elev-2`, padding 8 px, gap 4 px between
  options;
- Selection triggers `hx-get` only on the affected block (Recent or
  chart).

---

## Multi-select dropdown

Vanilla-JS multi-pick used in the Home filters block and the Sessions
filter row for agent / project / device. Same `.dropdown`,
`.dropdown-menu`, and checkbox-list markup that the old analytics page
already ships in its templates; reused as-is on the new pages.

```html
<div class="dropdown" data-multi="agent">
  <button class="dropdown-button" type="button">
    <span class="dropdown-label">agent</span>
    <span class="dropdown-value">{{ summarize .Selected }}</span>
    <span class="dropdown-caret">▾</span>
  </button>

  <div class="dropdown-menu" hidden>
    {{ range .Options }}
      <label class="dropdown-item">
        <input type="checkbox" name="agent" value="{{ .Value }}"
               {{ if .Checked }}checked{{ end }}>
        <span>{{ .Label }}</span>
      </label>
    {{ end }}
  </div>
</div>
```

### Behavior

- The dropdown lives inside the page's GET form. Submitting the form
  posts the selection as repeated `?key=value&key=value` params; the
  server folds them back into a slice via small helpers in
  `widgets.js`-shaped Go code (`pickDeviceNames`-style: read all values
  for the key, normalize, deduplicate).
- The label collapses to "N values" when more than one is checked, and
  to "all" or the single value otherwise.
- Open/close is a vanilla toggle from `widgets.js` (no Alpine
  required), `@click.outside`-equivalent closes the menu.

### Visual

- Button matches the filter-pill chip shape so the row reads as one
  family of controls;
- Menu width tracks the longest option, capped at 320 px;
- Each item is `<label>` + `<input type="checkbox">` so the whole row
  is the hit target;
- Selection state is checkbox-native — no separate "selected" CSS class
  to keep in sync.

### Where it lives

Home filters block (`<details>`) and Sessions filter row both reuse
this pattern. The window picker stays single-select (a plain `<select>`
or a chip) — multi-window is meaningless.

---

## Column chooser

Used on the Sessions page to toggle the visible columns. A **columns**
dropdown button (same `.dropdown` pattern as agent/project/device) holds
the checkbox form; no always-open `<details>` row.

```html
<div class="dropdown dropdown-columns">
  <button type="button" class="dropdown-toggle">columns ▾</button>
  <div class="dropdown-menu dropdown-menu-wide" hidden>
  <form method="get" action="/sessions">
    {{ /* Preserve every other filter so submission only changes cols. */ }}
    <input type="hidden" name="q"       value="{{ .Q }}">
    <input type="hidden" name="last"    value="{{ .Last }}">
    {{ range .Agents }}<input type="hidden" name="agent"   value="{{ . }}">{{ end }}
    {{ range .Projects }}<input type="hidden" name="project" value="{{ . }}">{{ end }}
    {{ range .Devices }}<input type="hidden" name="device"  value="{{ . }}">{{ end }}
    <input type="hidden" name="sort"    value="{{ .Sort }}">
    <input type="hidden" name="page"    value="{{ .Page }}">

    {{ range .Columns }}
      <label>
        <input type="checkbox" name="cols" value="{{ .Key }}"
               {{ if .Enabled }}checked{{ end }}>
        {{ .Label }}
      </label>
    {{ end }}

    <button type="submit">Apply</button>
  </form>
  </div>
</div>
```

### Behavior

- The 7 column keys are `agent`, `project`, `first_prompt`, `tokens`,
  `cost`, `device`, `id`. Default-enabled set is everything except
  `id` when `?cols` is missing from the request.
- Submitting the form rewrites `?cols=agent,project,first_prompt,...`
  and reloads the page. State is shareable via URL like every other
  filter.
- The `<details>` element is native and accessible; collapsed by
  default so it never crowds the table.

### Visual

- The summary line uses the same chip styling as the dropdown buttons
  so the row reads consistently;
- Checkbox list inside is one row per column, label after the box;
- No JS required — submit handles everything.

---

## Command palette

Global `Cmd-K` modal. `<dialog>` + Alpine.

```html
<dialog id="palette"
        x-data="palette()"
        @keydown.window.meta.k.prevent="open()"
        @keydown.window.ctrl.k.prevent="open()"
        @keydown.escape="close()">
  <input type="text"
         placeholder="/ search anything"
         hx-get="/palette/search"
         hx-trigger="keyup changed delay:200ms"
         hx-target="#palette-results" />

  <div id="palette-results">
    {{ template "palette_default" . }}
  </div>
</dialog>
```

### Visual

- 560 px wide, height up to 70 vh;
- Backdrop `rgba(0,0,0,0.6)` + `backdrop-filter: blur(8px)`;
- Card `--bg-elev-1`, radius `--radius-lg`, padding 24 px, shadow
  `--elev-3`;
- Input full-width, no border, font-size 18 px;
- Results in sections: Recent, Reports, Devices.

### Internal shortcuts

- Arrow keys: move focus;
- `Enter`: open item;
- `Esc`: close;
- `Tab`: cycle between input and results.

---

## HTMX chart swap

Chart pattern with querystring filters, no full reload.

```html
<div id="report-chart"
     hx-get="/analytics/sessions/chart"
     hx-trigger="filter-changed from:body"
     hx-include="[name='window'], [name='agent']">
  {{ .Chart }}
</div>
```

Filter pills fire `htmx.trigger('body', 'filter-changed')` when their
value changes. The chart swaps itself based on the current filters.

Swap takes < 200 ms locally. No skeleton, no visible loading state.

---

## Live dot

Active-session indicator.

```html
<span class="live-dot" title="active session within last 10 min"></span>
```

```css
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--ok);
  display: inline-block;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

@media (prefers-reduced-motion: reduce) {
  .live-dot { animation: none; }
}
```

Always accompanied by a 12 px "live" text label next to it for
accessibility.

---

## Bubble (chat)

Chat-style row in the sidepanel transcript. Lives in
`internal/panel/assets/css/components/bubbles.css` as `.bubble` +
role-specific variants `.bubble-user`, `.bubble-assistant`,
`.bubble-tool`.

```
ASSISTANT                                              09:14:32
The transcript today renders as `.turn-{role}` cards in
monospace — this is what F2 replaces.

                                            USER       09:14:08
                                  +---------------------------+
                                  | Aperfeiçoe o frontend.    |
                                  +---------------------------+

TOOL  Read                                             09:14:35
+------------------------------------------------------------+
| internal/panel/templates/side_panel.html                   |
+------------------------------------------------------------+
```

- **User** bubble: right-aligned (`align-self: flex-end`), filled
  surface `--bg-elev-2`, `--radius-md` with a slightly tighter
  bottom-right corner, body in `--font-sans`. Content is escaped plain
  text — `<br>` for newlines, no markdown rendering (a literal
  `**stars**` stays literal).
- **Assistant** bubble: left-aligned, no surface, body is markdown
  rendered with goldmark (GFM extension). Prose styles for `h*`,
  `p`, `ul/ol`, `code` (inline + fenced), `blockquote`, `a`, `table`,
  `hr`. Code fences keep `class="language-*"` for downstream
  highlighting.
- **Tool** bubble: full-width discrete block, `--bg-elev-1` surface
  with a 2 px `--accent-soft` left rule, body in `--font-mono`,
  `max-height: 400px` with internal scroll. F3 coalesces consecutive
  tool bubbles into a collapsible group with a one-line summary.
- **Meta header** (`.bubble-meta`): tiny role label uppercase
  `--text-3`, tool name in mono `--accent` when role is `tool`,
  timestamp right-aligned in mono `--text-3`. The whole header
  reverses to row-reverse on user bubbles so the timestamp sits on
  the same edge as the body.

Body content is pre-rendered server-side as `template.HTML` by
`internal/panel/render`: `render.Markdown(s)` for assistant,
`render.PlainText(s)` for user and tool. The renderer disables
`WithUnsafe` and goldmark either escapes or omits raw HTML, so a
literal `<script>` from a model response can never reach the DOM as
markup.

---

## Tool group (sidepanel)

When the transcript has ≥1 consecutive `Role="tool"` turns,
`internal/panel/render.GroupTurns` coalesces them into one
`TurnGroup{Kind:"tool-group"}`. The sidepanel renders it as a
collapsible block instead of N separate `.bubble-tool` cards.

```
┌─ ▸ Read ×3 · Bash ×1 · WebSearch ×1            5 calls ──┐
│   (collapsed by default; Alpine toggle on the header)    │
└──────────────────────────────────────────────────────────┘

when open:

┌─ ▾ Read ×3 · Bash ×1 · WebSearch ×1            5 calls ──┐
│   ┌─ ▸ Read                       09:14:08 ────────────┐ │
│   ├─ ▸ Read                       09:14:12 ────────────┤ │
│   ├─ ▸ Read                       09:14:15 ────────────┤ │
│   ├─ ▸ Bash                       09:14:18 ────────────┤ │
│   └─ ▸ WebSearch                  09:14:24 ────────────┘ │
└──────────────────────────────────────────────────────────┘
```

- **Outer toggle** uses Alpine `x-data="{open:false}"` +
  `x-collapse` so opening animates the entries in smoothly. Header
  is a `<button>` with `aria-expanded` bound to `open`, so the
  control is accessible to screen readers and keyboard.
- **Summary** is built server-side by `render.GroupTurns` —
  `"Read ×3 · Bash ×1"`. Order is invocation count descending, then
  name ascending. Empty `ToolName` falls into a generic `tool`
  bucket so nothing disappears.
- **Count** chip (`Ncall(s)`) on the right reflects the total
  invocations in the run.
- **Entries** are native `<details>` per tool result. The Alpine
  scope only wraps the outer block; native disclosure handles each
  entry independently. Each entry's body is the truncated tool
  output (server already capped at ~4 KB / 40 lines in the
  importer), monospace, `max-height: 400px` with internal scroll.

Lives in `internal/panel/assets/css/components/tool-group.css`.

---

## Subagents (sidepanel)

Surfaces children of the current session. Populated when
`Sessions.ListChildren(parent_id)` returns ≥1 row — Claude Code's
subagent JSONLs and Codex `thread_spawn` children both feed it.

```
SUBAGENTS · 3
┌──────────────────────────────────────────────┐
│ claude-code                       09:18:22   │
│ refactor sync module to use channels         │
└──────────────────────────────────────────────┘
┌──────────────────────────────────────────────┐
│ claude-code                       09:19:01   │
│ write tests for the new channel-based sync   │
└──────────────────────────────────────────────┘
```

- Each card is an `<a>` with `hx-get="/sessions/<child-id>"` +
  `hx-target="#side-panel"` + `hx-push-url="?session=<child-id>"`,
  so clicking it HTMX-swaps the sidepanel to the child without
  losing the URL state.
- The link has an `href` fallback (the same `?session=<id>` URL)
  for keyboard users and browsers that lose HTMX mid-flight.
- Visual: `--bg-elev-1` surface with `--divider` border; hover
  lifts to `--bg-elev-2` and borders to `--accent-soft`. First
  prompt clamped to 2 lines with `-webkit-line-clamp`.

Lives in `internal/panel/assets/css/components/subagents.css`.

---

## Thinking block (sidepanel)

Coalesced run of `Kind="thinking"` turns from the canonical session.
Projection v7+ persists Claude Code's `content[].type=="thinking"`
blocks and Codex's `response_item.type=="reasoning"` `.summary` as
`Turn{Role:"assistant", Kind:KindThinking, Content:<truncated>}`;
the panel collapses consecutive ones into a single discreet card.

```
─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
  ▸ Processed (3 steps)
─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
```

- **Summary** is "Processed" for a single step, "Processed (N steps)"
  otherwise. Short, plain, doesn't pull focus.
- **Visual** uses dashed `--divider` rules above and below, italic
  summary in `--text-3` — the block reads as "context, not content"
  so the eye skips it on first scan.
- **Toggle** is Alpine `x-data="{open:false}"` + `x-collapse` so
  opening animates the entries in. Header is a `<button>` with
  `aria-expanded` for accessibility.
- **Body** of each step is shown as italic prose with a left rule,
  monospace-free — reasoning reads as continuous thought, not as
  log output.

Lives in `internal/panel/assets/css/components/thinking.css`.

---

## Stats cluster (sidepanel)

Mini-KPIs in a 2 × 3 grid inside the sidepanel (six cells: turns,
tools, duration, model, tokens total, estimated cost). Lives in
`internal/panel/assets/css/components/sidepanel.css` as
`.stats-cluster` plus `.stat-kpi` (with `.stat-value`,
`.stat-label`).

```
+-------+-------+
| 18    | 3     |
| TURNS | TOOLS |
+-------+-------+
| 18min | opus  |
| DURAT.| MODEL |
+-------+-------+
```

- Numbers at `--text-lg` (22 px) tabular, `--w-regular`;
- Labels at `--text-xs` (12 px) uppercase letter-spacing 0.06em
  `--text-3`;
- Model variant uses `--font-mono` at `--text-base` so long names like
  `claude-sonnet-4-6-20251022` stay readable without wrapping;
- Internal gap `--space-4 --space-5`, plus `--space-6` padding-bottom
  and a 1 px `--divider` rule under the cluster.

Values are derived server-side in `loadSidePanel`: `TurnsCount`
(user + assistant message rows, excluding `tool_result`/`operational`),
`ToolsCount` (sum of `Session.Tools[].Count`), `DurationLabel`
(`humanDuration(LastActivityAt − StartedAt)`), the model name from
`Session.Model`, token totals from `Session.Usage`, and `Cost` from
`pricing.CostUSD`. The metadata block also lists tokens in/out/total
and renders **Project** via `projectLink` (GitHub/GitLab
`owner/repo` when the remote is recognized).
