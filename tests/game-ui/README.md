This browser regression mounts the production Session, Play (Rooms), Room, Match, Editor and game client. Only the Convex SDK boundary (`fake-convex.svelte.ts`), framework URL resolution and navigation use local fixtures. `isolation.ts` blocks every request and WebSocket outside the fixture server origin, service workers are blocked, and each check fails if the page attempts any outside traffic. A guard test proves that an outside fetch and WebSocket are blocked and reported.

`fixtures.ts` holds one typed SDK view per screen state. `?state=<name>` selects it and `?theme=<dark|light|contrast>` applies a saved Settings theme. The browser clock is fixed at `FIXTURE_NOW`, so timers, Power and effect durations render the same values every run.

| Screen | States                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------ |
| Rooms  | `rooms` (signed in)                                                                              |
| Room   | `room-open` (Host), `room-lobby` (Deck choice and readiness), `room-results`, `room-closed`      |
| Match  | `match-active`, `match-brain-teaser`, `match-light-mode`, `match-settling`, `match-intermission`, `match-finished` |

`screens.browser.ts` checks every state in the dark, light and high-contrast themes, at 320 px and 1280 px, in Chromium, Firefox and WebKit, with reduced motion requested. Each check covers:

- what a Player can perceive or do: headings, accessible names, status and alert text, which actions are enabled, and the stated reasons when they aren't;
- no axe WCAG 2.2 A/AA violations, with the full axe results attached to the test report. Narrow Match layouts run the axe, overflow and animation checks once per panel;
- no page-level horizontal overflow (the editor scrolls inside itself);
- no running animations or transitions, sampled after render and again after keyboard interaction;
- the state's primary action reached from the top of the page with Tab alone, with a focus indicator (an opaque outline of at least 2 px, or a box shadow) that appears only on focus. Narrow Match layouts open the panel tab with the arrow keys, and the walk leaves the editor with Escape then Tab. `match-settling` has no action to reach.

`diagnostics.browser.ts` verifies which compiler diagnostics the UI displays when scored and sample attempts arrive in either order, including a newer attempt without diagnostics, and that sample history displays the overall verdict alongside per-sample results.

Run `bun run test:game-ui`. Add `--project chromium-320` (or another `<browser>-<width>` project) to narrow a local run. WebKit needs the Playwright system libraries; on hosts without them, run the WebKit projects in the matching `mcr.microsoft.com/playwright` image with your UID and GID. These tests establish component behavior; they do not establish authentication, backend persistence, native judging or production acceptance. The real authenticated Match suite remains a separate integration gate. Screen readers, zoom and manual keyboard checks still need human verification.
