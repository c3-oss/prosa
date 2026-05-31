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
- **with delta** — value + label + delta vs previous period (`+12%` in
  `--ok`, `-4%` in `--danger`).

---

## Sparkline

Server-side, in `internal/panel/charts/sparkline.go`. Returns
`template.HTML` with inline SVG.

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

For percentual distribution (models, agents).

### Signature

```go
type Slice struct {
    Label string
    Value float64
    Color string // optional, defaults to cycling accent tones
}

func Donut(slices []Slice, opts DonutOpts) template.HTML
```

### Visual

- 180 × 180 px;
- Inner hole 50% (radius 45);
- Total at the center (28 px tabular);
- Slices in gradient tones: `--accent`, mix(`--accent`, `--text-3`, 30%),
  `--text-3`, `--text-3` with alpha 0.5;
- Slice hover: increases stroke-width via CSS.

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

## Trend line

Featured chart of Analytics: sessions, errors.

### Signature

```go
type Point struct {
    Label string
    Value float64
}

type TrendOpts struct {
    Width  int    // default 800
    Height int    // default 280
    Color  string // default currentColor
    FillSoft bool // if true, fills below the line with alpha
}

func Trend(points []Point, opts TrendOpts) template.HTML
```

### Visual

- Line in `currentColor` (controllable via CSS per context);
- Fill below in `--accent-soft` when `FillSoft`;
- Discreet Y axis: 3–4 horizontal ticks, 1 px `--divider`;
- X axis: date labels every 5 points;
- Visible points as `<circle r=2>` at each Point;
- Hover on a point: enlarged + `<title>`.

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

## Stats cluster (sidepanel)

Mini-KPIs in a 2 × 2 grid inside the sidepanel.

```
+-------+-------+
| 18    | 3     |
| turns | tools |
+-------+-------+
| 18min | sonnet|
|       | 4-6   |
+-------+-------+
```

- Numbers at 22 px tabular;
- Labels at 12 px uppercase `--text-3`;
- Internal gap 16 px, padding 24 px;
- No border; a central 1 px `--divider` separator if needed.
