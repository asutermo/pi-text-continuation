// Copyright (c) 2026. All rights reserved.
// Pi 1.0.0: opt-in continuation at the final, actionable settlement boundary.
const TYPE = "pi-text-continuation";
const PROMPT = "Your previous response reached its output limit. Continue the unfinished task " +
  "from the existing response and workspace state. Do not repeat completed work or rerun " +
  "completed tool calls. If the task is already complete, provide the final answer and stop.";

function setting(name, fallback, maximum, integer = true) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0 || value > maximum ||
      (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name} must be positive${integer ? " and integral" : ""}, at most ${maximum}`);
  }
  return value;
}

export default function textContinuation(pi) {
  if (process.env.PI_TEXT_CONTINUATION !== "1") return;
  if (process.env.PI_TEXT_CONTINUATION_SECONDS !== undefined) {
    throw new Error("PI_TEXT_CONTINUATION_SECONDS was removed. Use " +
      "PI_TEXT_CONTINUATION_WINDOW_SECONDS for a soft continuation window; " +
      "set whole-task deadlines in the caller.");
  }
  const limits = {
    continuations: setting("PI_TEXT_CONTINUATION_MAX", 2, 8),
    outputTokens: setting("PI_TEXT_CONTINUATION_OUTPUT_TOKENS", 32768, 262144),
    windowSeconds: setting("PI_TEXT_CONTINUATION_WINDOW_SECONDS", 120, 3600, false),
  };
  let count, used, started, blocked, lastHandled, seen;
  function reset() {
    count = 0;
    used = 0;
    started = undefined;
    blocked = undefined;
    lastHandled = undefined;
    seen = new WeakSet();
  }
  reset();
  const audit = (action, reason) => pi.appendEntry(TYPE, {
    schema_version: 1, action, reason, continuations: count,
    extra_output_tokens: used, limits,
  });
  function stop(reason) {
    if (!blocked) {
      blocked = reason;
      audit("stopped", reason);
    }
  }
  function budgetReason() {
    return blocked || (used >= limits.outputTokens ? "output_budget" : undefined);
  }
  pi.on("before_agent_start", () => { reset(); audit("enabled", "explicit_opt_in"); });
  pi.on("session_switch", reset);
  pi.on("session_shutdown", reset);
  pi.on("agent_settled", (_event, ctx) => {
    if (started !== undefined) audit("settled", blocked || (ctx.signal?.aborted ? "aborted" : "settled"));
    reset();
  });

  pi.on("message_end", ({ message }) => {
    if (started === undefined || message.role !== "assistant" || seen.has(message)) return;
    seen.add(message);
    const output = message.usage?.output;
    // Pi may normalize absent provider usage to zero. A nonempty successful
    // response with zero output tokens cannot support reliable budget accounting.
    const nonempty = message.content?.some(part => part.type === "toolCall" ||
      (part.type === "text" && part.text?.length) || (part.type === "thinking" && part.thinking?.length));
    if (!Number.isSafeInteger(output) || output < 0 ||
        (output === 0 && nonempty && !["error", "aborted"].includes(message.stopReason))) {
      // Let any current tool work finish; block the next request if accounting is unknown.
      stop("missing_output_usage");
      return;
    }
    used += output;
  });

  pi.on("before_provider_request", ({ payload }, ctx) => {
    if (started === undefined) return;
    let reason = ctx.signal?.aborted ? "aborted" : budgetReason();
    if (!reason && (ctx.model?.api !== "openai-completions" || !payload ||
        typeof payload !== "object" || Array.isArray(payload))) reason = "unsupported_provider";
    if (reason) {
      stop(reason);
      ctx.abort();
      return;
    }
    // Only this API's budget fields have been qualified. Never raise a caller's cap.
    const fields = ["max_completion_tokens", "max_tokens"].filter(key => Object.hasOwn(payload, key));
    if (!fields.length) fields.push("max_tokens");
    const caps = fields.map(key => payload[key] ?? ctx.model.maxTokens);
    if (caps.some(cap => !Number.isSafeInteger(cap) || cap <= 0)) {
      stop("missing_request_limit");
      ctx.abort();
      return;
    }
    const cap = Math.min(...caps, limits.outputTokens - used);
    return { ...payload, ...Object.fromEntries(fields.map(key => [key, cap])) };
  });

  pi.on("agent_before_settle", (event, ctx) => {
    // Pi has drained tool recovery, queued input, retries and automatic compaction.
    if (event.outcome !== "completed" || ctx.signal?.aborted || event.continue ||
        ctx.hasPendingMessages() || event.context.pendingMessages.length) return;
    const message = event.context.llmMessages.at(-1);
    if (message?.role !== "assistant" || message.stopReason !== "length" ||
        message === lastHandled || !Array.isArray(message.content) ||
        message.content.some(part => !["text", "thinking"].includes(part.type)) ||
        !message.content.some(part => part.type === "text" && part.text?.trim())) return;
    if (ctx.model?.api !== "openai-completions") {
      stop("unsupported_provider");
      return;
    }
    // Elapsed time only prevents another automatic continuation. No abort timer:
    // a productive response or tool call may finish beyond this soft window.
    const reason = budgetReason() || (count >= limits.continuations ? "continuation_limit" : undefined) ||
      (started !== undefined && performance.now() - started >= limits.windowSeconds * 1000
        ? "continuation_window" : undefined);
    if (reason) { stop(reason); return; }
    lastHandled = message;
    started ??= performance.now();
    count++;
    audit("continued", "text_output_limit");
    // canContinue describes the current transcript, before our new prompt. Pi
    // recomputes it after committing these entries, so it is not a veto here.
    return {
      entries: [...event.entries, {
        type: "custom_message", customType: TYPE, content: PROMPT, display: true,
        details: { continuation: count, remaining_output_tokens: limits.outputTokens - used },
      }],
      continue: true,
    };
  });
}
