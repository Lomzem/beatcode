# Offline primitive browser checks

This fixture mounts the real Svelte Button, Input, and Select components with the application's CSS. It does not load SvelteKit routes, authentication, backend clients, or env files. The browser blocks non-local requests. Run inside the existing browser container with networking disabled; no hosted account is needed.

`bun run test:primitives` runs the type contract and browser checks with the repository's pinned Node version on `PATH`. `bun run test` includes this command, so the existing public CI job discovers these checks. No ignored toolchain file is required by the fixture server.

From the repository root, using the pinned Node runtime and installed browser cache:

```sh
flock -w 20 .scratch/competitive-leetcode/build.lock \
  docker run --rm --network none --user 1000:984 \
  -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "$PWD:/work" \
  -v "$HOME/.cache/ms-playwright:/ms-playwright:ro" \
  -w /work beatcode-browser:ubuntu24 \
  .scratch/competitive-leetcode/toolchain/node-v24.22.1-linux-x64/bin/node \
  node_modules/@playwright/test/cli.js test \
  --config tests/ui-primitives/playwright.config.ts
```

Use the checkout owner's UID/GID if they differ. The lock wait is bounded; retry after the current owner finishes. Results stay in `.scratch/competitive-leetcode/primitives-r1-results`, separate from application browser results. The `.browser.ts` filename prevents the application suite from discovering these fixture-only tests.

Check the discriminated file-input props and Svelte fixture without regenerating application artifacts:

```sh
flock -w 20 .scratch/competitive-leetcode/build.lock \
  .scratch/competitive-leetcode/toolchain/node-v24.22.1-linux-x64/bin/node \
  node_modules/svelte-check/bin/svelte-check \
  --tsconfig tests/ui-primitives/tsconfig.json
```

The tests protect disabled link activation and propagation, enabled pointer/keyboard behavior, native file selection and clearing, ordinary text binding, and pointer/keyboard access to long select lists. The invalid file default deliberately represents an untyped JavaScript caller; the separate type fixture rejects that prop for TypeScript callers.
