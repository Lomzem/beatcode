# Model ownership

Use GPT-6.1-Sol for implementation, architecture and ordinary reviews. Use GPT-6-Luna for the user-requested test-audit swarm. The user requires OpenAI/Codex agents only.

# Delegation

Work inline when the current model owns the task. Delegate when another model is required, or when an independent task benefits from parallel work or a separate context. Keep routine lookups and small tasks inline.

## UI priorities

Accessibility and responsive usability are top priorities for all UI work, ahead of visual polish. Before designing, implementing, or reviewing UI, read [UI accessibility and responsive design](docs/agents/ui.md). Target WCAG 2.2 AA across complete user flows, including game effects and authentication.

Use T3's collaborative `preview_*` tools for interactive UI inspection and verification. The linked UI guide defines the browser workflow and evidence requirements.

## TypeScript and tooling

Before implementing or reviewing TypeScript, dependency changes, or CI commands, read [Effect and Bun conventions](docs/agents/typescript.md).

## Agent skills

### Issue tracker

Track issues and specs as local Markdown files under `.scratch/<feature>/`. Before creating, fetching, or updating tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five triage labels. Before triaging issues or changing their status, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`. Before exploring the codebase, read `docs/agents/domain.md`.
