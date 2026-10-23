# Free alpha hosting and C++ execution feasibility

Investigation date: **2026-10-22**. All linked sources are first-party pages inspected on that date. Unless a publication/update date is explicitly given below, the date is an access date, not an asserted publication date. Prices are USD before tax unless stated otherwise. This is feasibility research, not an architecture decision or deployment verification.

## Finding

A small private alpha can plausibly have a **$0 monthly provider invoice**, using Cloudflare free frontend hosting, Convex Free, and Modal's recurring compute credit. This is conditional on workload, billing controls, and eligibility; **Modal requires a payment method**. A second zero-invoice route is an Oracle Always Free VM running a separately configured judge sandbox, with materially greater operating work and availability risk. A paid VM offers a predictable baseline when free capacity or credit is unsuitable. None of these facts establishes a fair or secure judge implementation.

The options leave SvelteKit, Convex, Tailwind, shadcn-svelte, shadcn-lint, ESLint, Prettier, and Lefthook available. This investigation does not choose an adapter, judge service, sandbox runtime, cards, economy, or production API. Opus owns later application architecture and implementation.

## Workload assumptions and constraints

These are modeling assumptions, not measured timings or recommended problem limits:

- 20 invited players; 100 matches/month; up to five simultaneous matches (10 players). Each match uses up to three sequential rounds, ending as soon as someone wins two. Both players solve the same problem within a round; the first accepted submission ends that round.
- Budget the full three rounds and five submissions/player/round: **3,000 submissions/month**. Early match endings reduce this; retries and abandoned jobs can increase it.
- Typical job: 5 seconds compilation plus 10 seconds total test execution/overhead, at one physical CPU core and 1 GiB reserved memory. An intentionally conservative expensive job consumes 60 seconds total at the same reservation. Compilation needs its own bounds; template explosions and compiler memory exhaustion count as hostile work too.
- At most 64 KiB source, 64 KiB retained diagnostics/output per job, no network for submitted programs, and no persistent contestant workspace. These are proposed cost-model bounds, not settled product requirements.
- Example control-plane allowance: 100,000 Convex calls/month and 100 KiB database I/O/job, with 100 MiB additional monthly I/O. Subscriptions, source storage, indexes, status updates, other projects, and development deployments must fit too. No editor-keystroke synchronization or raw test-output streaming is included.

Invite-only reduces exposure; it does not make native code trusted or prevent a modified browser from spamming submissions. No focus-loss disqualification or external-help guarantee is assumed. Editor-only card effects can remain honor-based. The acceptance power bonus and other economy decisions do not change the need to bound expensive work.

## Verified provider facts

### Frontend: Cloudflare free Workers/Static Assets

Svelte's official adapter supports SvelteKit on Cloudflare Workers Static Assets and Pages; `adapter-static` is also an option when only browser assets are required. This proves deployment support, not that this application's eventual authentication and SSR dependencies fit unchanged. [Svelte Cloudflare adapter](https://svelte.dev/docs/kit/adapter-cloudflare)

Static asset serving is free and unlimited, with no asset-storage charge. SSR and other Worker invocations use Workers pricing. Free Workers allow 100,000 requests/day, 10 ms CPU/invocation, and 128 MB RAM; daily requests reset at midnight UTC. The limits page was updated **2026-10-12**. Exhaustion can reject requests; routing through Worker code first can also stop otherwise static traffic. [Asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Workers Builds includes 3,000 build minutes/month, one simultaneous build, and a 20-minute build timeout on Free; that page was updated **2026-05-29**. Local builds avoid using that hosted build allowance, but still consume the developer's resources. [Build quotas](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)

Cloudflare advertises Free without a credit card. Workers Paid starts at $5/month plus applicable overages; its per-invocation CPU control is not a total invoice cap. No Render-style 15-minute sleep rule was identified in the inspected Workers documentation; do not infer a guaranteed latency from that absence. [Cloudflare plans](https://www.cloudflare.com/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

**Inference:** a static-heavy UI with Convex handling authoritative data is comfortably plausible at this scale. Free SSR's 10 ms CPU bound should be measured with the chosen auth and rendering work. This runtime is not a native C++ judge sandbox.

### State and realtime: Convex Free

Current team-level Free allowances: 1 million function calls/month, 20 GB-hours action compute/month, 0.5 GB database storage, 1 GB/month database I/O, 1 GB file storage, and 1 GB/month file egress. Subscription updates and file accesses also count as calls. Free/Starter uses S16: 16 concurrent queries, 16 mutations, 64 actions per runtime, and eight scheduled jobs. Query/mutation user code has a one-second limit; actions have 30 minutes in the Convex runtime or 10 minutes in Node. [Convex limits](https://docs.convex.dev/production/state/limits)

Free has hard resource caps; Starter is $0 base plus metered overages, rather than an unlimited free upgrade. Professional starts at $25/developer/month. [Plans](https://www.convex.dev/pricing)

Daily/monthly deployment usage limits can disable new calls after a threshold; they reset on UTC calendar boundaries. They are resource guardrails, separate from team dollar spending limits. [Usage limits](https://docs.convex.dev/production/usage-limits)

Free overruns can produce HTTP errors, and usage is shared by the team's projects. The opened plan/FAQ pages did not establish a universal no-card signup guarantee or a numerical cold-start latency; verify those in the intended account, without budgeting any availability SLA. [Pricing FAQ](https://www.convex.dev/pricing/faq)

Convex documents JavaScript runtimes and Node actions, not a service for isolating adversarial native submissions. [Runtimes](https://docs.convex.dev/functions/runtimes)

**Inference:** the model's database I/O is about 0.39 GiB/month before index amplification and other reads, and source alone is at most 187.5 MiB/month. Retention can therefore exhaust free storage after a few months even with few players. At 512 MiB, waiting 15 seconds inside a Node action for every job would consume 6.25 GB-hours/month; waiting 60 seconds would consume 25 GB-hours, above the free allowance. Orchestration style affects costs; these numbers do not mandate one API design. Warmup/idle behavior must be measured, not assumed.

### Managed execution candidate: Modal Sandboxes

Modal explicitly offers Sandboxes for untrusted user code. Its documented isolation options are gVisor and a VM runtime; Sandboxes do not get default authority over other Modal workspace resources. **Outbound internet is allowed by default**; full network blocking is available and also closes the otherwise allowed DNS path. [Sandbox purpose/lifetime](https://modal.com/docs/guide/sandboxes), [Networking and isolation](https://modal.com/docs/guide/sandbox-networking)

Starter has $0 subscription, **$30 recurring monthly credits**, three workspace seats, 100-container concurrency, and 1 TiB/month included egress. This is recurring credit, not a one-time signup trial. Sandbox pricing is specifically **$0.00003942/physical-core-second + $0.00000667/GiB-second**, at non-preemptible rates; ordinary Function CPU prices understate it. Selected regions can add multipliers. [Current pricing](https://modal.com/pricing)

Sandboxes are charged per second at the greater of requested and actual CPU/memory; requests are not upper bounds. Explicit burst limits exist. CPU limiting is documented as soft throttling; memory has an OOM hard limit. [Sandbox resources](https://modal.com/docs/guide/sandbox-resources), [Limit semantics](https://modal.com/docs/guide/resources)

A payment method is required, and usage beyond credits can be charged automatically, including during a billing cycle. Workspace budgets cap gross usage before credits; a separate spend limit caps net charges. The default spend limit can exceed zero. Environment budgets require a paid plan. [Billing](https://modal.com/docs/guide/billing), [Budgets](https://modal.com/docs/guide/budgets)

Sandboxes default to a five-minute maximum lifetime, configurable to 24 hours. Idle timeout is separate, and a running command counts as activity. The JS reference describes booting in seconds, not a guaranteed startup percentile. [Lifetimes](https://modal.com/docs/guide/sandboxes), [JS Sandbox reference](https://modal.com/docs/sdk/js/latest/Sandbox)

**Inference:** a baked C++ toolchain and disposable job sandbox are feasible primitives, but no toolchain, isolation configuration, cold-start distribution, or integration with Convex was exercised. Runtime selection and account-specific limits require a short validation spike. Do not place provider credentials, judge result authority, expected outputs, or the complete hidden-test corpus in a workspace readable by contestant code. An outer sandbox alone does not protect trusted files from other processes inside it.

### Free VM candidate: Oracle Cloud Always Free

Current published allowance is **1,500 A1 OCPU-hours + 9,000 GB-hours/month**, described as **2 Arm OCPUs and 12 GB RAM**, plus 200 GB block storage across boot/data volumes. This differs from older 4-OCPU/24-GB descriptions. Two AMD Micro VMs are also eligible, each only 1/8 OCPU and 1 GB RAM. Compute must be in the home region; free capacity can be unavailable. Idle instances may be reclaimed when seven-day 95th-percentile CPU and network utilization are below 20%, and memory too for A1. [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

Most signups require a phone number and credit card. The **$300/30-day trial** is separate from Always Free; paid trial resources are reclaimed unless upgraded. [Free Tier rules](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)

gVisor supports AMD64 and ARM64. Its default systrap platform avoids requiring hardware virtualization, but platform/kernel compatibility and C++ behavior still need checking on the chosen VM image. [Supported architectures](https://gvisor.dev/docs/user_guide/faq/), [Platforms](https://gvisor.dev/docs/architecture_guide/platforms/)

**Inference:** Cloudflare + Convex Free + an A1 VM with an operator-configured sandbox could incur no provider invoice. The VM itself is not the contestant isolation boundary. Kernel patching, sandboxing, network denial, process/resource limits, cleanup, queue operation, and recovery remain operator work. Do not assume free capacity will be available for an event or run artificial load to evade reclamation. Arm benchmarks cannot be copied directly from an x86 judge. A normal VM has no serverless sleep penalty, but reclamation recovery is much more disruptive.

### Paid VM fallback and frontend alternatives

A DigitalOcean Basic example is **$12/month for 1 vCPU, 2 GiB RAM, 50 GiB disk, and 2,000 GiB transfer**. This is ongoing paid compute, not a sustainable free tier. Payment methods include cards and PayPal; spending alerts generally do not cap infrastructure usage. [Droplet pricing](https://www.digitalocean.com/pricing/droplets), [Payment methods](https://docs.digitalocean.com/platform/billing/manage-payment-methods/), [Spend alerts](https://docs.digitalocean.com/platform/billing/spend-alerts/)

**Inference:** Cloudflare + Convex Free + that VM with gVisor is another feasible combination, with a $12 monthly baseline before taxes, optional backups and excess usage. It likely needs a one-job queue at this size; it is not evidence of five-match throughput or suitable compiler memory headroom. A spare Linux machine is another execution location, with electricity, connectivity, uptime, and administration costs rather than a cloud invoice.

Vercel is an alternative frontend via the official Svelte adapter. Hobby is restricted to personal, noncommercial use; current allowances include 4 active CPU-hours, 360 GB-hours memory, 1 million function invocations and 100 GB fast transfer. Most exhausted features can remain unavailable for up to 30 days. This research did not verify a universal card requirement or cold-start bound. Use with the same separate judge, not ordinary frontend Functions as the C++ sandbox. [Svelte adapter](https://svelte.dev/docs/kit/adapter-vercel), [Hobby limits/terms](https://vercel.com/docs/plans/hobby)

Render supports SvelteKit Node or static deployment. Free web services sleep after 15 minutes idle and take about a minute to wake; 750 running instance-hours are shared per workspace/month. Files disappear on restart/sleep. Without a payment method, overages can suspend services instead of charging; this is not a universal no-card onboarding guarantee. Free instances can also restart arbitrarily. Thus Render is a possible frontend, but its free web service is unattractive for latency-sensitive judging, and these docs do not establish an adversarial native-code isolation facility. [SvelteKit deployment](https://render.com/docs/deploy-sveltekit), [Free limitations](https://render.com/docs/free)

## Derived cost and contention model

These calculations use the Modal **Sandbox** rates above with no region premium. They assume one physical core and 1 GiB charged throughout, no bursting, and prompt termination. Build, controller, cold-start, transfer, storage, and retry charges are additional; this is not an invoice quote.

- Per sandbox-second: `0.00003942 + 0.00000667 = $0.00004609`.
- Typical month: `3,000 × 15 s = 45,000 s`; **$2.07** gross judge compute.
- Expensive month: `3,000 × 60 s = 180,000 s`; **$8.30** gross judge compute.
- Each extra five billed seconds/job adds **$0.69/month**. A compiler needing 2 GiB changes the memory term; this must be benchmarked. The $30 credit nominally covers about **180.8 sandbox-hours** at the modeled allocation, before any other credit usage.
- A five-match simultaneous-submit burst is ten jobs. At 15 seconds/job, two execution slots need five waves: approximately **75 seconds** to finish the burst, with the last wave waiting about 60 seconds. Ten slots finish in roughly 15 seconds plus startup, with the same modeled compute charge (**$0.0069**). A fixed two-core VM cannot turn its low monthly CPU consumption into ten instantaneous cores.
- One player bypassing the UI and submitting once per second for one hour creates 3,600 jobs. At 60 seconds each, that's **60 sandbox-hours / $9.96** and roughly 60 concurrent jobs in steady state. Two such players approach/exceed Starter container concurrency; queued retries may prolong depletion after they stop.
- Ten one-core loops left running continuously cost **$39.82/day**, or roughly **$1,194.65/30 days** before credits. With a mandatory 60-second outer lifetime, one burst of ten costs about **$0.0277** instead. Repeated bursts still burn budget. Idle timeouts alone do not stop an active infinite loop.
- With an illustrative server-enforced limit of 30 jobs/player/day, 20 accounts could still consume 600 expensive jobs/day: **$1.66/day**, about **$49.78/30 days**. A daily global cap of 200 such jobs is **$0.55/day / $16.59 per 30 days** for execution alone. These figures show the tradeoff; they do not select caps.

A loop's wall timeout also needs whole-process-tree termination. Fork bombs, memory/disk/output floods and compiler abuse need separate bounds; CPU seconds per test are insufficient. Per-problem performance limits must be calibrated to reject infeasible brute force on the actual runtime, while an aggregate job ceiling bounds many-test multiplication. Shared-host noise and queue order can affect a first-acceptance race even when the invoice is small.

## Recommendations to consider, not decisions

1. Validate Cloudflare Free + Convex Free + Modal Sandboxes first if a payment method and recurring-credit dependency are acceptable. Explicitly set a net spend ceiling and gross usage budget, check actual enforcement in that account, and leave headroom for in-flight work rather than treating the displayed budget as a precise per-job meter.
2. Consider Oracle only if its capacity, Arm target, potential reclamation, and ongoing administration are acceptable. Keep a paid or local execution fallback for scheduled play. Consider a paid VM if invoice predictability matters more than avoiding a baseline charge.
3. Whatever host is selected, require authoritative invitation checks and admission limits before expensive work: one outstanding submission/player, source/output caps, bounded queue/concurrency, per-account and global quotas, bounded retries, and an operator kill switch. Browser controls and provider-wide caps are insufficient. Closing a round must prevent stale/in-flight results from changing its winner or awarding power; outage and queue fairness rules remain product decisions.
4. Keep only necessary diagnostics and protect tests/results at the trusted judge boundary. Private hosting is not itself an authorization scheme. Sandbox filesystem access, stdout/stderr and network behavior must not expose hidden expected answers or permit spoofed acceptances.

## Costs, evidence gaps, and choices left open

There is **no demonstrated unavoidable recurring provider fee** for the modeled small alpha. The unavoidable consumption is compute, bandwidth/storage, administration, and any local electricity; free allowances or credits can currently cover provider charges. A domain is optional using provider subdomains; custom domains, paid auth/email, backups, region premiums, taxes, overages, or a paid fallback can create real costs. No signup trial is counted as a permanent subsidy.

Before choosing: decide acceptable payment-method exposure and monthly ceiling; static-only versus SSR needs; maximum simultaneous matches and waiting time; source/result retention; per-problem test budgets and compiler headroom; event availability expectations; and what happens to a first-acceptance race during cold start, throttling, outage, or unequal queue delay. The shared card pool and deck rules remain open and impose no demonstrated hosting subscription.

No cloud accounts were created, credentials requested, native submissions executed, or latency/security benchmarks run. This is a shortlist, not an exhaustive comparison of every cloud or a provider security audit. A later bounded deployment spike must verify C++ compilation, malicious-work termination, hidden-test secrecy, budget enforcement and actual account quotas before claiming a usable alpha. No production API or implementation is specified here.
