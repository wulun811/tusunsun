# Tusunsun (土行孙)

> **Let your Agent change with the work.**

Sometimes you just want to chat. Next you need to read files, change code, or bring in your own business tools.
Different work calls for different capabilities.

Tusunsun organizes them into **scenes**: describe what a kind of work needs, start the essential components,
and load suitable capabilities when they are called. One small kernel can support different Agent setups.

Start with the included chat, coding or gateway scene, then add your own tools or replace an adapter.
**Assemble by scene. Load on demand. Adapt as the work changes.** That is why Tusunsun uses a microkernel and plugins.

This is a **Developer Preview** for developers. The current package runs a local conversational Agent with
file tools, accessible through CLI, a web UI, HTTP/SSE and WebSocket.

This document describes the **current release** only: what it is, how to use it, and where the boundaries are.
Changes between releases live in [CHANGELOG](CHANGELOG.md); design rationale in [ADR](docs/adr/).

## Run it first: no key, no network

Requires Node 22+. **No network needed to install dependencies**: zero npm runtime dependencies, and the
third-party `ws` is vendored in `vendor/`.

```bash
node tusunsun.mjs --version      # print the version
node tusunsun.mjs plugins        # which plugins this package can discover
node tusunsun.mjs scene list     # the 10 scene recipes
node tusunsun.mjs start          # start the local gateway (default port 9002)
```

All four work without an API key: the kernel, plugins, scenes and file tools load and list normally.
To install the `tusunsun` command, see "Installation" below; to connect a model, see journey ②;
to check which command needs a key, see the command table.

## Why Tusunsun

An Agent can keep accumulating tools, channels and policies. Any one job may need only a few of them.
Tusunsun starts with a practical question: **what capabilities should this piece of work bring along?**

- **Group them into a scene.** A chat scene prepares a model and sessions; a gateway or coding scene can include file tools. Write your own scene to reuse a particular combination.
- **Start essentials, call in the rest.** Scenes distinguish eager and on-demand plugins. Capability calls can trigger lazy loading. Some lazy-loaded plugins can be recycled when idle and loaded again later.
- **Change the setup as the work changes.** Add a business tool, replace a model or session adapter, or revise a scene without putting every policy into the kernel.

The microkernel lives in `src/core/` (its line budget is stated once, under Design Principles), excluding plugins and tools.
Zero npm runtime dependencies and vendored `ws` support offline tarball installation; model connectivity is separate.
These engineering choices support the design, without establishing better model quality or lower resource use.

Today, you choose or write the scene. Tusunsun does not promise to infer arbitrary work and automatically
assemble everything it needs. Essential services and listeners must be initialized explicitly, and lazy loading
does not mean every module avoids early imports. See the [scene guide](docs/guides/scene-system.md).

## When to use it

| Need | What Tusunsun supplies | What you still build or verify |
|---|---|---|
| Several kinds of work on the same base | Scene-defined combinations of eager and on-demand components | Scene configuration, validation and deciding when to switch |
| Your own scripts and tools in a dedicated assistant | Tool registration, capability routing, replaceable adapters | Domain logic, permissions and side effects |
| An Agent behind a desktop tool or web app | HTTP/SSE and WebSocket, persisted sessions, file tools | Client integration, model configuration, deployment |
| Control over how capabilities load and unload | Small kernel, plugin lifecycle and idle recycling | Your policy and task-level evaluation |
| Distribution on a restricted network | Self-contained package and offline installation gate | Node/npm; a separate local model service for offline inference |

For a ready-to-use coding assistant, consider Pi first. For a single model request, calling its API directly
may be simpler. This package alone does not provide multi-tenant isolation or durable task scheduling.

## Compared with Pi

[Pi](https://github.com/earendil-works/pi) (formerly `badlogic/pi-mono`) also offers SDK embedding,
RPC, tools, extension hooks and lifecycle management. Those are shared capabilities, not unique Tusunsun features.

| Choice | Tusunsun today | Pi's documented path |
|---|---|---|
| Starting point | Choose a scene for the work, assemble its capabilities on the same kernel; a local gateway is included | Interactive Agent plus SDK/RPC integration |
| Customization surface | Scene lists of eager/on-demand components plus Core events, commands, services and capabilities | Agent sessions, tools, extension hooks and resources; lower-level runtime packages also exist |
| Distribution tradeoff | Node ≥ 22; zero npm install dependencies, vendored `ws`; verified platform scope below | Its own installation/dependency scheme; no unmeasured size or performance ranking here |
| Reason to choose | You want different setups for different work, with assembly and loading mechanisms you can read and change | You want to build on Pi's interaction, model integration or SDK/extension contracts |

Pi's current repository also includes Chord and experimental Pi Durable. It is inaccurate to describe Pi
as terminal-only or to claim that persistence or hot reload is unique to Tusunsun. Persisted sessions in
Tusunsun do not establish task recovery. See [comparison and sources](docs/positioning-and-pi.md), checked 2026-10-20.

**Scope:** trusted-local-only. No guarantee of safe untrusted-code execution, strong isolation or exactly-once
side effects. Plugins run with host permissions; file-tool path checks do not constrain `tool-bash`.
The default `event-sink` validates/counts events without persisting them. See [SECURITY.md](SECURITY.md).

## Architecture and shipped components

### Architecture

**Core:**
- **Event Bus** — `core.emit()` / `core.on()` for fact broadcasting
- **Command Bus** — `core.command()` for request-response with timeouts
- **Capability Registry** — `registerCapability()` / `callCapability()` for service discovery
- **Service Registry** — `registerService()` / `getService()` for dependency injection
- **Middleware Pipeline** — `use(stage, fn)` for cross-cutting concerns

**Dynamic Management:**
- **Three Daoists Scheduler** — Jieyin / Duobao / Zhunti, DAG dependency parsing + 7-step safe uninstall
- **Plugin Context Protocol (PCP)** — plugins declare `context` to become AI-aware, with lazy two-phase injection
- **Scene Schema System** — each scene declares capabilities + useCases, AI can recommend switching
- **Three-tier Memory implementation** — Ying Mini (instant + daily JSONL + KV long-term); initialize its service explicitly in a scene
- **Prompt Pipeline** — template variables → memory injection → tool descriptions → format standardization

**Security:**
- **Workspace path checks** — shipped file tools reject absolute paths and workspace escapes; `tool-bash` remains unrestricted. This is not an OS sandbox
- **Dangerous-command hard block (always on)** — built into the executor, independent of which
  scene you picked: reading system credentials, tool-level outbound network, block-device writes,
  fork bombs and `rm -rf` are rejected outright (`Y024`).
- **Irreversible-operation gate (always on)** — everyday-but-irreversible operations (`rm -r`,
  `rm *.js`, `find -delete`, `git reset --hard`, `git clean -fdx`, `truncate`, `shred`, `> clobber`)
  are not rejected, but the first call does **not** execute: the kernel measures the blast radius
  itself (recursive file count, whether it leaves the workspace) and requires the caller to restate
  the measured number. A mismatch is refused with the real figure echoed back (`Y025`). This is an
  attention gate, not a security boundary — it stops "didn't realise how much this deletes".
- **Kunxiansuo local (shipped)** — FileGuard (sensitive paths + symlink escape) + circuit breaker
  + rate limit + result redaction. Enabled by `gateway` and `coding` — every
  scene that assembles tools able to delete or overwrite; pure-conversation scenes (`chat`,
  `gateway-lite`) do not load it. `agent-platform` lists both `tool-*` and `kunxiansuo-local`
  under `optional` (inert, not assembled), so it starts with neither tools nor a fence —
  promote them together if you want them. Deliberately **not** included: the ruler (anchor tamper-proofing
  — it guards the fence's own files, and this project rewrites them continuously, so the anchors
  would be re-signed on every upgrade), the reputation scorer (needs Qiankun Mirror's read-only DB).
- **Qiankun Mirror integration** — **not included in this package** (event mapping / P0 push /
  anchor tamper-proofing / reputation scoring belong to Kunxiansuo full, under the commercial license)

**Tools & Channels:**
- **10 file tools (a subset of Baobaonang)** — read / write / bash / list / cp / mv / rm / stat / todo / validate
- **Downstream tool suites** — not included; do not infer their capabilities from this package
- **No external messaging channel is enabled by default** — implement and wire an adapter using the examples

## Quick Start

### Install

This package is **not published to npm** (`npm view tusunsun` finds nothing), so start from a checkout or
a complete tarball you already have. A repository URL or package name is not proof of a release.

```text
node tusunsun.mjs --version
npm pack
npm install -g --offline ./tusunsun-<version>.tgz
tusunsun --version
```

Use the exact filename printed by `npm pack`, which changes with the version. This avoids stale packages
and shell-dependent wildcard expansion. Node.js 22 or newer and npm must already be available. The checkout runs
without installing third-party runtime dependencies. The default model is `kimi-k2.5` at
`https://coding.dashscope.aliyuncs.com/v1`; explicitly set your endpoint and model:

```text
node tusunsun.mjs config set model.baseUrl https://your-endpoint.example/v1
node tusunsun.mjs config set model.apiKey YOUR_MODEL_KEY
node tusunsun.mjs config set model.model YOUR_MODEL_NAME
node tusunsun.mjs config set agent.workDir /absolute/path/to/project
```

On Windows, use your project's absolute Windows path. File tools accept paths relative to that workspace
and reject absolute paths and escapes. Shell tools are unrestricted. Non-loopback model endpoints require
a model key; loopback endpoints may run without one. Gateway credentials (`gateway.apiKey`) are separate.

### Start Gateway

```bash
node tusunsun.mjs start
```

### Interactive Chat

```bash
node tusunsun.mjs chat
```

`chat` is provided by `plugins/haotian-lite.js` in this checkout and connects to the running gateway via WebSocket.
Start the gateway in one terminal, then run chat in another. A chat reply requires a configured, reachable model.

### Status

```bash
node tusunsun.mjs status
```

### Plugins

```bash
node tusunsun.mjs plugins
```

### Config

```bash
node tusunsun.mjs config show
node tusunsun.mjs config set <key> <value>
```

### Scenes

```bash
node tusunsun.mjs scene list           # List available scenes
node tusunsun.mjs scene switch <name>        # Preview the assembly changes
node tusunsun.mjs scene switch <name> --yes  # Save the selected scene; restart the gateway to apply
node tusunsun.mjs scene show <name>    # Show scene details
```

### Run profiles (development / production)

| Profile | Trigger | Scene | Assembly |
|---------|---------|-------|----------|
| development (default) | plain `start` | `config.activeScene` (default `gateway`) | Model + tools + session; inspect eager/lazy lists with `scene show gateway` |
| production | `TUSUNSUN_PROFILE=production` / `npm run start:production` | **locked to `base-system`** (9 kernel plugins) | kernel base only: **no model, no chat, no tools** |

The production profile is Linux-only and requires `TUSUNSUN_DATA_DIR` outside the repository.
Its name is not a claim of full production acceptance.

The production lock is intentional (a frozen minimal assembly that ignores a possibly-tampered
`config.activeScene`). To get a talking agent there, name the scene explicitly:

```bash
TUSUNSUN_DATA_DIR=/var/lib/tusunsun npm run start:production -- --scene gateway   # Linux; directory must be writable
```

When the assembly has no chat capability this package does not pretend to be healthy:

- the startup log prints `no chat capability: 'chat.handle' has no provider …`
- `GET /health` returns `status: degraded` with a `missing` list (HTTP 200, so liveness probes stay green)
- `GET /ready` returns **503** when chat capability **or model credentials** are missing (`missing` lists what)
- `POST /v1/chat/completions` fails **immediately** with 503 and says how to fix it (it does not hang until timeout)

### Control plane & security defaults

| Item | Default | Notes |
|------|---------|-------|
| Bind address | `127.0.0.1` | Remote bind requires **explicit** `gateway.allowRemote: true` (or `TUSUNSUN_ALLOW_REMOTE=1`) **and** a non-empty `gateway.apiKey`; otherwise startup is refused (exit code 1) |
| `/api/*` (control plane) | loopback + same-origin when no key | With `gateway.apiKey` set, every control-plane route requires `Authorization: Bearer <key>` (401 otherwise); cross-origin is 403 even with a valid key; POSTs must be `application/json` (415) |
| CORS | no CORS headers | Only origins listed in `gateway.corsOrigins` are echoed; the wildcard `*` default is gone |
| WebSocket auth | subprotocol `tusunsun.token.<base64url>` | Token travels in a **header**, not the URL; `?token=` is kept for compatibility only |
| State dir / config (POSIX modes) | `0700` / `0600` | `~/.tusunsun` and `config.json` (plaintext keys); config writes are atomic (tmp + rename) |
| File tools | inside the workspace | `../`, sibling dirs sharing a prefix (`workspace_evil/`), and symlink escapes are rejected (`out_of_bounds`). **Not a sandbox**: `tool-bash` is unrestricted |

With a key configured, open the UI at `http://127.0.0.1:9002/` and type the credential into the **login box**
(the key button in the top-right corner). It is kept in `sessionStorage` for this tab only, and is sent as an
`Authorization` header / WebSocket subprotocol — never in the URL, so it does not reach browser history, proxy logs,
or `Referer` headers. The control plane (`/api/*`) answers `401` until the credential is supplied.

The legacy query form `http://127.0.0.1:9002/?token=<gateway.apiKey>` is still accepted **for compatibility only and is
not recommended**: a URL leaks into history / proxy logs / `Referer`. The page reads it once, moves it into
`sessionStorage`, and strips it with `history.replaceState()` — but the value may already have been recorded.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | operation failed (write failure, refused stop, security policy refused startup) |
| 2 | usage error (unknown command, missing arguments) |
| 3 | gateway not running (`status` / `stop` / gateway-dependent plugin commands) |

### Platform support (honest boundaries)

| Platform | Status |
|----------|--------|
| Linux + Node 22 (v22.22.2) | Supported. **Two checkouts are reported separately and never stand in for each other**:<br>**dev tree** (with `verification/` and `.git`): unit **1509 total / 1509 pass / 0 fail / 0 skip** (`TT_ASSERT_DRAIN=1`); integration 63/63; smoke 2/2; 27 probes all rc=0; release gate **PASS 42 / FAIL 0 / SKIP 0 / NOT_RUN 2** (default repeat 2; the Node 24 run counts as its own item; clean-room offline install and artifact member-by-member consistency both passed)<br>**npm artifact** (`tar xzf tusunsun-0.20.0.tgz`, **measured locally**): unit **1509 total / 1498 pass / 0 fail / 11 skip** (no `.git`, no CI workflows, not root); integration 63/63; smoke 2/2; release gate **PASS 32 / FAIL 0 / SKIP 4 / NOT_RUN 7, exit code 1 (blocking)** — the artifact ships without `verification/` or `.env`, so the 4 SKIPs (including 11 skipped cases in each of the three unit passes) and the 7 NOT_RUNs (3 evidence-directory items, 3 missing-precondition items, 2 foreign platforms) each carry a named reason and **none is counted as a pass**. The gate deliberately does **not sign off as all-green** in artifact form; the same command in the dev tree is 42/0/0/2 with exit 0 — the two numbers answer two different questions and never stand in for each other.<br>real-model chain (free-tier `deepseek-v4.1-flash`, one non-streaming round trip, `usage.cost: 0`) passes locally; a bad credential is rejected by the upstream with 400; stress 31 hard gates all pass |
| Linux + **Node 24.9.0** | **Measured**: unit 1308/1308 (`TT_ASSERT_DRAIN=1`); release-gate `node-24` item PASS. The run surfaced one Node-24-only defect (a fixture used `rmSync` on a symlink, which throws `ERR_FS_EISDIR` on Node 24; product code uses `unlink`, so the fixture was fixed). See [ADR-12](docs/adr/ADR-12-node-support-matrix.md) §4.1 |
| Linux + Node 18 / 20 | Dropped (both EOL). `engines` is `>=22`; the old compatibility code is gone |
| macOS | Not verified (expected to work; not part of release acceptance) |
| Windows | Node 22.19.0: offline install, npm start, CLI/HTTP/SSE/WebSocket lifecycle verified (12/12 install gate); TUI exits on piped q input. Native console interaction, 8.3 names, UNC, case-insensitivity and Node 24 remain unverified locally. The production profile remains Linux-only. |
| Network filesystems / crash recovery / exactly-once | Not covered (see Boundaries above) |

## CLI Commands

| Command | Description |
|---------|-------------|
| `tusunsun start` | Start gateway in the foreground |
| `tusunsun stop` | Stop running gateway |
| `tusunsun status` | Show gateway status (plugins, uptime) |
| `tusunsun chat` | Interactive terminal chat (provided by the `haotian-lite` plugin; needs `start` first) |
| `tusunsun tui` | Terminal TUI dashboard (monitor + manage + chat) |
| `tusunsun config` | View/edit config (show/get/set) |
| `tusunsun plugins` | List plugin **files** under `plugins/`, each tagged default-assembled / optional / present-but-opt-in |
| `tusunsun scene` | Scene management (list/switch/show/suggest/expand) |
| `tusunsun kunxiansuo` | Query Qiankun Mirror (needs Kunxiansuo full; endpoint not in this package) |

A running gateway also exposes, with no extra configuration:

| Entry | Address |
|-------|---------|
| Web UI | `http://localhost:9002/` |
| OpenAI-compatible | `POST http://localhost:9002/v1/chat/completions` |
| Health | `GET http://localhost:9002/health` |

## Design Principles (Immutable)

> **Scope:** items 1–4 constrain the **microkernel** — `src/core/` (the line count is generated by
> `scripts/sync-line-docs.mjs` and verified file-by-file by a gate). `plugins/` is the freely replaceable plugin surface and is
> **not** under a line budget, but the **shipped** plugin set must stay free of external npm
> dependencies (`npm run check:deps`). Plugins you add yourself are unconstrained; package-wide
> distribution promises still require separate verification.
>
> `src/` has two layers: `core/` (under the line budget) and `bootstrap/` (not under it).

1. **Microkernel (`src/core/`) ≤ 4889 lines** — the same number as `CORE_MAX_LINES`; every increase is recorded in ADR-10
2. **Zero install-time dependencies** — currently **0** npm runtime deps (`ws` ships as a vendored copy under `vendor/ws/`)
3. **Tarball ~2 MB; ~5.8 MB unpacked** — `test/` and `docs/` are 3.6 MB of the unpacked size; both numbers are stated because they answer different questions
4. **Node.js ≥ 22** (`engines: >=22`, ADR-12). 22 measured; 24 declared but **NOT_RUN**
5. **Plugin freedom is infinite** — plugins can use any dependency

## Performance (reproducible numbers)

Tusunsun is built for **fast models that do not exist yet**. When the upstream drops from 2 s to
50 ms, the framework's own overhead stops being invisible and becomes the bill itself. Being light
is not a side benefit here — it is the target.

Numbers below come from `npm run test:stress` (i7-8750H / 12 vCPU / Node 22); you can rerun it and
get the same set on your machine:

| What | Measured |
|---|---|
| Cold start to ready (incl. process spawn) | **122 ms** (minimal assembly) / **160 ms** (coding scene, 17 plugins) |
| Resident memory | **65–67 MB** |
| Safety check on one tool call | **7.2 µs** |
| Full tool-execution path (read tool) | **2.4 µs** |
| **Kernel overhead** in one full chat round trip | **1.3–4.9 ms** |
| Gateway `/health` throughput | **13.8k req/s** (concurrency 32, loopback) |
| Live-object drift after 120 s / 87.5M ops | **0.0%** |

**How "kernel overhead" is measured**: run end-to-end against a local mock upstream with
controlled delay, then subtract the direct-to-upstream time. What remains is everything this
package contributes to one full round trip. It stays flat as the mock delay goes 0 → 50 → 200 ms,
which means there is no upstream-coupled wait inside the kernel.

Method, percentile spread and known limits: [stress test plan](docs/quality/stress-test-plan.md)
and [baseline](docs/quality/stress-baseline-2026-10-20.md). These numbers are hardware-bound;
**this repository makes no claim of superiority over any peer implementation** — only that it can
produce them, and that you can reproduce them.

## Multiple concurrent sessions (one kernel, many conversations)

Tusunsun does not start N agent processes. It runs **one kernel serving N sessions** (the global
concurrency gate defaults to 20). Isolation comes from giving every cross-turn piece of state a
session dimension, not from process isolation.

**Isolated today** (each has a concurrency test pinning it):

| State | Key |
|---|---|
| Conversation history | `sessionId` → its own file |
| Turns within one session | Serialized per session (the second request queues behind the first and reads the history the first one just wrote) |
| Working directory | `sessionId` → its own root (see below) |
| Irreversible-operation acknowledgement | `${sessionId}:${command fingerprint}` |
| Read-before-write marks | `sessionId` |
| Audit log / user preferences / circuit breaker | `sessionId` / `chainId` |
| Tool call quota | `${sessionId}:${tool name}` |
| Task list (`tool-todo`) | `sessionId` |
| Context summary | `sessionId` |

### Giving each session its own directory

The default is still `agent.workDir` — **declare nothing and you get the old behaviour**, so
upgrading never moves your files. Three ways to point a session somewhere else:

```bash
# 1) Terminal
tusunsun chat --dir /path/to/repo-a

# 2) OpenAI-compatible endpoint: request header (every SDK has extra_headers)
curl -s http://127.0.0.1:9002/v1/chat/completions \
  -H 'X-Tusunsun-Workspace: /path/to/repo-a' \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"repo-a","messages":[{"role":"user","content":"read package.json"}]}'

# 3) Request body field (the extra_body shape)
-d '{"session_id":"repo-a","workspace":"/path/to/repo-a","messages":[...]}'
```

Once declared, that session's **writes, reads, the `Current directory` line in its system prompt,
blast-radius measurement and read-before-write marks** all use it. Two sessions can work in two
repositories at once: the same relative path `src/main.js` is a file in repo A for session A and a
file in repo B for session B.

- **One directory per session**: to move, use a new `session_id` (`409 workspace_conflict`). A
  session's history belongs to the directory it was produced in; silently moving it makes "where was
  this session working?" unanswerable.
- **Refusals are named**: `400` with `workspace_not_found` / `invalid_workspace` / `workspace_not_dir`
  / `workspace_denied`. No silent fallback, no guessing, and **no `mkdir` on your behalf**.
- **Local by default**: loopback clients may point at any existing directory; remote clients
  (`gateway.allowRemote`) must stay inside `workspaces.roots`. Tighter:
  `workspaces.policy: "rooted"` (even local clients must stay inside), or `"off"` to disable it.
- **Observable**: `GET /api/sessions` answers "which session is in which directory"; non-streaming
  responses echo `tusunsun_workspace` — the root that actually took effect, not your input string.

**Bindings are durable, not a cache**:

- Bindings live in `<stateDir>/workspace-bindings.json` (`0600`, atomic write). On restart each one is
  re-verified and restored — a session whose history survives keeps its working directory too.
- **A full table refuses new bindings** (`507 workspace_capacity_exhausted`) and **never evicts**:
  eviction means silently moving a working unit to another project.
- Deleted directory / re-pointed symlink / narrowed allowlist / corrupted metadata ⇒ that session gets
  a named refusal (`409 workspace_binding_unavailable`) and **does not fall back to the default root**.
  Sessions that never declared anything still use the default root (existing deployments unaffected).
- Inspect and release with `tusunsun workspace list` / `tusunsun workspace release <session_id>`.
  Releasing a session with a task in flight is refused (`workspace_busy`) unless forced.

**Not isolated yet** (honest boundaries — do not rely on it):

- **This is not a sandbox**: `tool-bash` can still `cd` anywhere and absolute paths are unrestricted.
  A session's root bounds the *base for relative paths*, not what the model can reach.
- **No lock on a directory**: two sessions pointed at the same repo will step on each other during
  `npm install`. That is the filesystem's business, not the framework's.
- **Default session**: requests without `session_id` land on `rest_api`, so two clients that both omit
  it share one history and one directory.

So "no interference" holds for conversations, tool quota, safety verdicts, task lists, summaries and
working directories; it does not hold for filesystem side effects after a successful execution.

## Cells: execution units with an identity

Sessions answer "whose memory and settings are these". **Cells answer a different question: who did this
work, where was its boundary, and does the result count.** One cell may hold several sessions; they do
not become several cells.

```text
Cell ≠ Task ≠ Session ≠ Core ≠ Process
```

| Concept | What it is |
|---|---|
| **Cell** | An execution subject that durably owns identity, state, a work boundary and a capability view, and independently accepts / executes / delivers tasks |
| **Task** | The work plus its acceptance criteria (may fail, be retried, be reassigned) |
| **Session** | A working-memory channel *inside* a cell |
| **Core** | The plugin/capability/event microkernel (not an agent role) |
| **Process** | The runtime host (v0 is 1 cell : 1 core : 1 process — a **deployment choice**, not the definition) |

Try it (**no API key, no network**):

```bash
node examples/cells/single-cell.mjs          # one cell: deterministic checks, no model call
node examples/cells/dual-cell.mjs            # two cells: two independent processes
node examples/cells/dual-cell.mjs --fail-b   # counterexample: one failure must not turn the run green
```

Cells need a scene that ships `cell-runtime`: `tusunsun start --scene cell`. Every existing scene
(`gateway` / `coding` / `chat` / `gateway-lite`) is **byte-for-byte unchanged** — if you do not opt in,
behaviour is identical to the previous release.

Four things that are easy to misread:

- **Capabilities intersect, and stay enforced at execution time**: effective = host policy ∩ cell spec ∩
  task requirement. Missing on any side gives `capability_denied`, decided **before** any model call or
  file write — and a tool the cell never declared is also refused at the tool entry when the model calls
  it mid-conversation. `permission_mode: read-only` is an execution-time criterion too: every non-read
  tool returns `permission_denied`.
- **Execution ≠ acceptance**: `execution_state: succeeded` only means the run finished. An independent
  acceptor inspects **artifact hashes** and returns `accepted | rejected | inconclusive`. A model saying
  "tests passed" is not evidence.
- **Artifacts must be hashed**: a `WorkResult` entry without a 64-hex sha256 is rejected at the contract
  layer — a self-reported path proves nothing.
- **`max_steps` / `wall_ms` are enforced**: hitting the wall clock is reported as `timed_out` with an
  explicit note that side effects were **not** rolled back, instead of pretending a cancel happened;
  exhausting the step budget is `failed`, not a timeout. Steps are counted per cell session, so other
  conversations cannot consume a cell's budget.

**Explicitly unsupported** (refused, not merely unplanned):

| Item | Status |
|---|---|
| Multiple cells in one process | `runtime.kind: shared_process` → `unsupported_runtime`. Scenes, capability views and event subscriptions are still per-core |
| Autonomous splitting | `max_children` defaults to 0. Splitting means an upper layer submits a CellSpec and a coordinator approves it — not a syscall a cell makes itself |
| OS sandbox | No. `tool-bash` is as unrestricted as in any other scene |
| Distributed exactly-once | Not promised. What is promised: duplicate detection and auditable retries |

See the [Cell RFC](docs/architecture/cell-rfc.md) for the threat model and the full contract.

## Plugin Examples

### Minimal Plugin

```javascript
export default {
  name: 'hello-world',
  version: '1.0.0',
  async init(core) {
    core.log('info', 'Hello from plugin!');
  }
};
```

### Channel Plugin

```javascript
import { ChannelBase } from '../plugins/channel-base.js';

class ChannelMyIM extends ChannelBase {
  name = 'channel-myim';

  async init(core) {
    await super.init(core);
    const config = core.getService('config');
    this.apiToken = config?.get('channels.myim.token');
  }

  async sendReply(sender, text, context) {
    // Send to your IM service
  }
}

export default new ChannelMyIM();
```

### Replacing the model adapter

The shipped implementation is [`plugins/model-openai.js`](plugins/model-openai.js), which handles
OpenAI-compatible ordinary/streaming calls and tools. Other protocols require an adapter that meets the
consumer's model service contract; registering a `call()` method alone is not sufficient for the default scene.

## Documentation

- [Positioning and Pi comparison](docs/positioning-and-pi.md)
- [Plugin Development Guide](docs/guides/plugin-development.md)
- [Quick Start](docs/guides/quick-start.md)
- [Configuration](docs/guides/configuration.md)
- [Scene System](docs/guides/scene-system.md)
- [Microkernel Architecture](docs/architecture/microkernel.md)
- [Naming Conventions](docs/reference/naming.md)
- [Tool Development](docs/reference/tool-development.md)

## Relationship with Qiankun Mirror

This package has local diagnostics and event interfaces, but does not include the full Qiankun Mirror
integration. The default `event-sink` only validates/counts events and does not persist them. External
observability requires an adapter and validation; another product's licensing is defined by that product.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and our security policy.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache License 2.0
