# Model ownership

- **GPT-6.1-Sol** is the default for general work, including personal tooling and configuration.
- **Opus 5.5** owns production application and library code: architecture, API design, and implementation.

# Delegation

Work inline when the current model owns the task. Delegate when another model is required, or when an independent task benefits from parallel work or a separate context. Keep routine lookups and small tasks inline.

## Agent skills

### Issue tracker

Track issues and specs as local Markdown files under `.scratch/<feature>/`. Before creating, fetching, or updating tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five triage labels. Before triaging issues or changing their status, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`. Before exploring the codebase, read `docs/agents/domain.md`.
