# Web platform lane 2: Frontend foundation

This lane adds the browser application as a new workspace package. It should be
isolated from CLI/core implementation details and consume `apps/api` through
typed tRPC and Better Auth browser flows.

## Goals

- Add `apps/web` as a private workspace package named `@c3-oss/prosa-web`.
- Use a Vite React SPA for the first web platform implementation.
- Support both public site routes and authenticated console routes in one app.
- Keep frontend styling under explicit CSS variables and component-level CSS,
  not an opaque UI kit.
- Compile against the exported `AppRouter` type from `@c3-oss/prosa-api`.

## Technology choices

Use current compatible versions at implementation time:

- Vite for development server and static build.
- React and React DOM for the UI runtime.
- TypeScript with the repo's existing strict settings.
- `@tanstack/react-router` for typed browser routes and layout nesting.
- `@tanstack/react-query` for server-state caching.
- `@trpc/client` and `@trpc/react-query` for API calls.
- Better Auth browser client or a thin local wrapper over `/api/auth/*`.
- `@tanstack/react-virtual` when long timeline/table virtualization becomes
  necessary.
- Vitest and Testing Library for component/unit tests.
- Playwright only in the production-readiness lane for browser E2E.

Avoid in v0:

- Next.js or another SSR runtime.
- Tailwind as the primary design language.
- A large component kit that dictates visuals.
- Client-side global stores for server state that belongs in React Query.

## Package shape

Create:

```text
apps/web/
  package.json
  tsconfig.json
  vite.config.ts
  index.html
  src/
    main.tsx
    app/
      App.tsx
      providers.tsx
      router.tsx
    routes/
      marketing/
      auth/
      console/
    components/
      marketing/
      auth/
      console/
      primitives/
    lib/
      api.ts
      auth.ts
      config.ts
      format.ts
      query-keys.ts
    styles/
      tokens.css
      global.css
      marketing.css
      console.css
    test/
      render.tsx
```

Scripts:

```json
{
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "lint": "biome check .",
  "lint:fix": "biome check --fix .",
  "clean": "rm -rf dist coverage .turbo"
}
```

Root Turbo should pick up `apps/web` through the existing workspace glob and
`dist/**` output convention.

## Runtime configuration

Browser-visible env vars:

- `VITE_PROSA_API_URL`: required outside local dev; points at `apps/api`.
- `VITE_PROSA_APP_ENV`: optional `development|preview|production`.
- `VITE_PROSA_MARKETING_DOCS_URL`: optional external docs link.
- `VITE_PROSA_GITHUB_URL`: optional repository link.

Rules:

- Do not put secrets in `VITE_*`.
- The app must fail with a clear developer error if `VITE_PROSA_API_URL` is
  absent outside local dev.
- Local dev defaults to `http://127.0.0.1:3000`.

## App providers

`AppProviders` wraps the route tree with:

- React Query `QueryClientProvider`.
- tRPC provider configured with `VITE_PROSA_API_URL`.
- Auth/session provider that exposes `user`, `session`, `tenantId`,
  `memberRole`, `isLoading`, and `refresh`.
- Router provider.

tRPC client rules:

- Use `credentials: 'include'` for browser cookie sessions.
- Also support `Authorization: Bearer` only for explicit future service-token
  flows, not as the normal browser path.
- Include `x-prosa-tenant-id` when a tenant is selected.
- Centralize error normalization so UI components do not parse raw tRPC errors.

## Route organization

Route groups:

- `marketing`: public pages under `/`, `/product`, `/security`, `/docs`.
- `auth`: `/login`, `/signup`, future recovery/invite pages.
- `console`: authenticated layout under `/console`.

Route guards:

- Public routes never require API availability.
- Auth routes redirect authenticated users to `/console`.
- Console routes require an authenticated user.
- Console data routes require an active tenant; otherwise show tenant creation
  or tenant selection.
- Forbidden tenant access must render an authorization error, not silently
  switch tenants.

## Styling architecture

Global CSS files:

- `tokens.css`: color, typography, radius, spacing, shadow, z-index, motion.
- `global.css`: reset, base elements, focus rings, body background.
- `marketing.css`: public-site layout utilities and decorative surfaces.
- `console.css`: app shell, tables, timeline, inspector, command bar.

Rules:

- Components use semantic class names, not utility soup.
- Tokens are stable and documented before individual components add variants.
- Motion must communicate state: page reveal, command-bar focus, drawer entry,
  timeline expansion, skeleton loading.
- Use `prefers-reduced-motion` to disable non-essential transitions.
- Dark mode is the default brand expression; light mode is not required for v0.

## Frontend primitives

Build small primitives before feature components:

- `Button`
- `IconButton`
- `TextField`
- `PasswordField`
- `Select`
- `Tabs`
- `Badge`
- `Pill`
- `Card`
- `Panel`
- `Table`
- `Drawer`
- `Dialog`
- `Tooltip`
- `CodeBlock`
- `JsonTree`
- `Spinner`
- `Skeleton`
- `EmptyState`

Do not over-abstract:

- Use primitives to keep visuals consistent.
- Keep data-specific behavior in feature components.
- Avoid a generic table framework until real needs justify it.

## Acceptance criteria

- `pnpm --filter @c3-oss/prosa-web typecheck` passes.
- `pnpm --filter @c3-oss/prosa-web build` produces `apps/web/dist`.
- Landing route renders without the API server.
- Console route renders an authenticated-shell placeholder behind a route
  guard.
- tRPC client compiles against `AppRouter` from `@c3-oss/prosa-api`.
- CSS tokens define the visual direction from lane 1 before feature work starts.

