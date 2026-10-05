# Pi text continuation

An opt-in Pi extension that requests another response when a **text-only response
hits its output-token limit**. It preserves the partial response and workspace
state and asks Pi to continue the unfinished task.

It does not increase the provider's per-response limit. For example, a model
capped at 16,384 output tokens can produce one capped response and then continue
in a separate request. Additional requests consume tokens and can execute tools
under the same permissions as the original task.

Tested with **Pi 1.0.0**, Node 22, and the **`openai-completions`** API. Other Pi
versions and provider APIs are not qualified. There are no runtime dependencies,
model registrations, credentials, or service changes in this package.

## Install and enable

For a reproducible installation, replace `COMMIT_SHA` with a reviewed full commit
from this repository:

```bash
pi install git:github.com/asutermo/pi-text-continuation@COMMIT_SHA
PI_TEXT_CONTINUATION=1 pi
```

To try a checkout without changing Pi's installed packages:

```bash
git clone --branch feat/text-continuation git@github.com:asutermo/pi-text-continuation.git
PI_TEXT_CONTINUATION=1 pi --extension ./pi-text-continuation
```

The extension is disabled unless `PI_TEXT_CONTINUATION=1`. Installation alone
does not enable continuation. Use Pi's existing provider/model configuration;
this package does not supply or read API keys. Do not load the old bundled
prototype alongside this extension.

## Configuration

Set environment variables before starting Pi. Invalid enabled configuration
produces an extension-load error; automated callers should check Pi's startup
diagnostics. Pi can continue running when an extension fails to load.

| Variable | Default | Allowed values | Meaning |
| --- | ---: | --- | --- |
| `PI_TEXT_CONTINUATION` | Disabled | `1` enables | Explicit opt-in |
| `PI_TEXT_CONTINUATION_MAX` | 2 | Integer 1–8 | Maximum automatic text continuations per user prompt |
| `PI_TEXT_CONTINUATION_OUTPUT_TOKENS` | 32768 | Integer 1–262144 | Shared output budget after the first automatic continuation |
| `PI_TEXT_CONTINUATION_WINDOW_SECONDS` | 120 | Number greater than 0, at most 3600 | Time window for starting further automatic text continuations |

**The time window is not a task timeout.** It starts at the first automatic
continuation and is checked only at the next final settlement boundary. When
it expires, an active response or tool call can finish. Subsequent model
requests within that ongoing work still share the output budget. A further
text-only length stop will not trigger another automatic continuation.

Set whole-task deadlines in the caller or evaluation harness. This extension
does not terminate a stalled request or tool after a fixed number of seconds.
User cancellation remains authoritative.

The output budget covers all assistant output after continuation begins,
including tool-call output and ordinary follow-up responses. It excludes the
initial response, input tokens, and tool-result text. Request caps are lowered
to the remaining budget and never raised. Once exhausted, the next provider
request is aborted; current tool work is allowed to finish. Two automatic
continuations does not mean a maximum of two provider requests: normal tool
interaction can require more requests within the shared output budget.

Budget enforcement relies on a provider honoring its request cap and accurately
reporting output usage. Missing/invalid usage, including a nonempty successful
response with zero reported output, prevents further requests. Unsupported API
types are skipped before continuation; switching to one during continuation
blocks the next request.

## Behavior and traces

At Pi's `agent_before_settle` boundary, the extension continues only when the
last message is an assistant `length` stop with nonempty text and no tool calls.
It preserves text/thinking and appends a visible continuation instruction. It
leaves normal completion, errors, aborted runs, thinking-only output, queued
user input, and another extension's requested continuation alone. Pi retains
responsibility for recovering truncated tool calls.

Native session JSONL contains `custom` audit records with
`customType: "pi-text-continuation"`, plus the visible `custom_message`
continuation prompts. Audit schema version 1 records:

- Actions: `enabled`, `continued`, `stopped`, `settled`.
- Reasons such as `text_output_limit`, `continuation_limit`, `output_budget`,
  `continuation_window`, `missing_output_usage`, or `unsupported_provider`.
- Continuation count, measured extra output tokens, and configured limits.

Audit entries contain no prompt text or credentials. They are session metadata;
the continuation instruction is model context. Budgets reset for a new user
prompt and on session boundaries. Counters are not restored across process
restarts; the caller owns campaign-wide or monetary budgets.

## Migrating from the bundled prototype

The earlier prototype used `PI_TEXT_CONTINUATION_SECONDS` to abort the entire
ongoing continuation after a wall-clock deadline, including productive tools.
That setting is rejected here to prevent silently changing its meaning.
Remove it and explicitly choose `PI_TEXT_CONTINUATION_WINDOW_SECONDS` instead.
The opt-in, count, and output-budget variables retain their names. Audit entries
now use the standalone package name and an explicit schema version.

Pin this package's Git commit when including it in an agent bundle. Include only
`extensions/` and the package manifest/docs; do not ship the development
`node_modules` tree or the old prototype. Rebuild and qualify the bundle before
changing an evaluation profile. Existing bundles and results are unchanged by
this repository.

## Development and validation

```bash
npm ci
npm run lint
npm test
npm run commit-check -- --message-file /path/to/commit-message
git commit -s
npm run commit-check
```

Use Conventional Commits and DCO sign-off. Work on a branch, never commit or
push directly to `main`. `npm run commit-check -- BASE..HEAD` validates a range.

The test suite includes isolated unit tests and the actual pinned Pi CLI with
a synthetic SSE provider on loopback. It checks package discovery, preserving
partial text, count/token limits, cancellation, missing usage, Pi's truncated
tool recovery, and productive tools/responses that finish beyond the soft time
window. Tests require Linux/macOS with Bash and permission to bind localhost.
They make no real model calls and need no API key. Reported token usage is
synthetic, so these tests do not establish model quality or benchmark uplift.

Pi 1.0.0's development-only shrinkwrap currently pins `brace-expansion` 5.0.9,
which `npm audit` flags for denial-of-service vulnerabilities. This package has
no production dependencies; the pinned upstream test tree is not distributed.
Do not treat the development audit as clean or upgrade the qualified Pi version
silently. See [the upstream advisory](https://github.com/advisories/GHSA-qhr7-859c-m2p7).

Before a broader rollout, compare the same affected tasks with the extension
disabled and enabled, holding model, task images, verifiers, and whole-task
deadline constant. Record required-test outcomes, completion/abort reasons,
extra tokens, continuation counts, and whether patches and traces were captured.
Keep infrastructure, verifier, provider, and extension stops separate from
qualified reward failures.

The package is distributed through Git; no npm release has been published.

## Pi API references

- [Pi 1.0.0 extension lifecycle](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/extensions.md)
- [Pi 1.0.0 package installation and manifests](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/packages.md)
