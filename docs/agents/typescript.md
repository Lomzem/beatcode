# Effect and Bun

Use Effect as the default for application and operator workflows. Migrate existing asynchronous orchestration when touching it; keep framework entry points thin and preserve their public contracts. The dependency version in package.json is authoritative; consult the installed version's source or its matching official docs rather than copying examples from another major version.

## Effect boundaries

Compose fallible steps with typed error channels and Effect.gen or combinators. Run effects at Svelte event/lifecycle handlers, Convex handlers, or CLI entry points. Keep pure calculations, generated bindings, and vendored components plain when they need no effect. A single wrapper around an unchanged asynchronous workflow does not complete a migration.

Represent expected failures explicitly and map them to the existing public error shape at the boundary. Sanitize diagnostics: child-process exceptions can contain arguments, hidden problem payloads, credentials or source code. Keep these out of error objects and logs.

Use scoped resource management for sandboxes, subscriptions and other acquired resources. Await cleanup before releasing judge leases or publishing results. Interruption and retries must preserve existing deadlines, accounting, ordering and idempotency.

Convex queries and mutations remain deterministic, sequential database operations. Keep timers, background fibers, network I/O and retry scheduling outside them; use actions and Convex's scheduler where required. Preserve Convex validators and client-visible ConvexError data.

## Tooling

Use Bun for installs, dependency changes and package scripts. Keep bun.lock as the sole package lock; use frozen installs in CI. Use bunx --no-install for installed CLIs. Retain the pinned Node runtime where SDKs and deployment tools require Node; choosing Bun as package manager does not silently change production runtimes.

Serialize commands that regenerate SvelteKit/build artifacts with .scratch/competitive-leetcode/build.lock. Docker commands writing this checkout must use the checkout owner's UID/GID; root-owned generated files previously crashed the dev server.

## Verification

Test observable contracts at the existing browser, authenticated API and trusted judge seams. Preserve privacy, admission order, resource cleanup and timing semantics through migration. Use /implement and its TDD/review workflow; successful dependency installation alone does not establish migration completion.
