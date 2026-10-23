# Requested stack and browser C++ editor feasibility

Investigation date: **2026-10-22**. Research ticket 03, private competitive programming alpha. Documentation and package metadata were checked live. This is feasibility research, not an implementation, production API design, or an architecture decision. Later architecture belongs to Opus. No tracker files were changed.

## Resolution

**Inference:** The requested stack fits together without replacing any requested tool. The meaningful qualifications are version alignment, Svelte-aware lint configuration, and the separate work needed for C++ semantic assistance and trusted judging. `shadcn-lint` can be resolved to the official **`shadcn-ui/lint` repository / `@shadcn/lint` package**, which explicitly supports Svelte under ESLint. Do not substitute a similarly named package or assume it is React-only. Monaco and CodeMirror both support the editor effects, but neither turns highlighting into C++ LSP or makes browser effects enforceable against a modified client.

Preserved constraints: C++ only; invite-only 1v1; up to three sequential rounds, each with the same problem for both players; first hidden-test acceptance wins that round and first to two wins the match. Both players choose decks from the same fully unlocked pool. Cards, durations, economy, and replacement of the now-obsolete within-round first-acceptance power bonus remain human decisions.

## Evidence and version baseline

**Facts:** The npm registry's `latest` metadata returned these versions on the investigation date. These are observations, not a proposed lockfile or proof of an integrated build:

- SvelteKit **3.1.0**, Svelte **5.57.2**. Kit requires Node **>=22.17**, Vite `^8.0.12`, Svelte `^5.57.1`, TypeScript `^6.0.0`, and Svelte Vite plugin `^7.0.0`. [Kit metadata](https://registry.npmjs.org/@sveltejs/kit/latest), [Svelte metadata](https://registry.npmjs.org/svelte/latest).
- Convex **1.48.0**, `convex-svelte` **0.15.1**. The latter declares Convex `^1.30.0`, Svelte `^5.19.0`, and Kit `^2.12.0 || ^3.0.0`. Convex's React/auth-provider peers are optional; their presence in package metadata does not require using React. [Convex metadata](https://registry.npmjs.org/convex/latest), [Svelte client metadata](https://registry.npmjs.org/convex-svelte/latest).
- Tailwind **4.3.3**, shadcn-svelte **1.7.0**, `@shadcn/lint` **0.2.3**. The linter requires Node >=20.19, ESLint >=9.30, and TypeScript parser >=8.40. [Tailwind metadata](https://registry.npmjs.org/tailwindcss/latest), [shadcn-svelte metadata](https://registry.npmjs.org/shadcn-svelte/latest), [linter metadata](https://registry.npmjs.org/@shadcn/lint/latest).
- ESLint **10.13.0**, `eslint-plugin-svelte` **3.23.1**, `@typescript-eslint/parser` **8.72.0**. Both plugins declare ESLint 10 support; the TypeScript parser supports TypeScript >=4.8.4 and <6.1.0. [ESLint metadata](https://registry.npmjs.org/eslint/latest), [Svelte plugin metadata](https://registry.npmjs.org/eslint-plugin-svelte/latest), [TS parser metadata](https://registry.npmjs.org/@typescript-eslint/parser/latest).
- Prettier **3.9.10**, `prettier-plugin-svelte` **4.1.1**, `prettier-plugin-tailwindcss` **0.8.1**, Lefthook **2.2.2**. [Prettier metadata](https://registry.npmjs.org/prettier/latest), [Svelte formatter metadata](https://registry.npmjs.org/prettier-plugin-svelte/latest), [Tailwind formatter metadata](https://registry.npmjs.org/prettier-plugin-tailwindcss/latest), [Lefthook metadata](https://registry.npmjs.org/lefthook/latest).

**Inference:** Node 22.17+ is the observed minimum for the current Kit path; an appropriately current supported Node 24 release is another candidate. Old advice to use Node 20 and Kit 2 is not a reliable current baseline. Kit 2 remains an explicitly supported alternative in Convex's client, but is not silently selected here. Resolve all CLI-generated dependencies together and retain a lockfile when implementation begins.

## How the requested tools fit

### SvelteKit, Convex, Tailwind and shadcn-svelte

**Facts:** Convex now documents `convex-svelte` directly: reactive subscriptions, mutations/actions, authentication and Kit SSR. Its examples distinguish Kit 3's `$app/env/public` and declared environment variables from Kit 2's `$env/static/public`. SSR helpers require Kit >=2.12 and have additional transport-hook setup. Therefore old wrappers and copied Kit 2 snippets should not be mixed into a Kit 3 project. [Convex Svelte overview](https://docs.convex.dev/client/svelte/overview), [SSR guide](https://docs.convex.dev/client/svelte/sveltekit-server-rendering).

Tailwind's first-party Kit guide uses `@tailwindcss/vite` alongside the SvelteKit plugin and a CSS import. shadcn-svelte documents a Kit installation and components copied into the project through its CLI. The current CLI supports Svelte 5 with Tailwind 4; Tailwind 3 uses its legacy registry path. [Tailwind installation](https://tailwindcss.com/docs/installation/framework-guides/sveltekit), [shadcn-svelte installation](https://www.shadcn-svelte.com/docs/installation/sveltekit), [CLI precondition source](https://github.com/huntabyte/shadcn-svelte/blob/main/packages/cli/src/utils/preconditions.ts).

**Inference:** The current Svelte 5 / Tailwind 4 path aligns with the requested linter. A legacy Tailwind 3 installation would conflict with `@shadcn/lint`'s documented Tailwind 4 target. shadcn-svelte supplies application UI, not the C++ editor. Its theme variables and an editor's theme configuration need coordination. Tailwind's modern browser baseline should inform supported devices; check its [compatibility requirements](https://tailwindcss.com/docs/compatibility) before promising older browsers.

### Exact shadcn-lint identity and limits

**Facts:** `@shadcn/lint`, owned by **shadcn-ui/lint**, checks Tailwind design-system rules and does not require shadcn/ui. Its Svelte guide uses `svelte-eslint-parser`, with the TypeScript parser nested for script content. Existing `eslint-plugin-svelte` parser configuration should be retained. A separate TS block covers helper calls outside components. It understands static classes, several conditional/array/object expressions, Svelte class/style directives and component aliases. The guide explicitly warns that Oxlint reads Svelte scripts but not template markup. [Project README](https://github.com/shadcn-ui/lint), [Svelte support and examples](https://github.com/shadcn-ui/lint/blob/main/docs/svelte.md).

**Inference:** The user's requested ESLint is the suitable route for template coverage. Configure deliberate design rules and exceptions; this tool is not a C++ submission linter, accessibility audit, or security boundary. Static analysis cannot guarantee the appearance of arbitrary runtime-generated classes. Neither a successful lint run nor a formatter proves gameplay correctness. The project is currently version 0.2.3, so pinning and reviewing upgrades is prudent rather than assuming mature/stable behavior.

### ESLint, Prettier and Lefthook

**Facts:** `eslint-plugin-svelte` provides recommended flat configuration and a Svelte/TypeScript parser arrangement. Its Prettier integration disables conflicting stylistic rules. [Svelte ESLint user guide](https://sveltejs.github.io/eslint-plugin-svelte/user-guide/).

Svelte formatter v4 supports Svelte 5 and Prettier 3. It directs users to load the Tailwind formatter **last**. Tailwind 4 class sorting requires `tailwindStylesheet` pointing to the actual CSS entry. Tailwind formatter 0.8.1 specifically restores Svelte v4-plugin class sorting; its 0.8.0 changelog raises the minimum to Prettier 3.7. [Svelte formatter README](https://github.com/sveltejs/prettier-plugin-svelte), [Tailwind formatter README](https://github.com/tailwindlabs/prettier-plugin-tailwindcss), [changelog](https://github.com/tailwindlabs/prettier-plugin-tailwindcss/blob/main/CHANGELOG.md).

Lefthook installs Git hooks and runs configured commands. Commands are sequential unless parallel mode is enabled, and hooks can explicitly be skipped. [Usage](https://lefthook.dev/usage/), [parallel configuration](https://lefthook.dev/configuration/parallel/).

**Inference:** ESLint handles code/design rules, Prettier handles repository formatting, and Lefthook invokes them. Read-only checks may run concurrently; two fixers writing the same files should not. Required CI checks are necessary if these are repository policy, because local hooks are bypassable. Svelte type checking/build validation remains distinct from linting. None of these developer tools supplies in-game C++ compilation or formatting by itself.

## Browser C++ editor choices

### Monaco

**Facts:** Monaco is a browser editor with models, edit history and providers for smart features. VS Code extensions do not automatically work in Monaco; its README also excludes mobile-browser support. The observed package is **0.57.0**. [Monaco README](https://github.com/microsoft/monaco-editor), [package metadata](https://registry.npmjs.org/monaco-editor/latest).

Its public API exposes theme switching, diagnostics markers, formatting providers, editor options, undo-aware edits, view-state capture and restoration. `onDidPaste` is a notification after paste, not a cancellable pre-paste authorization hook. [Public API definitions](https://github.com/microsoft/vscode/blob/main/src/vs/monaco.d.ts).

**Inference:** A strong candidate for a desktop IDE-like experience. C++ language mode/highlighting must not be advertised as clangd or full IntelliSense. Custom snippets and document-word completion are simulated assistance; markers populated after a compile are compiler feedback, not live LSP. A formatting provider still needs a formatter implementation. The editor can be integrated imperatively into Svelte without choosing a React wrapper.

### CodeMirror 6

**Facts:** `@codemirror/lang-cpp` **6.0.3** provides a Lezer C++ parser with highlighting and indentation. The separate first-party `@codemirror/lsp-client` **6.3.0** implements LSP client behavior, leaving transport, connection handling and disconnections to the application. It can communicate with a remote process or a JS/Wasm server. [C++ package README](https://github.com/codemirror/lang-cpp), [LSP package README](https://github.com/codemirror/lsp-client), [C++ metadata](https://registry.npmjs.org/@codemirror/lang-cpp/latest), [LSP metadata](https://registry.npmjs.org/@codemirror/lsp-client/latest). These repositories point to the project's newer code.haverbeke.berlin hosting.

The view supports DOM event handlers and themes; state compartments permit reconfiguring extensions without replacing the document. [View source](https://github.com/codemirror/view/blob/main/src/editorview.ts), [compartment source](https://github.com/codemirror/state/blob/main/src/facet.ts).

**Inference:** A viable composable alternative for selective effects. C++ parsing alone is not semantic name resolution or a compiler. Do not repeat outdated advice that CodeMirror has no first-party LSP client. No bundle-size, accessibility, mobile, or latency comparison was measured here; those remain prototype questions.

### Actual LSP, diagnostics and formatting

**Facts:** clangd interprets compile commands, include paths, macros, target and language-standard settings. Incorrect settings produce spurious diagnostics. [clangd compile-command documentation](https://clangd.llvm.org/design/compile-commands).

TypeFox's `monaco-languageclient` supports external language servers over WebSocket and browser-worker language servers. Its current README includes a C++ clangd/Wasm example and labels it a prototype. It maintains a compatibility table across Monaco, its client and VS Code service packages. A separate clangd-in-browser implementation requires SharedArrayBuffer/cross-origin isolation and suitable COOP/COEP headers. [TypeFox README and compatibility links](https://github.com/TypeFox/monaco-languageclient), [clangd-in-browser README](https://github.com/guyutongxue/clangd-in-browser).

ClangFormat is a C/C++ formatter usable separately from a language server. Prettier's core covers web languages; installing the Svelte/Tailwind plugins does not provide C++ formatting. [ClangFormat](https://clang.llvm.org/docs/ClangFormat.html), [Prettier plugins](https://prettier.io/docs/plugins).

**Inferences/options, not selections:**

- Basic editor plus compile-on-request diagnostics is the least operationally involved option, but must be described honestly as such. A “disable LSP” card has no meaningful target if no LSP exists.
- Remote clangd offers actual semantic assistance but introduces compute, process isolation, authenticated transport, per-player workspace separation and reconnect work. Its headers/toolchain should match the judge's C++ environment, including any supported GNU headers; clangd success is advisory, never acceptance.
- Browser clangd is actual LSP, not inherently fake. It shifts compute/download/memory to users and adds toolchain/header packaging and deployment-header constraints. Prototype status and cross-browser performance need validation. Cross-origin isolation can complicate third-party embeds and CAPTCHA resources; assess together rather than assuming compatibility.
- Formatting can use a separately hosted formatter or a separately vetted browser Wasm formatter. No browser formatter package was selected or benchmarked in this investigation.

## Candidate effects and recovery

The following are feasibility conclusions, not settled card rules.

- **Light mode:** Both editors can switch themes. Coordinate editor and surrounding UI, preserve the player's preferred theme, and recompute the effective theme when overlapping effects expire. A modified client can restore dark mode. Accessibility/high-contrast treatment remains a product choice.
- **Disable paste:** The clipboard specification permits cancelling ordinary paste events. Cancel the event before insertion; blocking Ctrl/Cmd+V alone misses context menus and other paths. Monaco's post-paste event is too late for this purpose; CodeMirror offers DOM handlers. Consider drop insertion and alternate insertion commands separately. [Clipboard specification](https://w3c.github.io/clipboard-apis/#clipboard-event-paste), [paste behavior](https://developer.mozilla.org/en-US/docs/Web/API/Element/paste_event). **Inference:** A modified client can remove handlers, set editor content programmatically, or submit externally edited source. Bulk text is not proof of paste; this remains honor-based.
- **Disable LSP:** **Inference:** Disable the actual semantic providers and clear their diagnostics/hover/completion UI; merely hiding suggestion popups leaves explicit completion, hover, code actions and formatting paths. Define whether word completion, snippets, syntax colors and compiler output survive. On recovery, synchronize the latest document and discard stale replies. A modified client can retain local assistance or use an external IDE. A server may deny its own remote LSP service while an effect is active, but cannot prevent external help.
- **Unformat source:** **Inference:** Decide between temporary visual disruption and actual buffer rewriting. Whitespace deletion is unsafe in C++: preprocessing, line comments, strings/raw strings, token separation and macros can change meaning. A reversible view effect is safer, but is a different card choice. For rewriting, retain a recovery checkpoint and use structured edits/undo boundaries; never restore a stale full snapshot over code typed during the effect. Players can undo/reformat externally, so text disruption is honor-based. Formatting restoration need not reproduce original layout exactly.
- **No `using namespace std`:** A server-side source rule can be authoritative if checked against the submitted source. A plain string match misses comments, spacing, preprocessing/macros and aliases. The existing clang-tidy `google-build-using-namespace` check flags using-directives generally, broader than just `std`. [Check documentation](https://clang.llvm.org/extra/clang-tidy/checks/google/build-using-namespace.html). **Inference:** Define the intended syntax/semantic restriction first and validate with compiler-aware tooling; do not silently ban every namespace directive. A compliant external editor cannot bypass a properly enforced submitted-source rule.
- **Strict compilation:** Compiler flags control warnings and conformance diagnostics. [Clang diagnostics reference](https://clang.llvm.org/docs/DiagnosticsReference.html). **Inference:** This can be authoritative in the judge, with a fixed compiler/version/standard/flags. Define treatment of warning-suppression pragmas and accepted extensions before promising that “warnings are impossible.” A disabled client warning display must not change server compilation.
- **CAPTCHA:** A browser modal alone is bypassable. Real verification services require server validation; Turnstile, for example, documents single-use tokens expiring after five minutes. [Server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/). **Inference:** A verified server gate can enforce a required completion before a protected action, but provider challenges are not guaranteed puzzle-like interruptions or equal difficulty. Choose whether this is an honor-based game puzzle or third-party verification, and define timeouts, accessibility and service failure behavior.

**Recovery requirements inferred from editor lifecycle capabilities:** Preserve current source, selection, scroll and undo history while reconfiguring effects. Derive current effects from authoritative state after reconnect/reload; a local timer alone is insufficient. Expiration should recompute all active effects, not blindly restore defaults. On mount/unmount, register and dispose editor resources, listeners, workers and providers; browser editors should initialize in the browser lifecycle rather than during SSR. [Svelte lifecycle documentation](https://svelte.dev/docs/svelte/lifecycle-hooks). Later prototypes should exercise overlapping effects, typing during expiration, undo/redo, navigation, reload, reconnect and delayed LSP/formatter responses. No such prototype was implemented here.

## Modified-client boundary and trusted execution

**Facts:** Convex public functions are accessible to clients; internal functions are not directly callable by clients. Server functions can obtain an authenticated identity. Convex mutations provide atomicity and serializable transaction behavior. [Internal functions](https://docs.convex.dev/functions/internal-functions), [function authentication](https://docs.convex.dev/auth/functions-auth), [OCC and atomicity](https://docs.convex.dev/database/advanced/occ).

**Inference:** An attacker controls displayed state, local timers, editor text, UI checks and outgoing requests. They can call public functions directly with their own credentials, replay requests and supply invented client timestamps/results. Invite-only UI does not authorize a caller. Neither an invite nor a valid login automatically grants access to a particular match. Server validation must cover membership, legal deck/effect actions, power expenditure and match phase. No hidden tests, privileged credentials or acceptance authority may be delivered to the browser; public responses and error details must not leak them.

Accepted results and round/match outcomes must originate from trusted execution and authoritative transitions. A modified browser may display a fake victory to itself, but must not alter either player's authoritative result. Atomic mutations help avoid two winners; they do not define what “first” means when judging jobs finish out of order. Submission-time versus trusted-acceptance ordering, ties, stale callbacks and effects changing while a submission is in flight need later decisions. This report intentionally does not design that protocol.

**Facts:** Convex's hosted functions are JavaScript/TypeScript, with a custom runtime and opt-in Node actions; actions can call third-party services. This is not documentation of a ready-made C++ judge or persistent clangd host. [Runtime capabilities](https://docs.convex.dev/functions/runtimes).

**Inference:** A separate trusted, isolated execution capability is still needed for arbitrary submitted C++, hidden tests and calibrated time/memory limits. Browser Wasm execution cannot establish authoritative acceptance or protect tests shipped to the client. Per-problem limits need reference and deliberately slow solutions on the selected hardware; no editor/library automatically rejects infeasible brute force. No focus-loss disqualification or external-help prevention guarantee is assumed.

## Cost and open decisions

**Facts:** Convex advertises a free offering and a $0/month pay-as-you-go Starter option; Professional is currently $25/developer/month. Its pricing lists included usage and metered resource charges. These are different billing modes, not a guarantee of unlimited free hosting. [Current pricing](https://www.convex.dev/pricing).

**Inference:** A small private alpha may fit free quotas; this research does not establish its workload. C++ judging and optional remote clangd necessarily consume compute, memory and operational effort even if existing hardware or free allowances cover the monetary bill. Browser LSP consumes client resources and asset bandwidth. Authentication/email, hosting, storage, logging and CAPTCHA costs depend on choices and quotas. No specific paid product, paid plan or custom domain is established as unavoidable; a zero-cost hosted service guarantee would be unsupported. Budget/resource caps and degraded-service behavior remain decisions.

Human follow-ups:

1. Confirm whether `@shadcn/lint` is the intended identity; the evidence strongly matches the request, but the original shorthand is not itself a package identifier.
2. Choose Monaco or CodeMirror after a bounded desktop/browser usability prototype; choose basic assistance, remote clangd or browser clangd separately. Do not couple editor selection to an unverified “built-in C++ LSP” claim.
3. Define effects' exact scope, duration/overlap/recovery behavior, accessibility treatment and honor-based status. Decide if any editor-only effect should remain a card given easy bypasses.
4. Select the C++ dialect/compiler/header policy and define strict-compilation and namespace restrictions. Judge choice, isolation, limits and outcome ordering require later architecture work.
5. Reconsider the first-acceptance power bonus: acceptance now ends the round, so an in-round bonus has no use. No replacement economy or card balancing is chosen here.
6. Set an alpha workload/budget and authentication/invite flow before asserting that free allowances suffice.

## Investigation limits and method

Read the research and context7-cli skills, repository instructions and domain/issue-tracker guidance, then the already-claimed ticket read-only. No glossary or ADR files were present in this checkout. Used `npx ctx7@latest library shadcn-svelte` followed by `docs /huntabyte/shadcn-svelte`; traced the results to first-party documentation/source. One Context7 explanation incorrectly described a Vite diff as removing the Kit plugin even though the diff retains it; this report follows the actual source and first-party Tailwind guide.

Current release/peer information was fetched directly from npm registry metadata, with repository ownership cross-checked. Browser-retrieval failures for CodeMirror documentation and an outdated Monaco typedoc path were worked around with first-party repository README/API source. No dependency installation/build, runtime editor test, latency measurement, security audit or cost simulation was performed. Thus compatibility is supported by declared peers and documented integrations, not claimed as experimentally proven. No app implementation, production APIs, tracker edits, PR, merge, or secret material is part of this artifact.
