# Mock prompts: prosa-panel

A collection of ready-to-use prompts for generating visual mocks of the
panel with AI before coding. Copy, paste, adjust, see the result.

## How to use

Each prompt is self-contained: it doesn't depend on you having shared
the other docs with the AI. You can use it in isolation.

The prompts are grouped by **tool type**:

- **HTML artifact** (Claude artifacts, ChatGPT canvas, v0.dev): produces
  working HTML + CSS that you open in a browser.
- **Raster image** (Midjourney, DALL-E, Stable Diffusion, Imagen):
  produces a static UI mockup image.
- **Interactive prototype** (Lovable, Bolt, v0.dev full mode): produces
  a real navigable app.

Each prompt is wrapped between `--- PROMPT ---` and `--- END ---`. Copy
the content between the markers. Adjust project name, sample data, or
tone if you want.

## A note about the sample data

The prompts use fictitious data that is consistent with `prosa`:

- agents: `claude-code`, `codex`, `cursor`, `gemini`, `antigravity`, `hermes`;
- models: `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`,
  `gpt-5-codex`;
- projects: `prosa`, `mz-iac`, `brain`, `c3-oss`;
- devices: `laptop-caian`, `mz-server`, `old-desktop`;
- tools: `Read`, `Bash`, `Edit`, `Glob`, `Grep`, `Write`.

Feel free to swap any of these.

---

## 1. Mood board (palette + typography + scale)

**Type**: HTML artifact (Claude, ChatGPT, v0).
**Why**: validate the palette and typography in isolation before applying
them on real screens.

--- PROMPT ---

Build a single HTML page that documents the visual design system for a web panel called "prosa". This is a personal analytics dashboard with an airy, contemplative aesthetic. Dark theme only.

Show in this order, in a single column max-width 720px, generous vertical spacing (64px between sections):

1. **Logo & tagline**: "prosa" in 36px weight 200, subtitle "your first screen of the day" in 14px text-tertiary.

2. **Color palette** — for each token, show a 56x56 swatch + label + hex value + usage note:
   - --bg #0f1117 (page background)
   - --bg-elev-1 #1a1d27 (topbar, sidebar, cards)
   - --bg-elev-2 #232733 (hover, inputs)
   - --text-1 #e8eaf0 (primary text)
   - --text-2 #aab0bf (secondary text)
   - --text-3 #6b7186 (tertiary text)
   - --accent #6b7afc (links, charts, active)
   - --accent-soft #6b7afc33 (chart fills)
   - --ok #4ade80 (live, success)
   - --danger #f04a5c (errors)

3. **Type scale** — show each at its actual size with the label "xs 12px", "sm 14px", etc. Sample text "Sessions analyzed today". Sizes: 12, 14, 16, 18, 22, 28, 36, 44. Font: system-ui. Weight 300 for the 44px sample, 400 for others. All numbers must use `font-variant-numeric: tabular-nums`.

4. **Spacing scale** — horizontal bars of varying width labeled "space-1 4px" through "space-8 64px". Color: --accent-soft.

5. **A sample KPI card** in a centered container — number "12" at 44px weight 300, label "sessions" at 12px uppercase letter-spacing 0.06em --text-3, and a fake SVG sparkline (80x24, line in --accent, soft fill).

The aesthetic: minimal, airy, lots of breathing room, hierarchy by size not by borders. No card shadows, no gradients, only thin 1px dividers in --bg-elev-2 where structure is needed. No icons. No emojis.

Render real CSS variables in `:root`. Apply `font-variant-numeric: tabular-nums` globally on body.

--- END ---

---

## 2. Home: Today + Recent (full screen)

**Type**: HTML artifact.
**Why**: see the panel's main screen in real proportion.

--- PROMPT ---

Build a single HTML page mocking the home screen of a personal analytics dashboard called "prosa". Dark theme. Window size 1440x900.

Layout:

- Top bar (56px high, full width, background #1a1d27, 1px bottom border #232733): on the left, "prosa" in 18px weight 500. On the right (right-aligned with 24px padding): a small placeholder for "12 today" in a subtle chip, and "logout" link in 14px text-tertiary.
- Below: split into sidebar (220px wide, background #1a1d27) and main content (rest of width, background #0f1117).
- Sidebar: vertical list with 32px padding-top, items "Home" (active, with a 4px #6b7afc dot before the name), "Devices", "Analytics". 14px weight 500, item height 40px, indented 24px from left.

Main content has 48px padding all around. Two stacked sections:

**SECTION 1: Today**

Header "Today" at 28px weight 400, with a small live indicator on the right (8px green dot #4ade80 pulsing + "live" label in 12px text-tertiary).

Below, 64px gap between KPIs, three KPIs side by side, each:
- Number on top: large, 44px, weight 300, color #e8eaf0, tabular-nums.
- Label below: 12px uppercase letter-spacing 0.06em, color #6b7186.
- KPI 1: "12 / sessions"
- KPI 2: "3 / projects"
- KPI 3: "2 / active models"

Below the KPIs, centered, a sparkline SVG (320x48): hand-craft a smooth line going up-down over 14 points. Line: 1.5px stroke #6b7afc. Fill below: #6b7afc with opacity 0.2. Subtle. Above the line, 14 small circles at each point, radius 1.5, fill #6b7afc.

Add 64px vertical space.

**SECTION 2: Filter pills + Recent**

Row of 4 filter pills: "7d ▾", "all agents ▾", "all devices ▾", "all projects ▾". Each pill: padding 8px 16px, background #1a1d27, radius 4px, font 14px text-1. Gap 12px between pills.

Add 32px vertical space.

Header "Recent" at 22px weight 400, color #e8eaf0.

Below, day groupings. Each group has a subheader (16px weight 500 #e8eaf0, with date in #6b7186 right beside).

Render two groups with realistic content:

**Today** (subheader "Today · 2026-05-30")
- 09:14  claude-code   prosa       "refactor sync logic"     18 min
- 11:02  codex         mz-iac      "setup terraform vpc"     32 min
- 14:22* claude-code   prosa       "tests for sqlite store"  47 min   (the asterisk on the timestamp means active; color #4ade80)

**Yesterday** (subheader "Yesterday · 2026-05-29")
- 16:40  claude-code   brain       "audit obsidian vault"     4 min
- 14:22  codex         prosa       "tests for sqlite store"  47 min
- 09:55  cursor        c3-oss      "investigate connect rpc" 23 min

Each row: 56px tall, columns aligned in a grid:
- timestamp 70px wide, monospace, 13px, #6b7186
- agent 110px wide, 14px, #aab0bf
- project 140px wide, 14px weight 500, #e8eaf0
- first_prompt flex, 14px, #e8eaf0
- duration 70px right-aligned, 13px tabular, #aab0bf

Hover state: background #232733. Cursor pointer.

Between rows, 1px divider in #232733.

Whole page: font-family system-ui. tabular-nums everywhere there's a number. Generous breathing room. No shadows, no gradients, no icons, no emojis.

--- END ---

---

## 3. Today KPI card, isolated

**Type**: HTML artifact.
**Why**: study the KPI card as a component, variants side by side.

--- PROMPT ---

Build a single HTML page showing 4 variants of a KPI card side by side, on a dark background (#0f1117). Each card occupies max 240px wide. Gap between cards 64px. Center the row horizontally.

Each card has NO border, NO background, NO shadow — only typography and breathing space.

Variants:

1. **Plain**: Number "12" (44px weight 300 #e8eaf0 tabular-nums), below it "sessions" (12px uppercase letter-spacing 0.06em #6b7186).

2. **With sparkline**: Same as plain, then below the label, an 80x24 SVG sparkline going up-down over 8 points. Line stroke 1.5px #6b7afc, fill below in #6b7afc opacity 0.2.

3. **With delta**: "12" + "sessions" + a small line "+33% vs last week" in 12px #4ade80.

4. **Live**: Same as plain, but a pulsing green dot (8px, #4ade80, animation pulse 2s infinite) appears to the right of the number, vertically centered. Add subtle 12px label "live" in #6b7186 next to the dot.

Use system-ui font. Apply font-variant-numeric: tabular-nums globally. 64px padding on the body. CSS animation for the pulse:

```
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
```

The KPIs should feel airy and quiet, like museum captions.

--- END ---

---

## 4. Filter pills (states)

**Type**: HTML artifact.
**Why**: see the component's states on a single screen.

--- PROMPT ---

Build a single HTML page on dark background (#0f1117) showing the states of a "filter pill" component, used in a web dashboard.

Layout: 3 rows, each row labeled with the state name in 14px #6b7186, followed by 4 pills.

**Row 1: default**
- "7d ▾"
- "all agents ▾"
- "all devices ▾"
- "all projects ▾"

**Row 2: hover (apply hover style permanently for display)**
Same labels, but background slightly lighter.

**Row 3: open (apply open style permanently)**
Same labels, with the first pill showing its dropdown open below it.

Pill styling:
- Padding 8px 16px;
- Radius 4px;
- Font 14px system-ui, color #e8eaf0;
- Default background: #1a1d27;
- Hover background: #232733;
- Open background: rgba(107, 122, 252, 0.15), 1px border #6b7afc;
- Caret "▾" 12px #6b7186 to the right of label.

Dropdown (shown on the open pill in row 3):
- Background #232733;
- Radius 8px;
- Margin-top 8px below pill;
- Width 200px;
- Padding 8px;
- 5 options as rows: "today", "7d", "14d", "30d", "all time", each 36px tall, 14px, padding 12px. First option ("7d") highlighted with #6b7afc text and a "✓" prefix.

Gap 12px between pills horizontally. Gap 48px between rows vertically.

Page padding 64px. Font-family system-ui. No icons, no emojis.

--- END ---

---

## 5. Analytics — sessions report (trend line)

**Type**: HTML artifact.
**Why**: validate the analytics layout with a large featured chart.

--- PROMPT ---

Build a single HTML page mocking an analytics report for a dashboard called "prosa". Dark theme (#0f1117). Window size 1440x900.

Structure:
- Topbar 56px (same as home: "prosa" left, "logout" right, background #1a1d27, 1px bottom border #232733).
- Sidebar 220px wide background #1a1d27, vertical nav: "Home", "Devices", "Analytics" (active dot on Analytics).
- Below the Analytics sidebar item, an indented sub-nav (24px more indent) with: "sessions" (active, dot prefix), "projects", "tools", "models", "errors", "heatmap". 13px text-2.
- Main content: 48px padding.

Main content:

1. Title "sessions" at 28px weight 400 #e8eaf0. Margin-bottom 24px.

2. Filter pills row: "30d ▾", "all agents ▾", "all devices ▾", "all projects ▾". 12px gap. Margin-bottom 32px.

3. **Featured chart card**: background #1a1d27, radius 8px, padding 32px, full width.
   - Inside: header line with "sessions/day" 16px weight 500 #e8eaf0 left, and "last 30 days" 13px #6b7186 right.
   - Below, an SVG line chart, 100% width, 280px tall:
     - Render a believable trend over 30 daily data points (values bouncing between 2 and 18, with realistic noise);
     - X axis labels at days 1, 5, 10, 15, 20, 25, 30 (small 11px #6b7186);
     - Y axis: 4 horizontal grid lines in #232733 (very subtle), labels 0, 5, 10, 15 in 11px #6b7186 to the left;
     - Line: stroke 2px #6b7afc;
     - Area fill below the line: #6b7afc opacity 0.15;
     - Points: circle r=2.5 #6b7afc at each daily value;
     - Last point larger (r=4) to emphasize today.

4. Below the chart, 48px vertical space, then a table "by agent":
   - Header row: AGENT | SESSIONS | TURNS — 12px uppercase letter-spacing 0.06em #6b7186, padding 12px 16px.
   - Body rows 40px tall:
     - claude-code | 142 | 1834
     - codex      |  87 |  642
     - cursor     |  21 |  118
     - gemini     |   4 |   29
   - Numbers right-aligned, tabular-nums;
   - 1px dividers in #232733 between rows.

Font: system-ui. Tabular-nums globally. No icons. No emojis.

--- END ---

---

## 6. Analytics — tools leaderboard

**Type**: HTML artifact.
**Why**: validate the leaderboard with horizontal bars + top-N
sparklines.

--- PROMPT ---

Build a single HTML page mocking a tools-usage leaderboard for an analytics dashboard "prosa". Dark theme #0f1117. Window 1440x900.

Header structure same as previous (topbar + sidebar with analytics expanded, "tools" active). Main content padding 48px.

1. Title "tools" 28px weight 400.

2. Filter pills (same row as previous): "30d ▾", "all agents ▾", "all devices ▾", "all projects ▾".

3. Featured card (background #1a1d27, radius 8px, padding 32px):
   - Subheader "top 20 by invocations" 16px weight 500 #e8eaf0.
   - Below, 20 rows, each 36px tall, gap 8px between rows. Each row a grid:
     - Tool name: 100px wide, 14px weight 500 #e8eaf0, left aligned.
     - Bar: flex (takes remaining minus reserved), height 24px, background #232733, with an inner fill #6b7afc. Width of fill proportional to value (largest = 100%).
     - Value: 80px wide right-aligned, 13px mono tabular #aab0bf.
     - Sparkline column (only for top 5 rows): 80x20 SVG inline AFTER the value. Line #6b7afc, fill #6b7afc soft.

Use these data:

  Read     234 (sparkline trend up)
  Bash     180
  Edit     142
  Glob      98
  Grep      87
  Write     72 (no sparkline)
  Task      54
  WebFetch  48
  Curl      41
  TodoWrite 33
  ...continue with 10 more believable tool names with decreasing values

Below the card, a small table caption "all tool invocations across the selected window" in 12px #6b7186.

System-ui font. Tabular-nums. No icons. No emojis.

--- END ---

---

## 7. Analytics — models donut

**Type**: HTML artifact.
**Why**: see the donut + side list arranged together.

--- PROMPT ---

Build a single HTML page mocking a models distribution report for analytics dashboard "prosa". Dark theme #0f1117. Window 1440x900.

Header (topbar + sidebar, models active). Main padding 48px.

1. Title "models" 28px weight 400.
2. Filter pills row: "30d ▾", "all agents ▾", "all devices ▾", "all projects ▾".

3. Featured card (background #1a1d27, radius 8px, padding 32px):
   - Subheader "distribution over last 30 days" 16px weight 500.
   - Below: two-column layout with 64px gap.

   **Left column (320px wide)**: an SVG donut chart 240x240 centered.
     - Slices in order:
       - claude-sonnet-4-6 — 87% — color #6b7afc;
       - claude-opus-4-7 — 11% — color #6b7afc with opacity 0.5;
       - claude-haiku-4-5 — 2% — color #6b7186;
     - Hole 50% (inner radius 60, outer radius 120);
     - In the center hole, a big "147" in 28px tabular weight 400 #e8eaf0, label "total sessions" 11px #6b7186 below.

   **Right column (flex)**: list of slices, each row:
     - Color dot (10px circle of slice color);
     - Model name (14px weight 500 #e8eaf0);
     - Percent (14px tabular #aab0bf right-aligned);
     - Bar fill below (full row width, 4px height, color = slice color, background #232733).
     - Vertical gap 24px between models.

System-ui. Tabular-nums. No icons. No emojis.

--- END ---

---

## 8. Analytics — heatmap (calendar 30d × 24h)

**Type**: HTML artifact.
**Why**: validate readability of the more complex heatmap.

--- PROMPT ---

Build a single HTML page mocking a calendar heatmap report for "prosa" analytics dashboard. Dark theme #0f1117. Window 1440x900.

Header (topbar + sidebar, heatmap active). Main padding 48px.

1. Title "heatmap" 28px weight 400. Margin-bottom 8px.
2. Subtitle "activity by hour of day, last 30 days" 14px #6b7186. Margin-bottom 24px.
3. Filter pills row (same as previous).

4. Featured card (background #1a1d27, radius 8px, padding 40px):
   - Inside, an SVG calendar heatmap:
     - 30 rows (days), 24 columns (hours);
     - Cell size 16x16px, gap 3px;
     - Each cell is a rect with fill #6b7afc and opacity proportional to a fake count (range 0..1);
     - Empty cells (count 0): opacity 0.06 (faint but visible);
     - Hover-style: 1px white outline (you can apply to a few cells statically as if hovered).
   - Pattern guidance for the fake data:
     - Most activity between 9h and 18h on weekdays;
     - Weekends sparser, with some scattered evening activity (20-23h);
     - A few "intense" cells (full opacity 1.0) around midday on a few days;
     - Mornings (00-07h) almost all opacity 0.06.
   - Row labels (left): only the first day of each ISO week, 11px #6b7186 mono, format "May 5" / "May 12" etc.
   - Column labels (above): every 2 hours: 00, 02, 04, ..., 22. 11px #6b7186 mono.

5. Below the heatmap: legend horizontal row centered:
   - Text "less" 12px #6b7186;
   - 5 example cells showing the opacity scale: 0.06, 0.25, 0.5, 0.75, 1.0;
   - Text "more" 12px #6b7186;
   - Gap 8px between cells.

6. Below legend: small caption "each cell represents the number of sessions started in that hour" 12px #6b7186.

Font system-ui, mono on labels and numbers. Tabular-nums. No icons. No emojis.

--- END ---

---

## 9. Sidepanel (session detail), open

**Type**: HTML artifact.
**Why**: validate readability when the sidepanel takes half of the right
side and the transcript reads as chat.

--- PROMPT ---

Build a single HTML page mocking a web dashboard with a side panel open on the right showing session detail. Dark theme #0f1117. Window 1440x900.

Layout:
- Topbar 56px (prosa logo left, logout right, background #1a1d27).
- Sidebar 220px left (Home active dot).
- Main content (flex, partial view of home's recent list — show 3 rows dim/blurred to indicate they're behind the open side panel; just place 3 placeholder rows with reduced opacity 0.4).
- Side panel: 640px wide, anchored right, background #1a1d27, 1px left border #232733, scrollable.

Side panel content (padding 32px):

1. **Sticky header** (background #1a1d27, padding 24px 32px, 1px bottom border #232733):
   - "claude-code" 12px lowercase #6b7186 (mono).
   - Below: first prompt at 18px weight 500 #e8eaf0, max 2 lines, ellipsis on overflow.
   - On the right edge: a small `esc` chip — 12px #6b7186, 1px border #232733, radius 4px, padding 4px 8px.

2. **Stats cluster** 2×2 grid (margin-top 24px, gap 16px 24px, 1px #232733 bottom rule). Each cell: number 22px tabular #e8eaf0 weight 400, label 12px uppercase letter-spacing 0.06em #6b7186.
   - 18 / TURNS
   - 3 / TOOLS
   - 18min / DURATION
   - claude-sonnet-4-6 / MODEL  (model value in 16px mono so long names don't wrap awkwardly)

3. **Metadata grid** (margin-top 48px). Two-column grid: label 110px (12px uppercase #6b7186), value (14px #e8eaf0, mono for IDs/hashes).
   - ID, Started, Last activity, Device, Project, Raw (bytes · sha256).
   - Below the dl: a row of "tool chips" — pill-shaped, padding 4px 10px, background #232733, radius 9999px, 12px #aab0bf — "Read ×12", "Bash ×4", "Edit ×3".

4. **TRANSCRIPT** label 12px uppercase letter-spacing 0.6px #6b7186 (margin-top 32px, margin-bottom 12px).

5. **Chat transcript** (flex column, gap 24px). Mix three bubble styles:
   - **User**: right-aligned, max-width 82%, filled bubble background #232733, radius 8px (bottom-right corner tighter 4px), padding 12px 16px, system font 14px line-height 1.6, content stays escaped plain text (a literal "**stars**" is shown literally).
   - **Assistant**: left-aligned, full-width, no surface — just prose. Render real markdown inside: an h3 "Decision", a paragraph, a fenced ```go``` code block with a 3-line snippet (background #1a1d27, 1px #232733 border, radius 4px, 12px mono, internal scroll), a 3-item bullet list, a single-line blockquote. 14px #e8eaf0 line-height 1.6.
   - **Tool**: full-width discrete block, background #1a1d27, 1px #232733 border, 2px #6b7afc33 left rule, radius 4px, padding 12px 16px, 12px mono #aab0bf, max-height 200px with internal scroll. Above the block, a tiny meta line: role label "TOOL" 12px uppercase #6b7186 and tool name "Read" in 12px mono #6b7afc on the left, timestamp right.
   - Sequence: user → assistant → tool → tool → tool → assistant → user (gives a real-looking pattern).
   - Each bubble has a meta row above it: role uppercase 12px #6b7186 + timestamp 12px mono #6b7186 right-aligned. User bubbles flip the row (timestamp on the left of the role) so the timestamp sits over the bubble edge.

6. **Raw transcript** disclosure at the bottom: a `<details>` with summary "View raw transcript" 12px uppercase #6b7186, content a `<pre>` of 8 JSONL lines.

System-ui font globally, mono only where called. Tabular-nums. No icons. No emojis. Generous breathing space inside the side panel.

--- END ---

---

## 10. Command palette modal

**Type**: HTML artifact.
**Why**: see the palette centered over the home screen.

--- PROMPT ---

Build a single HTML page mocking a command palette modal overlay on top of a dashboard called "prosa". Dark theme #0f1117. Window 1440x900.

Background (behind the modal): show a dimmed mockup of a home screen — just place a topbar (56px, "prosa" left, "logout" right, background #1a1d27) and a faint hint of content below. Apply a full-screen overlay of rgba(0,0,0,0.6) above the background, plus a CSS backdrop-filter: blur(8px).

Modal centered horizontally, 25% from the top. Width 560px. Background #1a1d27. Radius 12px. Shadow: 0 8px 24px rgba(0,0,0,0.4). Padding 24px.

Modal content:

1. **Search input** at the top:
   - Full width;
   - Background transparent, 1px bottom border #232733;
   - Font 18px weight 400 #e8eaf0;
   - Placeholder "/ search anything" in #6b7186;
   - No border-top, no border-left, no border-right;
   - Padding 12px 8px;
   - Show a fake user query already typed: "sqlite".

2. **Below the input, padding-top 24px**, three sections each with:
   - Section header in 12px uppercase letter-spacing 0.06em #6b7186 (e.g. "Recent sessions", "Reports", "Devices");
   - Section items below.

3. **Recent sessions** section (4 items, each row 44px tall, padding 12px):
   - Each row: duration left (60px, 13px tabular #6b7186), agent (90px, 13px #aab0bf), project (90px, 13px weight 500), first_prompt (flex, 13px #e8eaf0 truncated with ellipsis).
   - Items:
     - 18 min  claude-code  prosa   "refactor sync logic"
     - 32 min  codex        mz-iac  "setup terraform vpc"
     -  4 min  claude-code  brain   "audit obsidian vault"
     - 47 min  codex        prosa   "tests for sqlite store"
   - First item highlighted (background rgba(107,122,252,0.15)) to indicate keyboard focus.

4. **Reports** section: a row of 6 chips, gap 8px. Chip styling: padding 6px 12px, background #232733, radius 4px, 12px #aab0bf.
   - "sessions" "tools" "models" "projects" "errors" "heatmap"

5. **Devices** section: 1 row showing "laptop-caian — active 2 min ago".

Below the modal, centered, a small caption "↑↓ navigate · ↵ open · esc close" in 12px #6b7186. Gap 16px below the modal.

Font system-ui. Tabular-nums. No icons. No emojis.

--- END ---

---

## 11. Devices admin page

**Type**: HTML artifact.
**Why**: validate the admin tone without losing the airy feel.

--- PROMPT ---

Build a single HTML page mocking the devices admin page for "prosa". Dark theme #0f1117. Window 1440x900.

Topbar + sidebar same as previous (Devices active dot in sidebar). Main padding 48px.

1. Title "devices" 28px weight 400 #e8eaf0. Margin-bottom 8px.
2. Subtitle "manage where prosa runs" 14px #6b7186. Margin-bottom 40px.

3. **Approval card** at the top:
   - Background #1a1d27, radius 8px, padding 32px;
   - Two columns: left (label "approve a new device" 14px weight 500 #e8eaf0 + subtitle "paste the code shown by the CLI" 13px #6b7186), right (an input 200px wide for the code + a primary button "approve").
   - Input styling: background #232733, no border, padding 12px 16px, radius 4px, 14px mono #e8eaf0, placeholder "ABCD-1234" in #6b7186.
   - Button: padding 12px 24px, background #6b7afc, color #0f1117 weight 500, radius 4px.

4. **Devices table** (margin-top 48px):
   - Header row: NAME | STATE | LAST SEEN | ACTIONS — 12px uppercase letter-spacing 0.06em #6b7186, padding 12px 16px, 1px bottom border #232733.
   - Rows 56px tall, padding 16px, 1px bottom border #232733.
   - Data:
     - laptop-caian   | active   | 2 min ago    | [edit] [revoke]
     - mz-server      | active   | 1 h ago      | [edit] [revoke]
     - old-desktop    | revoked  | 12 days ago  | (no actions)
   - NAME column: 14px weight 500 #e8eaf0 + a 10px circle to its left (color #4ade80 for active, #6b7186 for revoked).
   - STATE column: 13px, color #4ade80 for active, #6b7186 for revoked.
   - LAST SEEN: 13px tabular #aab0bf.
   - ACTIONS: 13px links in #6b7afc, gap 16px between them, hover underline.

System-ui font. Tabular-nums. No icons. No emojis.

--- END ---

---

## 12. Login page

**Type**: HTML artifact.
**Why**: see the vertical rhythm on a public screen.

--- PROMPT ---

Build a single HTML page mocking the login screen of a personal dashboard called "prosa". Dark theme #0f1117. Window 1440x900. No topbar, no sidebar.

Center everything vertically and horizontally. Width 320px.

Stack vertically with this rhythm (top to bottom):

1. **Logo**: "prosa" in 36px weight 200 #e8eaf0. Letter-spacing -0.02em.
2. 64px vertical space.
3. **OAuth button**: full width 320px, padding 14px, background #6b7afc, color #0f1117, weight 500, radius 4px, font 15px. Label: "continue with github".
4. 16px space.
5. **Divider**: a thin centered "or" — small text in #6b7186 12px, with a 1px line on each side in #232733 extending to the edges of the button. Total height 32px.
6. 16px space.
7. **Dev login button**: same dimensions as OAuth button, but background transparent + 1px border #232733, color #aab0bf. Label "dev login (local only)".
8. 96px vertical space.
9. **Tagline**: "your first screen of the day" in 13px #6b7186, centered.

System-ui font. No icons. No emojis. No decoration. Quiet and confident.

--- END ---

---

## 13. Variant A/B: same screen, two design directions

**Type**: HTML artifact (comparison).
**Why**: test an alternative direction before locking the decision.

--- PROMPT ---

Build a single HTML page comparing two design directions for the home screen of an analytics dashboard called "prosa". Place the two designs side by side, each taking exactly 50% of the viewport width. Header above each: "Variant A — airy" and "Variant B — denser".

Both variants show the same content: a "Today" block with KPIs (12 sessions, 3 projects, 2 active models) + a 14-day sparkline + a "Recent" list with 5 sessions from today.

Sample data for recent:
- 09:14 claude-code prosa "refactor sync logic" 18 min
- 11:02 codex mz-iac "setup terraform vpc" 32 min
- 14:22 claude-code prosa "tests for sqlite store" 47 min
- 16:40 claude-code brain "audit obsidian vault" 4 min
- 18:05 cursor c3-oss "investigate connect rpc" 23 min

**Variant A (airy)**:
- KPIs in 44px weight 300, label 12px uppercase #6b7186, gap 64px between KPIs;
- Sparkline 320x48, line #6b7afc, soft fill;
- Recent rows 56px tall, generous spacing, 1px dividers #232733;
- Background #0f1117, no cards, hierarchy by size only;
- Padding 48px around.

**Variant B (denser)**:
- KPIs in 28px weight 500, label inline next to value, gap 24px between KPIs;
- Each KPI in a small card with background #1a1d27 radius 8px padding 16px;
- Sparkline inline next to KPI text 60x20;
- Recent rows 36px tall, 12px font, tighter spacing;
- Each recent row in a subtle alternating background (#0f1117 / #14171f);
- Padding 24px around.

Both dark theme, same color palette, system-ui font, tabular-nums, no icons, no emojis.

After studying both side by side, the reader should clearly feel the difference between "airy contemplative" vs "compact functional".

--- END ---

---

## 14. Visual mood — raster image

**Type**: Midjourney / DALL-E / Stable Diffusion / Imagen.
**Why**: generate a UI image that captures the vibe without having to be
pixel-accurate.

--- PROMPT ---

A dark mode dashboard UI screenshot, ultra minimal aesthetic. Personal analytics for AI coding sessions. The screen shows a "Today" headline at the top with three very large numbers in thin sans-serif typography — "12" labeled "sessions", "3" labeled "projects", "2" labeled "active models" — with extreme generous whitespace between them. Below the numbers, a small smooth line chart in blueish violet, 14 data points, with a soft fill below the line. Below the chart, a list of recent sessions with monospace timestamps on the left and short prompt descriptions in white. Dark navy background #0f1117. Accent color a periwinkle blue #6b7afc. No icons. No card borders. Hierarchy by size, not by boxes. Very airy, contemplative, like a museum caption or a quiet notebook. Inspired by Linear and Vercel dashboards but quieter and more spacious. 1440x900 desktop screen. Ultra-clean, system-ui font.

--- END ---

---

## 15. Visual mood — isolated palette

**Type**: Midjourney / DALL-E.
**Why**: visualize the palette in context, without UI.

--- PROMPT ---

A minimal abstract composition presenting a color palette for a dark mode dashboard. Background deep navy #0f1117. Five large color swatches floating in space with hex labels: #1a1d27 (slate), #6b7afc (periwinkle), #4ade80 (mint), #f04a5c (coral), #e8eaf0 (soft white). Each swatch is a soft-cornered rectangle, no borders, with generous space around them. Tiny serif labels in pale gray below each swatch. The composition feels contemplative, quiet, museum-like. Subtle dust grain texture. No icons, no UI elements, just colors breathing in space. Inspired by Werkstatte Wien color studies. 16:9.

--- END ---

---

## 16. Raster mockup — single screen

**Type**: Midjourney / DALL-E.
**Why**: a single image of the whole screen.

--- PROMPT ---

A photorealistic screenshot of a dark mode web dashboard called "prosa" on a 16-inch laptop screen. The dashboard has:
- A top bar with "prosa" in clean sans-serif on the left and a tiny "logout" link on the right;
- A 220px left sidebar with three nav items: Home (active, with a small blue dot prefix), Devices, Analytics;
- A main content area with two stacked sections;
- The top section labeled "Today" in 28px text. Below it, three very large airy numbers: 12 sessions, 3 projects, 2 active models. Then a small smooth line chart in periwinkle blue;
- The bottom section labeled "Recent" with a vertical list of session rows: timestamp, agent name (claude-code, codex), project name (prosa, mz-iac), short prompt description, duration. Day groupings with subheaders "Today" and "Yesterday".

Color palette:
- Background: #0f1117 (deep navy);
- Surface: #1a1d27 (slate);
- Accent: #6b7afc (periwinkle blue);
- Text primary: #e8eaf0 (warm white);
- Text secondary: #6b7186 (muted lavender).

System UI font throughout. Tabular numbers for all numerical values. Very minimal, very airy. No icons, no card shadows, no gradients, no emojis. Generous whitespace between every block. The aesthetic should evoke a calm notebook, not a Grafana dashboard. Photography style: clean studio shot of a laptop, soft natural lighting, slight reflection, 35mm lens.

--- END ---

---

## 17. Interactive prototype

**Type**: Lovable, Bolt, v0.dev full mode, Replit Agent.
**Why**: produce a navigable app to test the flow between screens.

--- PROMPT ---

Build a working web prototype of a personal analytics dashboard called "prosa". Static HTML/CSS/JS only — no backend, no real data. Use Alpine.js (already in CDN) for client state. Multiple pages routed via hash (#home, #devices, #analytics-sessions, #analytics-tools, #analytics-models, #analytics-heatmap).

Aesthetic: airy dark mode. Background #0f1117. Accent #6b7afc. System-ui font. Tabular-nums on all numbers.

Shared layout: top bar 56px + sidebar 220px + main content area. Sidebar items: Home (default), Devices, Analytics (with sub-items: sessions, tools, models, projects, errors, heatmap).

Pages:

1. **Home** (#home): Today block with 3 large KPIs (12, 3, 2) and a sparkline. Below, a Recent list with 8 mocked session rows grouped by Today/Yesterday.

2. **Devices** (#devices): A table with 3 devices (laptop-caian active, mz-server active, old-desktop revoked) and a form to approve a new device by code.

3. **Analytics sessions** (#analytics-sessions): A trend line chart over 30 days (use Chart.js or inline SVG, your choice — SVG preferred), plus a small table "by agent".

4. **Analytics tools** (#analytics-tools): Top 20 tools with horizontal bars and values. Top 5 also get a sparkline.

5. **Analytics models** (#analytics-models): A donut chart with 3 model slices + percentage list.

6. **Analytics heatmap** (#analytics-heatmap): A 30x24 grid heatmap with intensity scaling by accent color opacity.

Interactivity:
- Cmd-K / Ctrl-K opens a centered command palette modal (Alpine x-data state). Backdrop blur. Esc closes.
- Filter pills at the top of analytics pages (7d, 30d, all agents, etc) — clicking changes the displayed data (mock data per filter is fine).
- Clicking a session row on Home opens a right-side panel (Alpine state) with session detail (metadata grid + raw transcript).

Make it feel airy, quiet, fast. No transitions over 200ms. No icons. No emojis. No card shadows. Hierarchy by typography size only.

--- END ---

---

## 18. Refinement — sparkline with tooltip

**Type**: HTML artifact.
**Why**: validate the hover micro-interaction without heavy JS.

--- PROMPT ---

Build a single HTML page with 6 sparkline components in a row, demonstrating CSS-only hover tooltips. Dark background #0f1117. Page padding 64px.

Each sparkline:
- 100x32 inline SVG;
- 10 data points, smooth line stroke 1.5px #6b7afc;
- Soft fill below in #6b7afc opacity 0.2;
- Each data point is a small circle r=2 #6b7afc;
- Each circle has a `<title>` with text like "day 5: 12 sessions";
- On hover, the circle scales to r=4 via CSS transition 80ms;
- Above each sparkline, a small label "tool name" in 13px #aab0bf with the latest value in #e8eaf0 to the right.

Six sparklines with these label/value pairs, each with realistic mock data:
- Read     234
- Bash     180
- Edit     142
- Glob      98
- Grep      87
- Write     72

Gap between sparklines 48px. Center the row horizontally.

The interaction goal: when hovering any point, the tooltip appears via the browser's default `<title>` mechanism, and the circle visually grows. No JavaScript.

System-ui font, tabular-nums on numbers.

--- END ---

---

## 19. Refinement — heatmap legend

**Type**: HTML artifact.
**Why**: explore legend variants for the heatmap.

--- PROMPT ---

Build a single HTML page on dark background #0f1117, padding 64px, showing 4 variants of a heatmap intensity legend.

Each variant labeled above (14px #6b7186) with the variant name.

Variant 1: "horizontal scale + edge labels"
- A row: text "less" 12px #6b7186, then 5 cells of size 16x16 with rounded corners, opacity stepping from 0.06 to 1.0 of color #6b7afc, then text "more" 12px.
- Gap 4px between cells.

Variant 2: "gradient bar with min/max"
- A 240x16 rounded rectangle with a linear-gradient from rgba(107,122,252,0.06) to rgba(107,122,252,1);
- "0" 12px below-left, "max 8" 12px below-right.

Variant 3: "discrete ticks with counts"
- 5 cells like variant 1 but each with a small number below (1, 2, 3, 5, 8) in 11px #6b7186 tabular.

Variant 4: "vertical column"
- A 16x100 rounded rectangle with vertical gradient (top dense, bottom faint);
- Labels "more" at top, "less" at bottom in 12px #6b7186.

Stack the variants vertically, gap 64px between each. Each variant container max-width 320px.

System-ui font. Tabular-nums on numbers.

--- END ---

---

## 20. Mood: pages together (multi-screen exploration)

**Type**: Midjourney / DALL-E / Imagen.
**Why**: see the screens talking to each other as a coherent set.

--- PROMPT ---

Three minimalist dark mode dashboard mockups arranged in a horizontal triptych, each shown as if floating against a soft dark navy background. Each panel is a stylized rendering of a different screen from the same product:

1. Left panel — "Home": A column with the headline "Today" at top in light serif-adjacent sans, three very large airy numbers (12, 3, 2) with quiet captions below, a delicate periwinkle blue line sparkline, and a clean list of recent sessions with monospace timestamps.

2. Middle panel — "Analytics": A large smooth line chart filling the panel with a soft periwinkle gradient fill below the line. Above the chart, the title "sessions" in elegant typography. Below, a tiny tabular summary by agent.

3. Right panel — "Command palette": A centered modal floating with a backdrop blur, containing a search input "/ search anything" and a list of recent sessions with timestamps and short prompt descriptions. The background of the screen behind the modal is intentionally faded and unfocused.

All three panels share:
- Background #0f1117 (deep navy);
- Accent color #6b7afc (periwinkle);
- Text in warm white #e8eaf0 and muted lavender #6b7186;
- System-ui sans-serif typography;
- Extreme generous whitespace;
- No icons, no card shadows, no gradients beyond chart fills;
- Hierarchy by type size only.

The composition feels like a quiet design study from a Swiss design book. Soft natural lighting. Light grain texture. 21:9 aspect ratio.

--- END ---

---

## 21. Sanity check — accessibility

**Type**: Claude / GPT (textual analysis, no render).
**Why**: make sure the final design respects accessibility.

--- PROMPT ---

Audit the following design system for accessibility issues. Be specific, cite WCAG criteria, and recommend concrete fixes.

Design tokens (dark mode):
- bg: #0f1117
- bg-elev-1: #1a1d27
- bg-elev-2: #232733
- text-1: #e8eaf0
- text-2: #aab0bf
- text-3: #6b7186
- accent: #6b7afc
- accent-soft: #6b7afc33 (alpha 0.2)
- ok: #4ade80
- danger: #f04a5c

Typography: system-ui, base 16px, scale 12/14/16/18/22/28/36/44, weights 200/300/400/500.

Key components I'm worried about:
1. KPI cards using 12px uppercase labels at color #6b7186 — contrast vs background #0f1117?
2. Sparklines using only color (#6b7afc) to communicate trend, no text alternative on hover except `<title>`.
3. Live dot using only color (#4ade80) — is "live" text label sufficient as redundant signal?
4. Filter pill dropdowns: clicking a chip opens a `<ul>` via Alpine x-show — is there a keyboard trap or focus management issue?
5. Command palette modal uses `<dialog>` native — does it handle focus correctly on close?
6. Heatmap cells communicate count only via opacity of one color — sufficient or do we need an additional pattern?

For each concern, state:
- Is it actually a problem at this size and contrast level?
- What WCAG criterion applies?
- What's the smallest fix that resolves it without sacrificing the airy aesthetic?

--- END ---

---

## Final tips

- **Iterate in a loop**: the first output rarely lands. Generate, adjust
  the prompt based on what came out weird, generate again.
- **Compare side by side**: prompt 13 (variant A/B) is the most efficient
  way to settle an aesthetic doubt.
- **Save the good mocks** under `docs/panel/mockups/` (create the folder
  if you decide to use it) or in the Obsidian vault at
  `BRAIN/projects/prosa-panel/`.
- **Raster images** (Midjourney etc.) are mood, not spec. Use them to
  align feeling, not to dictate pixels.
- **HTML artifacts** are usable spec: you can literally open the output
  in the browser and measure the feeling.
