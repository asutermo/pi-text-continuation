import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../extensions/text-continuation.mjs";

function harness(env = {}) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_TEXT_CONTINUATION")) delete process.env[key];
  Object.assign(process.env, { PI_TEXT_CONTINUATION: "1", ...env });
  const handlers = {}, entries = [];
  let aborted = 0;
  try {
    extension({ on: (name, callback) => { handlers[name] = callback; },
      appendEntry: (type, data) => { entries.push({ type, data }); } });
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_TEXT_CONTINUATION")) delete process.env[key];
    Object.assign(process.env, saved);
  }
  const ctx = { model: { api: "openai-completions", maxTokens: 16384 },
    hasPendingMessages: () => false, abort: () => { aborted++; } };
  const emit = (name, event = {}) => handlers[name]?.(event, ctx);
  emit("before_agent_start");
  return { handlers, ctx, entries, emit, aborted: () => aborted };
}
const assistant = (stopReason = "length", content = [{ type: "text", text: "unfinished answer" }], output = 16384) =>
  ({ role: "assistant", stopReason, content, usage: { output } });
const boundary = (message, overrides = {}) => ({ outcome: "completed", entries: [], continue: false,
  context: { pendingMessages: [], llmMessages: [message], canContinue: false }, ...overrides });

for (const stop of ["stop", "error", "aborted", "toolUse"]) {
  test(`does not continue ${stop}`, () => {
    assert.equal(harness().emit("agent_before_settle", boundary(assistant(stop))), undefined);
  });
}
test("disabled unless explicitly enabled, ignoring unrelated configuration", () => {
  for (const value of [undefined, "0", "true", "yes"]) {
    const h = harness({ PI_TEXT_CONTINUATION: value, PI_TEXT_CONTINUATION_MAX: "invalid" });
    assert.deepEqual(h.handlers, {});
  }
});
test("appends a prompt and retains partial response and other extension entries", () => {
  const h = harness(), message = assistant(), prior = { type: "custom", customType: "other" };
  const event = boundary(message, { entries: [prior] });
  const result = h.emit("agent_before_settle", event);
  assert.equal(result.continue, true);
  assert.equal(event.context.llmMessages[0], message);
  assert.deepEqual(result.entries[0], prior);
  assert.match(result.entries[1].content, /Do not repeat completed work/);
  assert.equal(h.emit("agent_before_settle", event), undefined);
});
for (const content of [
  [], [{ type: "text", text: "  " }], [{ type: "thinking", thinking: "unfinished thought" }],
  [{ type: "text", text: "partial" }, { type: "toolCall", id: "truncated", arguments: {} }],
  [{ type: "image", data: "" }],
]) {
  test(`leaves non-text or tool recovery to Pi: ${JSON.stringify(content)}`, () => {
    assert.equal(harness().emit("agent_before_settle", boundary(assistant("length", content))), undefined);
  });
}
test("allows thinking alongside nonempty text", () => {
  assert.equal(harness().emit("agent_before_settle", boundary(assistant("length", [
    { type: "thinking", thinking: "reasoning" }, { type: "text", text: "partial" },
  ]))).continue, true);
});
test("honors abort, failure, queued input and existing continuation", () => {
  for (const kind of ["aborted", "error", "signal", "queued", "pending", "continue"]) {
    const h = harness(), event = boundary(assistant());
    if (["aborted", "error"].includes(kind)) event.outcome = kind;
    if (kind === "signal") h.ctx.signal = AbortSignal.abort();
    if (kind === "queued") h.ctx.hasPendingMessages = () => true;
    if (kind === "pending") event.context.pendingMessages = [{}];
    if (kind === "continue") event.continue = true;
    assert.equal(h.emit("agent_before_settle", event), undefined, kind);
  }
});
test("limits repeated text continuations and does not reset for internal agent_start", () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    assert.equal(h.emit("agent_before_settle", boundary(assistant())).continue, true);
    h.emit("agent_start");
  }
  assert.equal(h.emit("agent_before_settle", boundary(assistant())), undefined);
  assert.equal(h.entries.at(-1).data.reason, "continuation_limit");
  const audits = h.entries.length;
  h.emit("agent_before_settle", boundary(assistant()));
  assert.equal(h.entries.length, audits, "do not repeatedly audit the same stop");
  h.emit("before_agent_start");
  assert.equal(h.emit("agent_before_settle", boundary(assistant())).continue, true);
});
test("caps every extra request, counts output once, and stops at budget", () => {
  const h = harness({ PI_TEXT_CONTINUATION_OUTPUT_TOKENS: "9" });
  const payload = { max_tokens: 16384, messages: ["untouched"] };
  assert.equal(h.emit("before_provider_request", { payload }), undefined);
  h.emit("message_end", { message: assistant() }); // The original response is not extra output.
  h.emit("agent_before_settle", boundary(assistant()));
  assert.deepEqual(h.emit("before_provider_request", { payload }), { ...payload, max_tokens: 9 });
  assert.equal(payload.max_tokens, 16384);
  const msg = assistant("toolUse", [{ type: "toolCall" }], 5);
  h.emit("message_end", { message: msg }); h.emit("message_end", { message: msg });
  h.emit("message_end", { message: { role: "toolResult" } });
  assert.equal(h.emit("before_provider_request", { payload: { max_completion_tokens: 8 } }).max_completion_tokens, 4);
  h.emit("message_end", { message: assistant("length", undefined, 4) });
  assert.equal(h.emit("agent_before_settle", boundary(assistant())), undefined);
  assert.equal(h.entries.at(-1).data.reason, "output_budget");
  h.emit("before_provider_request", { payload });
  assert.equal(h.aborted(), 1);
});
test("honors the smallest cap, including both cap fields, and can supply the model cap", () => {
  const h = harness(); h.emit("agent_before_settle", boundary(assistant()));
  assert.deepEqual(h.emit("before_provider_request", { payload: { max_tokens: 2, max_completion_tokens: 10 } }),
    { max_tokens: 2, max_completion_tokens: 2 });
  assert.deepEqual(h.emit("before_provider_request", { payload: {} }), { max_tokens: 16384 });
});
test("unsupported providers do not continue; provider changes fail closed", () => {
  const h = harness(); h.ctx.model.api = "anthropic-messages";
  assert.equal(h.emit("agent_before_settle", boundary(assistant())), undefined);
  assert.equal(h.aborted(), 0);
  h.ctx.model.api = "openai-completions"; h.emit("before_agent_start");
  h.emit("agent_before_settle", boundary(assistant()));
  h.ctx.model.api = "openai-responses";
  h.emit("before_provider_request", { payload: { max_tokens: 10 } });
  assert.equal(h.aborted(), 1);
});
test("unknown usage blocks new requests without interrupting current tools", () => {
  for (const output of [undefined, 0, -1, NaN, 1.5, Infinity, "4"]) {
    const h = harness(); h.emit("agent_before_settle", boundary(assistant()));
    h.emit("message_end", { message: { ...assistant(), usage: { output } } });
    assert.equal(h.aborted(), 0);
    assert.equal(h.entries.at(-1).data.reason, "missing_output_usage");
    h.emit("before_provider_request", { payload: { max_tokens: 10 } });
    assert.equal(h.aborted(), 1);
  }
});
test("invalid request caps or payloads abort before sending an unbounded request", () => {
  for (const payload of [null, [], "string", { max_tokens: 0 }, { max_tokens: "12" }, { max_tokens: Infinity }]) {
    const h = harness(); h.emit("agent_before_settle", boundary(assistant()));
    assert.equal(h.emit("before_provider_request", { payload }), undefined);
    assert.equal(h.aborted(), 1);
  }
});
test("elapsed window blocks a new continuation but never aborts productive work", async () => {
  const h = harness({ PI_TEXT_CONTINUATION_WINDOW_SECONDS: "0.001" });
  h.emit("agent_before_settle", boundary(assistant()));
  await new Promise(resolve => { setTimeout(resolve, 10); });
  assert.equal(h.aborted(), 0);
  assert.equal(h.emit("before_provider_request", { payload: { max_tokens: 20 } }).max_tokens, 20);
  assert.equal(h.emit("agent_before_settle", boundary(assistant())), undefined);
  assert.equal(h.entries.at(-1).data.reason, "continuation_window");
  assert.equal(h.aborted(), 0);
});
test("session and prompt boundaries reset budgets, settlement records final usage", () => {
  for (const event of ["agent_settled", "session_shutdown", "session_switch", "before_agent_start"]) {
    const h = harness(); h.emit("agent_before_settle", boundary(assistant()));
    h.emit("message_end", { message: assistant("stop", undefined, 11) });
    h.emit(event);
    if (event === "agent_settled") {
      assert.equal(h.entries.at(-1).data.action, "settled");
      assert.equal(h.entries.at(-1).data.extra_output_tokens, 11);
    }
    assert.equal(h.emit("before_provider_request", { payload: { max_tokens: 10 } }), undefined);
    assert.equal(h.emit("agent_before_settle", boundary(assistant())).continue, true);
  }
});
test("rejects invalid or unbounded configuration and old hard-deadline setting", () => {
  for (const env of [
    { PI_TEXT_CONTINUATION_MAX: "0" }, { PI_TEXT_CONTINUATION_MAX: "1.5" },
    { PI_TEXT_CONTINUATION_MAX: "9" }, { PI_TEXT_CONTINUATION_OUTPUT_TOKENS: "NaN" },
    { PI_TEXT_CONTINUATION_OUTPUT_TOKENS: "262145" },
    { PI_TEXT_CONTINUATION_WINDOW_SECONDS: "Infinity" }, { PI_TEXT_CONTINUATION_WINDOW_SECONDS: "-1" },
    { PI_TEXT_CONTINUATION_WINDOW_SECONDS: "3601" },
  ]) assert.throws(() => harness(env), /must be positive/);
  assert.throws(() => harness({ PI_TEXT_CONTINUATION_SECONDS: "120" }), /was removed/);
});
