# Local development and review gates

Use local execution for iteration and hosted services for the integration evidence that requires them. Rate-limit savings never substitute for required verification or approval.

## Development loop

1. Inspect the relevant package scripts, test configuration and environment before running a command. Identify its service targets and side effects; a localhost frontend can still contact hosted Convex, Clerk or Modal. Keep credentials out of diagnostics.
2. Iterate with the smallest relevant local checks. Prefer `convex-test`, existing mocked judge/operator tests and the fixture browser suites under `tests/game-ui` and `tests/auth-return` for behavior they cover. Keep fixtures in test harnesses; preserve the application's real unavailable states.
3. When a running backend is needed, select a local Convex deployment using the installed CLI's supported options, then verify both the CLI target and frontend URL point to it. Check the installed CLI's help before changing deployment selection; keep environment changes ignored and scoped to this checkout. Plain `convex dev` can use an already configured cloud deployment.
4. Reuse a compatible local backend/server instead of starting one per agent or check. Assign one owner to shared services, serialize backend sync/codegen and follow the build lock in `typescript.md`. Stop owned watchers, subscriptions and test resources when finished.
5. Broaden verification once the change stabilizes. Reuse results only while the relevant source, configuration and environment remain unchanged; rerun checks affected by subsequent fixes.

## Hosted services

- **Convex:** use local data and bounded seed fixtures. Reserve cloud sync, deployment, imports and authenticated integration runs for behavior that needs the hosted environment. Avoid cloud watchers during local edits, repeated full seeds, query/log polling and duplicate subscriptions. Local Convex actions can still call external services; inspect those dependencies too.
- **Clerk and OAuth:** use fixture authentication for routine tests. Reserve real sign-ins, account creation, email/SMS challenges and provider redirects for authentication integration coverage. Use the existing authenticated runner's account lifecycle and cleanup rather than creating accounts per retry.
- **Modal and judge providers:** use existing local fakes for orchestration changes; reserve real sandbox executions and calibration for changes requiring that evidence. Keep runs bounded, preserve configured spend/resource caps and await cleanup.
- **GitHub Actions and deployment providers:** batch locally verified changes into one push per prepared revision. Draft PRs can still trigger CI, including shared Convex deployment and Clerk account activity. Keep cloud runs serialized through the existing CI runner and concurrency controls; a local run against that shared backend must not overlap CI. Preserve required checks and production deployment gates.
- **APIs and tools:** reuse fetched docs, review findings and logs for the same revision. Prefer event-driven notifications over repeated status calls. Coordinate delegates so they share evidence rather than each repeating hosted setup or review requests.

If local execution cannot cover a required behavior, record the gap and run the smallest hosted check that resolves it. Count that result toward the prepared revision rather than repeating it without a relevant change.

## Before CodeRabbit

Follow `~/.agents/PR-WORKFLOW.md` for PR follow-through. Apply this gate before the first external review and again after review-driven fixes:

1. Complete internal review of the full diff against the intended base: requirements, repository standards, correctness, security and applicable UI/accessibility rules. Use the repository's model ownership for reviewers and fixes. Resolve every actionable finding or record an evidence-backed disposition; changes after review require review of the affected diff.
2. Pass applicable local checks for the prepared revision. Record the reviewed base, revision or diff fingerprint, findings/dispositions, checks and any outstanding hosted verification in the task record. Internal review and local checks must be complete before pushing a review candidate.
3. Keep any PR a draft during preparation and CI repair. Verify automatic CodeRabbit review is disabled or paused before pushing; inspect the effective settings for label/description opt-ins. The repo disables `reviews.auto_review.enabled` in `.coderabbit.yaml`; draft status alone does not prevent a manual request. Batch any CI fixes through the same local review/check gate.
4. Once all applicable deterministic CI checks pass on the current head and internal findings are resolved, request one CodeRabbit review for that head when required. CodeRabbit is the final external review gate. Keep automatic review disabled during repairs; batch valid fixes, repeat internal review and checks, then request one incremental review of the new prepared head. Use a full review only when coverage or recovery requires it.
5. Record the reviewed head and outcome. A skipped, incomplete or rate-limited review remains pending, as does required hosted verification that could not run. Preserve required approval and merge gates.

## When throttled

On a 429, quota warning or provider cooldown, stop the affected automated loop and coordinate all consumers of that allowance. Honor `Retry-After` or the provider's reset time; without one, use bounded exponential backoff with jitter and a finite retry budget. Retry writes only when safe to repeat. Continue independent local work while the service is unavailable. Avoid account/key rotation or duplicate jobs to bypass limits.

Record the provider, affected operation/revision, retry time, attempts and remaining verification in the task record without secrets. Resume with one coordinated attempt after the cooldown. Treat an exhausted usage or spend quota as blocked on availability rather than retrying continuously; report the outstanding gate.

## References

- [Convex local deployments](https://docs.convex.dev/cli/local-deployments)
- [CodeRabbit automatic review controls](https://docs.coderabbit.ai/configuration/auto-review)
- [CodeRabbit review commands](https://docs.coderabbit.ai/guides/commands)
- [CodeRabbit rate limits](https://docs.coderabbit.ai/management/rate-limits)
