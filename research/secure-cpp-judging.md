# Secure C++ judging and practical complexity gates

Ticket: `01-secure-cpp-judging` (wayfinder research, map: Beatcode private competitive programming alpha)
Investigation date: **2026-10-22**. Every volatile fact below (versions, prices, quotas, API policies) was read on that date and should be re-checked before implementation.

Labels used throughout:
- **Fact**: stated by the cited primary source (docs, source code, spec, vendor pricing page).
- **Inference**: my reasoning from those facts. Not a vendor claim.
- **Unverified**: could not be confirmed from a primary source on the investigation date.

This report does not select an architecture or define APIs. Those decisions belong to Opus under `AGENTS.md`.

---

## 1. Short answer

1. **Browser-only scored judging does not meet the agreed threat model.** To judge, the browser needs the hidden tests. Whoever controls the browser controls the verdict it reports, and the server cannot tell a genuine "accepted" from a forged one. This is inherent, not an implementation gap (§3).
2. Untrusted C++ has to be compiled **and** run in a server-side sandbox the players cannot reach. The sandbox should keep hidden tests outside the submission's reach until each run, enforce per-problem limits, and report results through a channel the app server authenticates. The app server, not the judge or the client, decides who won the round (§4–§6).
3. Feasible options, all subject to the caveats in §7:
   - **Self-hosted sandbox primitive:** [isolate](https://github.com/ioi/isolate) (IOI/CMS lineage) or [nsjail](https://github.com/google/nsjail), with a small judge worker you write. Optionally run it inside a [gVisor](https://gvisor.dev/docs/) or VM boundary.
   - **Self-hosted judge product:** [Judge0](https://github.com/judge0/judge0) v1.13.1, [DMOJ judge-server](https://github.com/DMOJ/judge-server), or [Piston](https://github.com/engineer-man/piston).
   - **Managed:** Judge0 Cloud through RapidAPI or judge0.com plans.
   - **Not viable as the judge:** Convex itself (no documented native-process sandbox), and the public Compiler Explorer and Piston APIs, for policy and privacy reasons.
4. **No judge proves asymptotic complexity.** Whether a program runs within a bound is undecidable in general. Judges approximate it empirically: a calibrated CPU-time limit, plus adversarial maximum-size tests, plus reference "should-TLE" brute-force solutions that confirm the limit actually rejects them. Kattis's problem package format codifies this practice (§8).
5. **A free alpha is feasible only by self-hosting on an always-free VM.** Oracle Always Free is the strongest candidate but has documented capacity and idle-reclamation caveats. GCP e2-micro is likely too small. Every managed judge or container service found has either a tiny free quota or a paid baseline (§7).

---

## 2. Threat model recap (from the map; not re-decided here)

- Server-authoritative state covers match state, card power and costs, submissions, accepted results, and hidden tests.
- Editor-only card effects may be honor-based.
- There is no focus-loss disqualification and no guarantee against external help.
- Implied adversary: a player who fully controls their browser. They can edit JavaScript, replay or forge requests, read anything sent to their client, and submit hostile C++ intended to escape the sandbox, read tests, exhaust resources, or game timing.

---

## 3. Why browser-only scored judging fails the model

**Facts:** Running C++ in a browser requires compiling it there (for example, a clang build targeting WebAssembly) and feeding it test inputs locally. To check correctness, the browser also needs expected outputs or a checker.

**Inference:**
1. **Hidden-test secrecy breaks.** Any input or expected output delivered to the client can be read in devtools. Encryption doesn't help, because the client must hold the key to run the tests.
2. **Accepted results are forgeable.** The server receives only a claim ("passed all tests at time T"). Nothing on the server distinguishes a real run from `fetch('/accept')`. A signature computed in the browser uses a key the attacker holds.
3. **Ordering is forgeable.** Client timestamps are attacker-controlled, so "first acceptance" can't come from client clocks.
4. **Limits are unenforceable.** CPU and memory limits enforced by a tampered client are honor-based by definition. The map puts judge-enforceable restrictions on the judge.
5. Mitigations such as re-running on the server afterward, or only "spot-checking" the browser, collapse into server-side judging for every scored result.

**Conclusion (inference):** Browser compilation can still be used for **unscored** convenience features, such as sample-test runs or quick feedback, consistent with editor effects being honor-based. Any result that changes match state has to come from a server-side judge.

---

## 4. Sandbox and isolation options (facts)

### 4.1 isolate (IOI)
Source: [isolate(1) manual](https://github.com/ioi/isolate/blob/master/isolate.1.txt). Latest tag is v2.7, dated 2026-08-23 ([tags](https://github.com/ioi/isolate/tags)).

- **Limits:**

  | Flag | Limit |
  |---|---|
  | `-t` | CPU time |
  | `-w` | Wall time |
  | `-x` | Extra time |
  | `-m` | Per-process address space |
  | `--cg-mem` | Whole-cgroup memory |
  | `-p` | Processes or threads (default 1) |
  | `-f` | Per-file size |
  | `-k` | Stack |
  | `-n` | Open files |
  | `-q` | Disk quota |

- **Network:** A new network namespace by default, with loopback only. `--share-net` disables this.
- **cgroups:** Requires cgroup v2 (systemd `isolate.service`, `isolate-cg-keeper`). Memory reporting needs Linux ≥5.19. "Running in containers is not recommended unless they are privileged."
- **Meta-file output:** `time`, `time-wall`, `max-rss`, `cg-mem`, `status` (RE/SG/TO/XX), `exitsig`, `killed`.
- **Documented caveats:**
  - Disable swap, since memory limits don't cover swapped data.
  - Set `protected_hardlinks=1`.
  - systemd-coredump captures sandbox core dumps.
  - Avoid `--share-net`, `--inherit-fds`, `--special-files`, and relaxing `--syscalls`.
  - Shared inodes and file locks can leak between concurrent sandboxes.
  - Other workloads on the machine distort timing.

### 4.2 nsjail (Google)
Source: [google/nsjail](https://github.com/google/nsjail). Apache-2.0, "not an official Google product".
- **Isolation:** Namespaces (UTS, mount, PID, IPC, NET, USER, cgroup, time), cgroups v1/v2 (memory, pids, CPU), seccomp-bpf via Kafel policies, and rlimits (CPU, address space, nofile, nproc).
- **Limits:** Wall `time_limit` (default 600 s), `rlimit_cpu`, `rlimit_as`, `cgroup_mem_max`, `cgroup_pids_max`, `cgroup_cpu_ms_per_sec`.

### 4.3 gVisor
Source: [gvisor.dev/docs](https://gvisor.dev/docs/).
- A userspace application kernel (Sentry) intercepts syscalls instead of passing them to the host. It's an OCI runtime (`runsc`) for Docker and Kubernetes.
- **Documented costs:** Higher per-syscall overhead, Go runtime overhead, and incomplete syscall, `/proc`, and `/sys` coverage.
- **Inference:** It adds defense in depth around a sandboxed judge. Typical competitive programming code makes few syscalls, so the overhead hits mostly I/O-heavy tests. Calibrate time limits *inside* whatever runtime you deploy (§8).

### 4.4 DOMjudge judgehost (reference practice, not a fit as a product)
Source: [DOMjudge judgehost install](https://www.domjudge.org/docs/manual/main/install-judgehost.html).
- Uses `runguard`, a read-only chroot, cgroup v2 (v1 no longer supported; kernel ≥5.19 or 6.0), and an unprivileged run user with no home or shell.
- Recommends one judgedaemon per core, binding with `-n`, `isolcpus`, avoiding CPU 0 on VMs, and disabling hyperthreading for timing stability.
- **Inference:** DOMjudge is a whole contest system, so it's a poor fit as an embedded judge for this app. Its timing-stability guidance applies to any self-hosted judge.

---

## 5. Judge products: self-hosted and managed

### 5.1 Judge0 (GPL-3.0)
Sources: [repo](https://github.com/judge0/judge0), [releases](https://github.com/judge0/judge0/releases), [CHANGELOG](https://github.com/judge0/judge0/blob/master/CHANGELOG.md), [CE API docs](https://ce.judge0.com/), [Extra CE languages](https://extra-ce.judge0.com/languages), [`judge0.conf`](https://github.com/judge0/judge0/blob/master/judge0.conf), [`isolate_job.rb`](https://github.com/judge0/judge0/blob/master/app/jobs/isolate_job.rb), [`docker-compose.yml`](https://github.com/judge0/judge0/blob/master/docker-compose.yml), [security advisories](https://github.com/judge0/judge0/security).

**Facts:**
- **Latest release:** v1.13.1, dated 2024-04-18. It fixed three critical sandbox escapes:
  - CVE-2024-28185: symlink escape ([GHSA-h9g2-45c8-89cf](https://github.com/judge0/judge0/security/advisories/GHSA-h9g2-45c8-89cf)).
  - CVE-2024-28189: chown-on-symlink patch bypass ([GHSA-3xpw-36v7-2cmg](https://github.com/judge0/judge0/security/advisories/GHSA-3xpw-36v7-2cmg)).
  - CVE-2024-29021: SSRF from the default network configuration leading to root code execution ([GHSA-q7vg-26pg-v5hr](https://github.com/judge0/judge0/security/advisories/GHSA-q7vg-26pg-v5hr)).
- **Deployment:** v1.13.1 tells Ubuntu 22.04 users to boot with `systemd.unified_cgroup_hierarchy=0`, which is legacy cgroup v1. The compose file runs workers with `privileged: true` on `judge0/judge0:latest`. The Dockerfile is based on `judge0/compilers:1.4.0`. Judge0 collects telemetry (TELEMETRY.md).
- **C++ toolchains on the hosted CE:** GCC 7.4.0, 8.3.0, and 9.2.0 (ids 52–54).
- **C++ toolchains on Extra CE:** Clang 9.0.1 and 10.0.1, plus GCC 8.4.0 only in "C++ Test" (gtest) and MPI variants.
- **Per-submission limits:** `cpu_time_limit`, `cpu_extra_time`, `wall_time_limit`, `memory_limit`, `stack_limit`, `max_processes_and_or_threads`, `max_file_size`, `number_of_runs`, `enable_network`, `compiler_options`. Server-side `MAX_*` caps clamp them. Public CE caps: CPU 15 s, wall 20 s, memory 256000 KB.
- **Statuses:** Accepted, WA, TLE, CE, several RE variants, and Internal Error. One stdin and expected_output pair per submission. Batches hold up to 20 by default (`MAX_SUBMISSION_BATCH_SIZE`).
- **Config defaults:** Users may set `compiler_options` and `command_line_arguments` by default (`ENABLE_COMPILER_OPTIONS`). `ALLOW_ENABLE_NETWORK` defaults to true, and the network itself is off by default (`ENABLE_NETWORK`).
- **Authentication:** Optional `AUTHN_TOKEN` (`X-Auth-Token`) and `AUTHZ_TOKEN`, plus `ALLOW_IP`.
- **Callbacks are unsigned.** `call_callback` sends `HTTParty.put(callback_url, body, headers: {"Content-Type" => "application/json"})` with no signature or secret, as seen in `isolate_job.rb`.
- **Managed pricing on judge0.com:**

  | Plan | Monthly price | Submissions/day |
  |---|---|---|
  | Pro | €27 | 2,000 |
  | Ultra | €54 | 5,000 |
  | Mega | €107 | 10,000 |

  Overage is €0.001 per submission. Sign-up runs through RapidAPI.
- **Unverified:** The free RapidAPI "Basic" tier is reportedly 50 submissions/day. The RapidAPI pricing page renders client-side and could not be read.

**Inferences:**
- The fixed escapes show the risk of running an off-the-shelf judge with default settings. If self-hosted, harden the configuration: auth on, compiler options and network toggles off, no public exposure.
- Because callbacks are unsigned, the receiver must treat a callback only as a hint. Options include re-fetching the result over an authenticated channel, or wrapping the judge with a component that signs results (§6).
- Releases have stalled since 2024. Old pinned GCC versions, cgroup v1, and privileged containers conflict with modern hosts and with modern C++ (GCC 9.2 has incomplete C++20).
- The hosted CE's maximum of 256 MB memory may constrain some problems.
- Under a managed plan, hidden inputs and expected outputs are sent to a third party with every submission.
- A multi-test problem means N submissions, or a custom runner, under managed per-submission quotas. For example, 30 tests × 10 attempts × 6 rounds is about 1,800 submissions per match. That would exhaust a 50/day free quota at once and approach the Pro tier's daily cap.

### 5.2 DMOJ judge-server (AGPL-3.0)
Source: [DMOJ/judge-server](https://github.com/DMOJ/judge-server).
- **Facts:**
  - Secure grading on Linux (x64 and ARM tested) and FreeBSD.
  - The current sandbox is seccomp-based. Versions through v3.0.2 also supported pure ptrace. Docker needs `SYS_PTRACE`. No root required on Linux.
  - Executors for C++11/14/17/20/23 with GCC and Clang.
  - Connects to a DMOJ site through a judge name and key, with optional TLS. The site should not expose the judge port publicly. `dmoj-cli` handles local testing.
- **Inference:**
  - Modern standards are available, and it's built for contest judging (batched tests, checkers).
  - Its protocol expects a DMOJ "bridge" site. Embedding it in a Convex app needs an adapter.
  - AGPL obligations apply if it's modified and offered over a network.

### 5.3 Piston (MIT)
Source: [engineer-man/piston](https://github.com/engineer-man/piston).
- **Facts:**
  - Uses isolate inside Docker with cgroup v2. The example runs `--privileged`.
  - Per-request limits: `run_timeout`/`compile_timeout` (wall), `run_cpu_time`/`compile_cpu_time`, and `run_memory_limit`/`compile_memory_limit` (default unlimited).
  - Fixed caps: 256 processes, 2048 open files, stdout 1024 characters by default. Network off.
  - **The public emkc.org API requires an authorization token since 2026-02-15.** Keys are discretionary and limited to non-commercial educational use.
  - C++ versions are not listed in the README; query the runtimes endpoint.
- **Inference:**
  - It's a code *runner*, not a judge: no test-case or checker model, and a small default output cap.
  - Self-hosted, it would need a test loop around it.
  - The public API is not a dependable alpha path.

### 5.4 Compiler Explorer API
Sources: [API.md](https://github.com/compiler-explorer/compiler-explorer/blob/main/docs/API.md), [Privacy.md](https://github.com/compiler-explorer/compiler-explorer/blob/main/docs/Privacy.md).
- **Facts:**
  - Execution is supported through `executeParameters` (stdin and args).
  - No rate limits today, though they "may" be added along with authentication.
  - Compilation nodes have no internet access.
  - Source may be stored (short links, diagnostics), and analytics are retained up to a year. Admins can read logs and storage.
- **Inference:** Hidden inputs would go to a public third party, with no SLA, no authenticated results, and no judge semantics. Unsuitable for scored judging.

### 5.5 Convex as the judge
Sources: [actions](https://docs.convex.dev/functions/actions), [runtimes](https://docs.convex.dev/functions/runtimes), [limits](https://docs.convex.dev/production/state/limits).
- **Facts:**
  - Node actions run Node 22 or 24 with 512 MiB RAM. Convex-runtime actions get 64 MiB.
  - Docs give a 10-minute timeout. The limits page says 30 min for Convex runtime and 10 min for Node, a discrepancy between the two pages.
  - Free plan: 1M function calls and 20 GB-hours of action compute per month.
  - The docs never mention `child_process`, native binaries, or a sandbox.
- **Inference:** Convex is not a documented or supported place to compile and run hostile native code. Even if spawning a process worked, Convex offers no cgroup, namespace, or seccomp controls. Treat Convex as the authority and orchestrator, with an external judge.

---

## 6. Authenticated results, submission binding, queueing, and first-acceptance ordering

### Facts
- **Convex mutations** are serializable under optimistic concurrency control, atomic, deterministic, and auto-retried on conflict ([OCC](https://docs.convex.dev/database/advanced/occ)). `Date.now()` is fixed at the start of a function ([runtimes](https://docs.convex.dev/functions/runtimes)).
- Convex **actions are not transactional** and are not auto-retried. Convex recommends that a mutation record intent and *schedule* the action, rather than clients calling actions directly ([actions](https://docs.convex.dev/functions/actions)).
- **Convex HTTP actions** can receive webhooks and call `ctx.runMutation`. They do no argument validation, verifying signatures is left to the developer, and they aren't auto-retried ([HTTP actions](https://docs.convex.dev/functions/http-actions)).
- **Standard Webhooks:** HMAC-SHA256 over `webhook-id.webhook-timestamp.payload`, a timestamp tolerance check against replay, constant-time comparison, `webhook-id` as an idempotency key, and multiple signatures for key rotation ([spec](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)).
- Judge0 callbacks carry no signature (§5.1).

### Inferences: properties any option must provide, without choosing a design
1. **Binding.** A result must be bound to an exact submission: submission ID, a hash of the source bytes, the problem and test-set version, the limit profile, and the compiler image digest. A result for source A must never count for source B. Recompute or verify the binding server-side. Never trust the judge's echo of client-supplied fields without checking.
2. **Authentication.** Judge-to-server results need either a signed message with replay protection (Standard Webhooks is one documented scheme) or a server-initiated authenticated fetch from a judge on a private network. One-time callback tokens per submission also work, provided they're stored server-side.
3. **Idempotency.** Duplicate or replayed results must not apply twice, and late results must not change a round that has already ended.
4. **Defining "first".** The rules need an explicit choice; this is a human decision.
   - **(a) First submitted:** order by the server's commit of the submission, a serializable mutation, among the submissions that end up accepted.
   - **(b) First verdict completed:** order by when the server commits the accepted result.

   Under (b), queue position, test-runner speed, and noise on a shared host decide close races. Under (a), a fast submission that's still judging can hold the round open, and the server must wait for every earlier pending submission to resolve before declaring a winner. Neither ordering should use client clocks.
5. **Queue fairness.** With one judge worker, the two players' submissions serialize behind each other. A long-running submission (time limit × number of tests) delays the opponent's verdict. Options include per-player lanes, one core per player, or priority by submission order. Re-judging after an infrastructure error has to preserve the chosen ordering rule.
6. **Feedback leakage.** Returning per-test verdicts, the first failing test index, stdout, or run times lets a player extract hidden inputs over repeated submissions, for example through branch-on-input-then-TLE probing. Returning stdout or stderr on hidden tests leaks them directly. The amount of feedback is a product decision that trades friendliness against secrecy.

---

## 7. Hosting facts relevant to cost

| Option | Facts (2026-10-22) | Source |
|---|---|---|
| Oracle Always Free Ampere A1 | 1,500 OCPU-h + 9,000 GB-h/month ("2 OCPUs and 12 GB"). Up to two A1 instances. Idle reclamation if the 7-day p95 CPU, network, and memory are all < 20%. "Out of host capacity" errors happen. Home region only. 200 GB block storage. | [Oracle docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |
| Oracle AMD micro | 1/8 OCPU (burstable), 1 GB RAM, ×2 | same |
| GCP free tier | One e2-micro (us-west1, us-central1, or us-east1), 30 GB standard PD, 1 GB egress/month. $300 trial credit for 90 days. | [GCP free features](https://docs.cloud.google.com/free/docs/free-cloud-features) |
| Fly.io | **No free tier** for new organizations. Trial is 2 h of runtime or 7 days. shared-cpu-1x costs $2.19/month (256 MB) or $6.70/month (1 GB). Stopped machines bill only for rootfs, at $0.15/GB/month. | [Fly pricing](https://docs.fly.io/about/pricing) |
| Cloudflare Containers | Needs Workers Paid ($5/month; not on Free). Includes 25 GiB-h memory, 375 vCPU-min, and 200 GB-h disk. Instance types range from lite (1/16 vCPU) to standard-4. Isolation model and nested-sandbox support **unverified**. | [CF Containers pricing](https://developers.cloudflare.com/containers/pricing/), [overview](https://developers.cloudflare.com/containers/) |
| Judge0 managed | From €27/month (2,000/day). Free RapidAPI tier unverified (reportedly 50/day). | [judge0.com](https://judge0.com/) |
| Convex | Free plan covers app state (1M calls/month, 20 GB-h actions), not native judging. | [Convex limits](https://docs.convex.dev/production/state/limits) |

**Inferences:**
- **Oracle A1** is the only option found that fits "free" with enough CPU and RAM for isolate or nsjail plus a modern GCC.
  - Risks: capacity availability, idle reclamation of a mostly idle alpha box (keep-alive load to dodge it may breach Oracle's terms; read them), ARM64 rather than x86-64 (fine for GCC, but performance calibration must happen on that hardware), and no SLA.
  - It's an account-level free tier, which is not guaranteed to stay unchanged.
- **GCP e2-micro** has shared, burstable CPU and 1 GB RAM. Compile and run times on it would be noisy and memory-limited, so it's probably unsuitable for fair timing.
- **Shared or burstable vCPUs** on any host add timing noise. The DOMjudge guidance (dedicated core, no SMT siblings) can't be met on fractional vCPUs. Wider margins between accepted and TLE times compensate.
- Isolate and Judge0 expect privileged containers and host cgroup control. That rules out most serverless container platforms unless the platform's own VM boundary is the sandbox and you run per-submission instances, which needs verification for each platform.

---

## 8. Resource limits versus proof of complexity

### Facts
- The Kattis/ICPC problem package format ([2025-09 spec](https://www.kattis.com/problem-package-format/spec/2025-09.html)) sets the time limit from reference submissions:
  - `T_ac × ac_to_time_limit ≤ time_limit` and `time_limit × time_limit_to_tle ≤ T_tle`, with defaults 2.0 and 1.5 and a `time_resolution` of 1.0 s.
  - `T_ac` is the slowest accepted reference submission and `T_tle` is the fastest expected-TLE one.
  - Expected-outcome directories: `accepted`, `wrong_answer`, `time_limit_exceeded`, `run_time_error`, `brute_force`.
  - The spec says multipliers are more future-proof than absolute limits.
- The same spec lists these limits:

  | Limit | Typical default |
  |---|---|
  | Memory | 2048 MiB |
  | Output | 8 MiB |
  | Code size | 128 KiB |
  | Compilation time | 60 s |
  | Compilation memory | 2048 MiB |

  It also defines input validators (exit code 42 means valid) and output validators (42 = AC, 43 = WA).
- isolate and DOMjudge both measure CPU time per run and note that timing depends on hardware and load (§4).

### Inferences
- **Proof is impossible in general.** Deciding whether an arbitrary program runs in O(n log n) is undecidable (a Rice's-theorem argument). The map already lists formal proof as out of scope.
- **What the judge can provide** is a practical gate: "on this hardware and compiler image, with these flags, the program finished every hidden test within T CPU seconds and M memory." That gate is only as strong as the tests. A brute force that passes because the tests are small or weak counts as accepted.
- **Ingredients for a credible gate on each problem:**
  1. Maximum-size and adversarial inputs aimed at the expected wrong complexity: worst cases for naive approaches, anti-hash cases, degenerate trees and graphs, sorted and reverse-sorted data.
  2. At least one intended reference solution and at least one realistic brute force, each benchmarked on the actual judge host.
  3. A limit chosen so the gap is wide: Kattis-style margins, larger on noisy vCPUs.
  4. Input validators so tests honor the stated constraints.
  5. Checkers for problems with multiple correct answers.
  6. Re-calibration whenever the hardware, runtime (gVisor or VM), or compiler image changes.
- **Measurement choices:**
  - CPU time is less sensitive to load than wall time. A wall-time cap is still needed to catch `sleep` and blocked I/O.
  - Cumulative limits across all tests, versus per-test limits, change how much a slow-but-correct solution can get away with.
  - Instruction-count limits would be more stable, but none of the sources reviewed provides them out of the box.
- **Compilation is attack surface.** Run the compiler inside the same sandbox with its own time, memory, and output limits. Template or `constexpr` bombs, huge binaries, and `#include` of host paths such as test files or `/dev/*` are standard abuses. The judge must enforce strict-compilation cards (`-Wpedantic -Werror`, or banning `using namespace std` by a lexical check on the server). Judge0, for example, lets users set `compiler_options` by default (§5.1), so a client could drop flags if the client chooses them.
- **Compiler pinning.** Pin the toolchain by immutable image digest rather than mutable tags. The official `gcc` Docker image publishes moving tags (16.2, 16, latest, and so on) per [Docker Hub `gcc`](https://hub.docker.com/_/gcc), and pulling by digest is Docker's immutable reference mechanism ([docker pull by digest](https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier)). Record the digest with each result. GCC versions as of the investigation: 16.2 (2026-08-07), 15.3, 14.4, and 13.5 ([GCC releases](https://gcc.gnu.org/releases.html)). The C++ standard (`-std=c++20` or `c++23`) and `-O2` are human choices.

---

## 9. Comparison summary

All rows are inference unless the cell cites a fact above.

| Approach | Hidden tests secret from players | Authenticated results | Modern C++ | Free alpha | Main risk |
|---|---|---|---|---|---|
| Browser-only judging | **No** | **No** | Yes (clang/WebAssembly) | Yes | Fails threat model |
| Self-hosted isolate or nsjail + custom worker | Yes (server-side) | You build it | Yes (pin any GCC) | Yes (Oracle A1, with caveats) | Writing and hardening the worker. cgroup v2 host needed. |
| Self-hosted Judge0 1.13.1 | Yes if hardened | No (unsigned callbacks); needs wrapping or re-fetch | GCC ≤9.2 / Clang 10 in shipped images | Yes (VM) | Stale release, cgroup v1, privileged, past CVEs |
| Self-hosted DMOJ judge | Yes | Its own judge-key protocol; needs adapter | Yes (C++23, GCC/Clang) | Yes (VM) | Bridge protocol fit, AGPL |
| Self-hosted Piston | Yes | You build it | Configurable packages | Yes (VM) | Runner only, privileged, small default output cap |
| Judge0 managed | Shared with a third party | No callback signing; poll with API key | GCC ≤9.2 / Clang 10 | Unverified 50/day free tier; otherwise from €27/month | Quota per test, data residency, old compilers |
| Compiler Explorer / public Piston | Shared publicly | No | Yes | Policy-limited | Terms, privacy, no SLA |

---

## 10. Caveats

- RapidAPI pricing and Cloudflare Containers isolation details could not be read from primary pages (JS-rendered or not stated). They're marked unverified.
- The Convex docs disagree on the Convex-runtime action timeout (10 vs 30 min).
- No benchmarks were run. Timing-noise statements come from the isolate and DOMjudge docs plus general reasoning.
- The Judge0 CVE details come from GitHub advisory titles, release notes, and secondary press coverage of the TantoSec report. Read the full GHSA pages before relying on specifics.
- Oracle's free-tier shape allowance has changed historically and may change again.

## 11. Open decisions for humans and Opus (not decided here)

1. Self-host a sandbox primitive, self-host a judge product, or pay for managed? This includes accepting the third-party data exposure of hidden tests.
2. Free host choice and tolerance for Oracle capacity and reclamation risk, versus a small paid VM.
3. Definition of "first acceptance": first submitted versus first verdict, and how pending earlier submissions block a round decision.
4. Queue fairness policy between the two players, and the re-judge policy after infrastructure errors.
5. Feedback granularity on hidden-test failures (verdict only, versus the failing test index, versus run times).
6. Compiler, standard, flags, and architecture (x86-64 vs ARM64) to pin, and how card-driven flags (`-Wpedantic`) combine with the base flags.
7. Per-problem limit methodology (Kattis-style multipliers vs fixed limits), per-test vs cumulative limits, and required reference brute-force solutions per problem.
8. How results are authenticated and bound to submissions (signed push vs authenticated pull), to be specified by Opus.
