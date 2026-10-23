# Modal Sandbox judging constraints

Ticket: `13-modal-judge-constraints` (wayfinder research, map: Beatcode private competitive programming alpha).
Investigation date: **2026-10-22**. All sources were accessed that day. Modal's docs change often, so re-check every volatile fact before implementation.

Labels:
- **Fact**: stated by the cited primary source.
- **Inference**: my reasoning from those facts. Not a vendor claim.
- **Gap**: not documented. Needs a bounded execution spike.

This report does not choose a host, an architecture, or any APIs. Those decisions belong to the human and Opus.

Prior reports this builds on:
- `research/secure-cpp-judging.md` (commit `2b0cb09`): the trusted-judge threat model, and isolate/nsjail/Judge0/DMOJ/Piston.
- `research/free-alpha-hosting.md` (commit `3ea28c8`): Modal's pricing, credits, budgets, and lifetimes.

---

## 1. Short answer

1. **The documented primitives are plausibly sufficient for a candidate C++ judge without assuming isolate or nsjail.** The outer boundary is a per-submission, network-blocked gVisor or VM Sandbox. A **trusted controller outside the Sandbox** holds the expected outputs and decides verdicts. Inside the Sandbox, a wrapper drops privileges and applies rlimits before running the contestant binary. Every piece of that is either documented or a standard Linux mechanism that gVisor lists as supported (§3–§6).
2. **Several properties a judge needs are not documented:**
   - per-process CPU-time accounting precision under gVisor
   - which rlimits gVisor actually enforces
   - what happens to descendant processes when an `exec` timeout fires
   - stdout size caps
   - Sandbox creation rate limits
   - cold-start latency
   - timing variance across workers
   - how quickly budgets are enforced

   Section 9 lists the spike needed to settle these.
3. **One documented weakness matters directly.** gVisor does not enforce `RLIMIT_NPROC`. Its `getrusage` reports `ru_utime`/`ru_stime` at "low precision" and leaves `ru_maxrss` unsupported. Classic judge-style CPU and memory accounting therefore can't be assumed under gVisor. The VM runtime documents nested cgroups, which could fill these gaps, but whether it's available on Starter is undocumented (§6, §7).
4. **This reconciles the two earlier reports.** The secure-judging report's claim that a free alpha is feasible "only by self-hosting on an always-free VM" was too broad. A **recurring-credit Modal Sandbox judge remains plausible but uncertified**, with conditions:
   - a payment method is mandatory
   - usage past the $30 credit can be auto-charged
   - the default spend limit can be non-zero
   - nothing documented here validates judge timing fairness

   The Oracle Always Free VM and paid-VM alternatives should stay open until the architecture decision.

---

## 2. Sources (all accessed 2026-10-22)

| Short name | URL |
|---|---|
| Sandboxes guide | https://modal.com/docs/guide/sandboxes |
| Networking & security | https://modal.com/docs/guide/sandbox-networking |
| Sandbox resources | https://modal.com/docs/guide/sandbox-resources |
| CPU/memory/disk semantics | https://modal.com/docs/guide/resources |
| Spawning commands | https://modal.com/docs/guide/sandbox-spawn |
| Sandbox files | https://modal.com/docs/guide/sandbox-files |
| VM Sandboxes | https://modal.com/docs/guide/vm-sandboxes |
| Python `Sandbox` reference | https://modal.com/docs/reference/modal.Sandbox |
| Python `ContainerProcess` reference | https://modal.com/docs/reference/modal.container_process |
| JS `Sandbox` reference | https://modal.com/docs/sdk/js/latest/Sandbox |
| Pricing | https://modal.com/pricing |
| Billing | https://modal.com/docs/guide/billing |
| Budgets | https://modal.com/docs/guide/budgets |
| gVisor syscall compatibility (amd64) | https://gvisor.dev/docs/user_guide/compatibility/linux/amd64/ |
| gVisor rlimit source | https://github.com/google/gvisor/blob/master/pkg/sentry/syscalls/linux/sys_rlimit.go |
| Convex actions | https://docs.convex.dev/functions/actions |
| npm `modal` (latest 0.11.1) | https://registry.npmjs.org/modal/latest |
| PyPI `modal` (latest 1.6.2, uploaded 2026-10-16) | https://pypi.org/pypi/modal/json |

`https://modal.com/docs/guide/limits` returned **404**. I found no current Modal page documenting Sandbox creation rate limits.

---

## 3. Isolation boundary

**Facts**
- Modal describes Sandboxes as "secure containers for executing untrusted code" [Sandboxes guide].
- There are two runtimes [Networking & security, VM Sandboxes]:
  - **gVisor**: a userspace implementation of the Linux syscall interface.
  - **VM**: a dedicated Linux kernel isolated by KVM.
- `runtime` selects the runtime. Leaving it unset lets Modal choose [Sandboxes guide, Python reference].
- By default, a Sandbox cannot access the workspace's other Modal resources, unlike Modal Functions. "The impact of malicious code is limited to the Sandbox itself" [Networking & security].
- The VM runtime supports Docker, FUSE, and "managing resources with nested cgroups." Nested virtualization is Enterprise-only [VM Sandboxes].
- The current VM Sandboxes page states no alpha status or allowlist. A search-engine snippet of an older copy mentioned both, so availability may have changed recently.

**Inferences**
- One Sandbox per submission, terminated afterwards, gives a fresh filesystem and process table per job. Nothing carries across players or rounds unless a Volume is mounted. So **don't mount shared Volumes into judge Sandboxes**.
- Inside the Sandbox, the contestant runs in the same container as anything else placed there. **The outer boundary protects Modal and other jobs, not secrets you put inside the Sandbox.** The prior hosting report made the same point.
- Running isolate or nsjail inside is **not assumed**:
  - Under gVisor, `unshare` lacks cgroup and time namespaces. gVisor's cgroup v2 controllers have historically been partial (pids only, memory reporting only, cpu stubbed). I could not confirm the current state from official docs.
  - Under the VM runtime, isolate may work because cgroups are documented, but this is untested.

**Gaps**
- Which runtime Modal picks when `runtime` is unset.
- Whether `runtime="vm"` is available on the Starter plan.
- Whether the in-Sandbox process runs as root and holds `CAP_SETUID`. Needed for the privilege drop in §5.

---

## 4. Compiler execution and image pinning

**Facts**
- Images use the same definitions as Functions: method chaining or an existing registry image [Sandboxes guide].
- The recommended pattern is: `Image.build` in deploy/CI, publish as a **named image**, then `Image.from_name`. This keeps rebuilds out of Sandbox creation [Sandboxes guide].
- Modal treats an external tag as immutable once pulled and does not detect upstream changes, even for `:latest`. To update, you change the tag [Sandboxes guide].
- `add_local_file` / `add_local_dir` bake files into an image [Sandbox files].

**Inferences**
- Pin a dated or digest-specific base image, such as an `ubuntu:24.04-YYYYMMDD`-style tag or a digest, with a pinned `g++` package version. Record `g++ --version` as a build artifact.
- Compilation can run as an `exec` inside the same per-submission Sandbox, under its own timeout and output cap, before any test runs.
- **Never bake hidden tests or expected outputs into the judge image.** Anything in the image is readable by contestant code in that Sandbox.

**Gaps**
- Whether `Image.from_name` resolves to an immutable image version, or whether re-publishing changes it underneath running jobs.
- Compile time and throughput at the chosen CPU request.

---

## 5. Hidden tests, expected answers, and the trusted controller

**Facts**
- A controller can push data with `filesystem.write_bytes/write_text/copy_from_local`, which create parent directories and overwrite existing files. Reads cover files up to 5 GB [Python reference, Sandbox files].
- `exec` exposes stdin. Writing then closing stdin signals EOF. Stdout/stderr can be piped back to the caller [Spawning commands].
- Secrets passed to `create` or `exec` become **environment variables inside the Sandbox** [Python reference].
- `include_oidc_identity_token=True` injects `MODAL_IDENTITY_TOKEN` into the Sandbox environment [Sandboxes guide].
- Modal docs don't describe file permissions, ownership, or read-only mounts [Sandbox files].
- gVisor lists `setuid`, `setresuid`, `prlimit64`, `wait4`, `kill`, `setpgid`, `mount`, and `pivot_root` as fully supported. `setrlimit` and `seccomp` are partial [gVisor compatibility].

**Inferences (candidate pattern, not a design)**
- Where expected answers live:
  - The **trusted controller** holds the expected answers and compares outputs. It runs outside the Sandbox: a Convex action, a Modal Function, or another server.
  - Only the input for the current test enters the Sandbox, on stdin. Expected outputs never cross the boundary.
  - This removes "contestant reads expected answers" without any in-Sandbox privilege separation.
- What still leaks:
  - Contestant code sees every input it is fed, and could exfiltrate inputs through stdout or stderr into diagnostics.
  - Show contestants only verdicts, not raw outputs, for hidden tests.
  - Stop at the first failing test so later inputs are never sent.
- What must stay out of the Sandbox:
  - Modal tokens, Convex keys, and result-signing keys must not be passed as Sandbox secrets or env vars, because contestant code can read the environment.
  - The OIDC token should stay disabled for judge Sandboxes for the same reason.
- If an in-Sandbox wrapper is used (for per-test timing, see §7):
  - It needs to run as root, then `setresuid` to an unprivileged uid and set rlimits before `execve` of the contestant binary.
  - Otherwise the contestant can `ptrace` or kill the wrapper and forge its timing report.
  - The controller should treat wrapper output as **untrusted but bounded**. A compromised wrapper can lie about time, but it can't fabricate correct answers to inputs it hasn't seen, and the controller re-checks the output.
- Rejected design: an alternative that inferred privilege from Sandbox membership would grant authority to code the contestant controls.

**Gaps**
- The default uid and capabilities in a Sandbox `exec`.
- Whether a privilege drop and uid separation hold under gVisor, so that an unprivileged process cannot read a root-only `0600` file or `ptrace` the wrapper.

---

## 6. Process, resource, output, and network limits

| Concern | Documented facts | Status |
|---|---|---|
| Network | `block_network=True` drops all outbound traffic, DNS included. Inbound connections are impossible by default [Networking & security]. | **Sufficient** if `block_network=True` is set on every judge Sandbox. |
| Memory | `memory=(request, limit)` sets a hard limit. Exceeding it OOM-kills [CPU/memory semantics]. The Exit Reasons metric shows memory evictions [Sandbox resources]. | Whole-Sandbox ceiling, not per test. `RLIMIT_AS` is settable in gVisor but its enforcement isn't stated (**Gap**). |
| CPU | `cpu=(request, limit)`. "Throttling prevents exceeding the limit" [Python reference]. 1 core = 2 vCPU. The default soft limit is request + 16 cores [CPU/memory semantics]. | Throttling caps **rate**, not **total CPU time**. Total time comes from a timeout or `RLIMIT_CPU`. |
| Process count / fork bombs | No Modal PID limit documented [Sandbox resources]. gVisor source: `RLIMIT_NPROC` (`ProcessCount`) "not enforced" [gVisor rlimit source]. | **Gap / weakness under gVisor.** The mitigations are the Sandbox memory hard limit, the wall timeout, and terminating the Sandbox. A pids cgroup on the VM runtime is a possibility to spike. |
| File size / disk | Disk quota defaults to 512 GiB per container. Over-quota writes fail with `OSError` [CPU/memory semantics]. `RLIMIT_FSIZE` is settable in gVisor [gVisor rlimit source]. | Use `RLIMIT_FSIZE` plus a small writable work dir. Enforcement under gVisor is a **Gap**. |
| Stdout/stderr | Piped output is held in memory by Modal and readable for 10 minutes after the exec completes [Spawning commands]. No size cap documented. | **Gap.** Cap it in the wrapper (for example, read at most N bytes and kill). Don't rely on Modal. |
| Lifetime | Sandbox `timeout` defaults to 300 s, max 24 h. Python exec `timeout` is in seconds. JS `timeoutMs` defaults to 0, meaning no timeout [Sandboxes guide, JS reference]. | Always set both explicitly. |

---

## 7. Per-test vs aggregate timing, accounting, and variability

**Facts**
- The exec `timeout` is a session (wall-clock) timeout. Stream reads respect it [Spawning commands, Python reference].
- In gVisor:
  - `getrusage` has "low precision" `ru_utime`/`ru_stime`, and `ru_maxrss` is unsupported.
  - `clock_gettime` and `times` are fully supported.
  - `perf_event_open` is unimplemented.
  - `sched_setaffinity` is a stub.

  [gVisor compatibility]
- `RLIMIT_CPU` is settable in gVisor, and the source signals the CPU timer on update [gVisor rlimit source]. Enforcement precision is not documented.
- CPU requests are minimums. Sandboxes can burst onto spare host capacity. A CPU Pressure metric reports stall time [Sandbox resources].
- Billing is per second on `max(request, actual)` [Sandbox resources].

**Inferences**
- Per-test timing has two possible sources:
  - **From the controller:** a wall time per `exec` that includes RPC and network latency, which is noisy at the sub-second scale.
  - **From an in-Sandbox wrapper:** `clock_gettime` wall time, plus whatever CPU time gVisor reports, used as a hint.
- Problems should be calibrated with a **generous margin between the reference solution and the slow brute force**. Small per-test timing differences can't be trusted. The secure-judging report reached the same conclusion: limits reject slow brute force rather than prove Big-O.
- Bursting and shared hosts mean wall time varies between workers. Setting `request == limit` should reduce the variance but won't remove it.
- Aggregate accounting: one Sandbox per submission means the **cost per submission** is roughly the Sandbox lifetime × (CPU request + memory). Tight Sandbox timeouts bound the cost of each job.

**Gaps (spike)**
- Variance of run time for a fixed CPU-bound C++ program across many fresh Sandboxes, both with `request==limit` and without.
- `RLIMIT_CPU` enforcement accuracy under gVisor.
- The ratio of gVisor overhead to native for syscall-heavy I/O, which affects fast-I/O problems.
- Cold-start p50/p95. The docs say only "boot in seconds" [JS reference].

---

## 8. Termination, authentication, job binding, and budgets

**Termination (facts)**
- `terminate()` stops the Sandbox using SIGKILL (exit 137). `wait=True` blocks until it has stopped [Sandboxes guide, Python reference].
- Lifecycle "Finished" covers natural exit, termination, timeout, idle timeout, and OOM [Sandboxes guide].
- `ContainerProcess` documents `poll`/`wait`/`returncode` but **no per-process kill**. Its `exec_deadline` parameter is unexplained [ContainerProcess reference].

*Inference:* killing the whole Sandbox is the documented way to end every descendant process. Per-test cleanup inside a long-lived Sandbox depends on the wrapper killing its own process group. The behavior of descendants on an `exec` timeout is a **Gap**.

**Authentication and job binding (facts)**
- The JS SDK exposes the full create/exec/filesystem API [JS reference]. The latest npm `modal` is 0.11.1, which is pre-1.0. PyPI `modal` is 1.6.2.
- Convex `"use node"` actions run npm packages with a 10-minute timeout and 512 MB memory [Convex actions].
- Tags plus `Sandbox.list(tags=…)` and `from_id` allow correlation [Python reference].

*Inferences:*
- Result authenticity follows if the component that **creates the Sandbox, feeds the inputs, and compares outputs** is trusted. That component then writes the verdict to Convex under a server-generated submission ID bound to the match, round, and player.
- The Sandbox never needs credentials, and nothing it emits is treated as authoritative beyond the bytes compared.
- A Convex Node action is one candidate controller. Another is a Modal Function called by Convex, which needs authenticated invocation. Either way, the Modal token must live only in that trusted component.
- **Unvalidated:**
  - whether the JS SDK works in Convex's Node runtime (it relies on gRPC)
  - whether a whole judge job fits within the action limits

**Budgets (facts)**
- A payment method is mandatory [Billing].
- Mid-cycle auto-charges occur at undisclosed thresholds [Billing].
- The workspace budget caps gross usage before credits. The spend limit caps net charges and stops workloads that would incur out-of-pocket cost. Its default is the usage limit minus credits, so it can be above $0 [Budgets].
- Environment budgets need Team or Enterprise [Budgets].
- The docs don't state enforcement latency or what happens to in-flight work.
- Sandbox rates: $0.00003942 per physical-core-second and $0.00000667 per GiB-second, billed "at non-preemptible rates of 3x list price." Starter includes $30/month credits and 100-container concurrency. Selecting a region costs 1.15–1.75× [Pricing].

*Inference:*
- Set the spend limit to $0 and the workspace budget near $30.
- Back those caps with app-side admission limits: one in-flight submission per player, short Sandbox timeouts, and a kill switch.
- The provider caps aren't a precise per-job meter.

---

## 9. Required later validations (bounded spike, on a human-provisioned account)

Each item is a measurement, not a design. Stop the spike once each item has a yes/no answer or a number.

1. Run `id`, `capsh --print`, and `uname -a` under gVisor and VM. Determine whether VM is selectable on Starter and which runtime is the default.
2. Test privilege separation under gVisor. Can an unprivileged uid read a root `0600` file, or `ptrace`/kill a root wrapper?
3. Test rlimit enforcement under gVisor for `RLIMIT_CPU` (accuracy), `RLIMIT_AS`, `RLIMIT_FSIZE`, and `RLIMIT_NOFILE`. Then check fork-bomb behavior given that `RLIMIT_NPROC` isn't enforced, and confirm the Sandbox memory limit and timeout still contain it.
4. Check the `exec` timeout: whether descendants are killed, and what the return code is.
5. Run an output flood (for example, `yes`) and check whether Modal caps or buffers it, and its effect on the controller's memory.
6. Confirm `block_network=True` blocks both DNS and outbound TCP/UDP.
7. Measure timing variance over at least 30 fresh Sandboxes per configuration: CPU-bound and I/O-bound C++, `request==limit` versus burst, gVisor versus VM.
8. Measure cold-start p50/p95 when created from a named image. Measure compile time with the pinned `g++`.
9. Check whether `Image.from_name` is immutable across re-publishes.
10. Check whether the JS SDK runs in a Convex `"use node"` action. Measure end-to-end job latency against the 10-minute action limit.
11. Check budget enforcement: with spend limit $0, observe what happens to running and new Sandboxes once credits run out. Use a tiny test budget if possible.
12. Measure the Sandbox creation rate and concurrency actually allowed on Starter.
13. Under the VM runtime only, check whether isolate's cgroup mode works. This is an optional fallback, not an assumption.

---

## 10. Unresolved questions (for the human and Opus, not answered here)

- Whether a mandatory payment method and possible auto-charges are acceptable for the $0 alpha goal.
- gVisor (default, weaker accounting) versus VM runtime (cgroups, availability unknown), versus the Oracle or paid-VM self-hosted isolate route.
- Where the trusted controller runs: a Convex action, a Modal Function, or something else.
- Whether timing noise from shared bursting hosts is acceptable for "first acceptance wins" fairness, given that correctness, not speed between players, decides each round.
