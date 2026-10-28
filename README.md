# Beatcode

Private 1v1 C++ programming matches with cards that affect an opponent's editor or compiler. Matches are best of three; the earliest server-admitted submission that passes all tests wins each round.

The app uses SvelteKit, Convex, Clerk, CodeMirror, Tailwind and shadcn-svelte, with Effect for typed workflows and resource cleanup. Cloudflare serves static assets; trusted Convex actions control disposable, network-blocked Modal judge sandboxes. Browser state cannot award points, spend power or submit a verdict.

## Development

Use Node 24.22.1 and Bun 1.4.4. Install dependencies with `bun install --frozen-lockfile`, copy `.env.example` to an ignored local environment file, and configure the public Clerk key and Convex URL. Configure the matching Clerk issuer as `CLERK_JWT_ISSUER_DOMAIN` on Convex, with a Clerk JWT template named `convex` and audience `convex`.

Run `bunx --no-install convex dev` for your development backend and `bun run dev` for the frontend. Without public service configuration, the frontend displays an unavailable state. It never substitutes a simulated match or sign-in.

`bun run verify` checks types, lint, formatting, build, backend tests, judge-controller tests and browser tests. Install browser runtimes with `bunx --no-install playwright install --with-deps chromium firefox webkit` first. Browser tests cover three engines and three viewport sizes. Real-service journeys are explicitly skipped without their documented `MATCH_E2E_*` environment values; a default green run does not prove live authentication or a scored match.

## Operations

Judging starts disabled. Any signed-in player may create up to two open rooms; joining requires a single-use invitation. Operator functions in `convex/ops.ts` pause judging, reduce caps, revoke players, declare infrastructure incidents and annul finished matches. These functions are internal and require trusted deployment access.

Before updating an existing deployment to this revision, complete the [hosting data migration](docs/migrations/retire-host-passes.md). Fresh deployments need no migration.

Problem packages, hidden inputs, expected answers and reference solutions belong in the separate private problem repository. Publish immutable versions and activate them only after measured sandbox calibration. Never place those artifacts, browser sessions or provider credentials in this public repository.

Modal credentials belong only in the trusted controller's Convex environment. Contestant sandboxes receive no credentials or network access. Keep `MODAL_SANDBOX_V2=0`, the pinned compiler image, explicit resource limits and the configured zero net spend limit. Image or runtime changes require recalibration. Judge timing varies between hosts; time limits are practical complexity gates, and near-threshold solutions can behave differently across attempts.

The release layer supplies GitHub Actions automation in `.github/workflows`. Once installed, it checks pull requests. After a reviewed merge to `main`, the deployment workflow checks the code, deploys Convex, builds the frontend with public configuration, deploys Cloudflare and checks public routes. Deployment secrets are restricted to trusted jobs. The DNS workflow manages only the Clerk records listed in `ops/dns.json`.

UI requirements and review expectations are in [the agent UI guide](docs/agents/ui.md); architecture decisions are in [docs/adr](docs/adr/). Accessibility checks are engineering requirements, not a public conformance claim.
