# UI accessibility and responsive design

Accessibility and responsive usability are release requirements. Apply these rules when designing, implementing, or reviewing UI.

1. Design the full interaction for keyboard, assistive technology, touch, narrow screens, and zoom before adding visual polish. Prefer semantic HTML and accessible shadcn-svelte primitives.
2. Implement layouts that reflow from 320 CSS pixels to desktop. Verify 200% text zoom and 400% browser zoom. Keep necessary two-dimensional editor scrolling inside the editor; adapt surrounding controls and content. A blanket desktop-only screen does not satisfy this requirement.
3. Before completing a UI change, run automated accessibility checks and manually verify keyboard/focus behavior, a screen-reader path, contrast, narrow layouts, and zoom. Record coverage and remaining issues; an automated scan alone does not establish conformance.

Use T3's collaborative `preview_*` tools for interactive browser work. Start with `preview_status`; call `preview_open` if no automation-capable tab is available. Inspect with `preview_snapshot` and use its locators for interactions. Respect human-controlled tabs; read them or open your own tab instead of taking over.

Verify the implemented UI at narrow and wide viewports, exercise keyboard/focus and recovery flows, inspect browser diagnostics, and capture screenshot evidence with `preview_snapshot(save=true)` when useful. Prefer this shared browser over standalone browser automation for interactive checks; keep automated browser regression tests in CI. Snapshots and screenshots support review but do not replace assistive-technology testing.

Run containerized browser checks with the workspace user's UID and GID so generated files remain writable by the dev server. Serialize builds and checks with `.scratch/competitive-leetcode/build.lock` in the shared checkout.

Target [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/). Provide accessible names, labels and errors, visible focus, dialog focus restoration, adequate contrast and target sizes, and status feedback independent of color. Support reduced motion and user contrast preferences.

Design for competitive programmers and computer science enthusiasts using a coding tool. Lead with rooms, problems, code and match actions. Use familiar programming terminology and compact, descriptive headings. Omit marketing heroes, taglines, subtitles, promotional badges and decorative labels.

Give the tool a distinctive visual identity through expressive typography, bold solid colors, asymmetry and purposeful interaction. Accessibility constrains readability and interaction, not personality. Avoid generic business-software presentation.

Use progressive disclosure: show the current task, primary action and necessary feedback first. Put optional rules, detailed limits, diagnostics and secondary preferences behind clearly named disclosures. Keep errors and time-sensitive match state visible. Prefer a short useful screen to an inventory of every capability.

Keep layouts stable through first paint, font loading, authentication and live updates. Prerender public content where possible, reserve space for asynchronous controls, and preload only critical fonts and safe route resources. Measure layout shifts under delayed loading; faster fetching alone does not resolve changing geometry.

Use shadcn-svelte Select for dropdown selection, with associated labels, keyboard operation, visible focus and persisted values where applicable; do not substitute native select controls.

Use plain sections, lists, tables and restrained separators. Avoid generic card containers, boxed feature grids, oversized rounded panels and decorative icons. The game’s playable cards remain functional deck controls; their presentation should be compact and useful.

Use solid colors. Avoid gradients in backgrounds, text, borders and controls.

Keep accessibility requirements and verification evidence in internal documentation. Expose useful accessibility settings in the app, without a public accessibility-report page or implementation-progress explanations.

Cards preserve source, navigation, assistive technology, and accessible controls. Theme effects retain readable contrast. Challenges need accessible interaction; timers and interruptions require explicit evaluation of applicable timing criteria and exceptions. Change a card that cannot meet these requirements.

UI reviews and CodeRabbit instructions must check these requirements. Resolve accessibility and responsive regressions before merge; claim conformance only with supporting evidence.
