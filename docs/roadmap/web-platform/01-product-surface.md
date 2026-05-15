# Web platform lane 1: Product surface and visual system

This lane defines the web product before implementation. The output is a
decision-complete product and visual spec for the public site and authenticated
console, so later lanes can build without re-litigating naming, routes, layout,
or interaction patterns.

## Goals

- Establish `console` as the name of the authenticated product area.
- Define the public institutional site, authentication pages, and console as
  one coherent web platform.
- Make the visual direction intentionally close to Supabase and LangSmith:
  technical, dense, trustworthy, dark/editorial, and observability-oriented.
- Define route groups, layout primitives, navigation, empty states, and key UI
  components before writing frontend code.
- Keep the first version focused on remote/promoted prosa data. Local bundle
  browsing remains CLI/TUI-first until a later local-web mode is explicitly
  designed.

## Product model

The web platform has three surfaces:

- Public site: explains what prosa is, why agent-history observability matters,
  how local-first sync works, and how to start with the CLI.
- Auth surface: signup, login, logout, tenant selection, invites, and account
  recovery flows backed by the existing `apps/api` Better Auth server.
- Console: authenticated tenant-scoped workspace for sessions, search,
  timeline detail, tool calls, analytics, artifacts, and team settings.

Primary audience:

- Developers and teams using Codex, Claude Code, Gemini CLI, Cursor, or Hermes.
- Power users who need to search and audit previous agent work.
- Teams that want shared visibility into promoted `.prosa` histories without
  passing local bundle files around.

Product promise:

- "A searchable console for agent session history, tool calls, and operational
  evidence."

## Route map

Public routes:

- `/`: landing page with hero, product proof, CLI quickstart, screenshots, and
  signup CTA.
- `/product`: product overview for search, session timelines, tool-call audit,
  analytics, and team visibility.
- `/security`: short security model covering local-first storage, tenant
  isolation, object access, and sync promotion.
- `/docs`: documentation landing that links to CLI usage and architecture docs.
- `/login`: email/password login.
- `/signup`: signup with first tenant creation.

Console routes:

- `/console`: dashboard overview for the active tenant.
- `/console/sessions`: paginated session table with filters.
- `/console/sessions/:sessionId`: structured session timeline and inspector.
- `/console/search`: global search over sessions, messages, tool calls, and
  indexed evidence.
- `/console/tool-calls`: audit view for tools, commands, errors, and paths.
- `/console/analytics`: report views backed by prosa analytics facts.
- `/console/artifacts/:artifactId`: artifact preview page when an artifact
  deserves a stable URL.
- `/console/settings/team`: tenant members, invites, and roles.
- `/console/settings/account`: user profile, sessions, logout, and tokens.

Deferred routes:

- `/pricing`: only add when the hosted product has real packaging decisions.
- `/console/imports`: only add when browser-controlled import/sync exists.
- `/console/mcp`: only add if MCP server management becomes a web product
  feature; MCP itself is not the console API.

## Visual direction

The visual system should reference Supabase and LangSmith without copying
either:

- Dark graphite base with green/cyan technical accents.
- Thin borders, grid lines, panel stacks, query-console details, and subdued
  glow only where it communicates hierarchy.
- Dense data surfaces in the console; more editorial whitespace on the public
  site.
- Rounded corners are restrained: use small radii for data tables and medium
  radii for marketing cards.
- Avoid generic SaaS purple gradients, oversized emoji illustration, and
  interchangeable "AI dashboard" patterns.

Suggested token families:

```css
:root {
  --color-bg: #070907;
  --color-bg-elevated: #0d120f;
  --color-panel: #111812;
  --color-panel-strong: #172018;
  --color-border: #263229;
  --color-border-subtle: #18211b;
  --color-text: #ecf5ee;
  --color-text-muted: #9aa89e;
  --color-text-faint: #657269;
  --color-accent: #3ecf8e;
  --color-accent-strong: #6ee7b7;
  --color-cyan: #61d6d6;
  --color-warning: #f4b860;
  --color-danger: #ff6b6b;
  --color-code-bg: #050805;
}
```

Typography:

- Display: `Space Grotesk` or `Sora` for landing headlines.
- UI: `IBM Plex Sans` for navigation, forms, and data labels.
- Mono: `JetBrains Mono` for session IDs, tool names, command previews, JSON,
  timestamps, and snippets.
- Do not use Inter/Roboto/Arial/system as the primary visual identity.

## Layout system

Public site layout:

- Header with logo, Product, Security, Docs, GitHub, Login, and Start button.
- Hero split: copy on the left, live-looking session/search preview on the
  right.
- Evidence strip: supported sources, CLI command, sync model, searchable data.
- Feature grid: Search, Timeline, Tool calls, Analytics, Team console.
- Architecture section: local bundle, sync promotion, Postgres/object storage.
- Final CTA: install CLI or create account.

Console layout:

- Left sidebar: tenant switcher, primary nav, sync status, user menu.
- Top command bar: global search, date range, provider quick filter.
- Main content: route-specific data surface.
- Right inspector: contextual detail for selected session, event, tool call, or
  artifact on desktop.
- Mobile: sidebar collapses into a top drawer, inspector becomes a full-screen
  sheet, data tables become stacked cards.

Responsive breakpoints:

- `sm` 640px: mobile stacked cards.
- `md` 768px: two-column marketing sections.
- `lg` 1024px: console sidebar visible.
- `xl` 1280px: console inspector visible.
- `2xl` 1536px: wider tables and analytics grids.

## Component vocabulary

Public components:

- `MarketingHeader`
- `HeroSessionPreview`
- `CliQuickstartCard`
- `SourceLogoStrip`
- `FeatureBento`
- `ArchitectureDiagram`
- `SecurityPrinciples`
- `LandingFooter`

Auth components:

- `AuthLayout`
- `SignupForm`
- `LoginForm`
- `TenantCreateFields`
- `PasswordField`
- `AuthErrorCallout`

Console components:

- `ConsoleLayout`
- `ConsoleSidebar`
- `TenantSwitcher`
- `CommandBar`
- `DateRangeFilter`
- `ProviderFilter`
- `MetricCard`
- `DataTable`
- `EmptyState`
- `SkeletonPanel`
- `InlineError`
- `ObjectPreviewDrawer`

## Acceptance criteria

- The new docs specify public, auth, and console routes before frontend work
  starts.
- Visual tokens, typography, layout primitives, and component names are stable
  enough for implementation.
- The console is explicitly tenant-scoped and assumes remote/promoted data.
- Public site and console share one design language but use different density:
  editorial marketing, dense operational console.
- Deferred surfaces are named so implementers do not accidentally build MCP,
  pricing, or browser import workflows in v0.

