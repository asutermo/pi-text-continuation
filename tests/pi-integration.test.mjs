import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const piRoot = join(root, "node_modules/@earendil-works/pi-coding-agent");
const piPackage = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8"));
assert.equal(piPackage.version, "1.0.0", "integration tests require the pinned Pi release");
const cli = resolve(piRoot, piPackage.bin.pi);

// All inference stays on loopback; token usage is synthetic. No credentials or
// campaign data are read. Load the package directory to test manifest discovery.
for (const condition of ["disabled", "normal", "length", "limit", "budget", "budget-tool",
  "truncated-tool", "slow-tool", "slow-response", "window", "missing-usage", "cancel"]) {
  test(`Pi 1.0.0 package: ${condition}`, { timeout: 30000 }, async t => {
    const temp = await mkdtemp(join(tmpdir(), "pi-text-continuation-test-"));
    const config = join(temp, "config"), sessions = join(temp, "sessions");
    await mkdir(config);
    const requests = [], delays = new Set();
    let child, timer, timedOut = false, serverError;
    const server = createServer((req, res) => {
      void respond(req, res).catch(error => { serverError = error; res.destroy(); });
    });
    t.after(async () => {
      clearTimeout(timer);
      for (const delay of delays) clearTimeout(delay);
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise(resolve => { server.close(resolve); });
      await rm(temp, { recursive: true, force: true });
    });
    async function respond(req, res) {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const n = requests.length;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      if (condition === "cancel" && n === 2) {
        delays.add(setTimeout(() => child.kill("SIGINT"), 50));
        return;
      }
      const truncated = condition === "truncated-tool" && n === 1;
      const tool = ["slow-tool", "budget-tool"].includes(condition) && n === 2;
      const length = condition !== "normal" && (n === 1 || ["limit", "budget", "window", "missing-usage"].includes(condition));
      const delta = truncated
        ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function",
          function: { name: "write", arguments: '{"path":"must-not-exist","content":"unfinished' } }] }
        : tool
          ? { role: "assistant", tool_calls: [{ index: 0, id: "call_2", type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "sleep 0.25; printf TOOL_COMPLETE" }) } }] }
          : { role: "assistant", content: n === 1 ? "PARTIAL_RESPONSE_SENTINEL" : "continued response" };
      const tokens = n === 1 ? (length ? 16384 : 3)
        : condition === "budget" ? (n === 2 ? 5 : 4) : tool ? 5 : 3;
      const frame = (delta, finish_reason, usage) => ({ id: "synthetic", object: "chat.completion.chunk",
        created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
      const finish = () => {
        res.write(`data: ${JSON.stringify(frame(delta, null))}\n\n`);
        res.write(`data: ${JSON.stringify(frame({}, tool ? "tool_calls" : length ? "length" : "stop",
          condition === "missing-usage" && n === 2 ? undefined : {
          prompt_tokens: 100, completion_tokens: tokens, total_tokens: 100 + tokens,
        }))}\n\n`);
        res.end("data: [DONE]\n\n");
      };
      if (["slow-response", "window"].includes(condition) && n === 2) delays.add(setTimeout(finish, 250));
      else finish();
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await writeFile(join(config, "models.json"), JSON.stringify({ providers: { fixture: {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-placeholder",
      models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 131072,
        maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await writeFile(join(config, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
    child = spawn(process.execPath, [cli, "--provider", "fixture", "--model", "fixture", "--thinking", "off",
      "--session-dir", sessions, "--no-extensions", "--extension", root,
      "--no-skills", "--mode", "json", "-p", "Return a synthetic response."], {
      cwd: temp,
      env: { PATH: process.env.PATH, HOME: temp, PI_CODING_AGENT_DIR: config,
        PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        PI_TEXT_CONTINUATION: condition === "disabled" ? "0" : "1", PI_TEXT_CONTINUATION_MAX: "2",
        PI_TEXT_CONTINUATION_OUTPUT_TOKENS: condition === "budget" ? "9" : condition === "budget-tool" ? "5" : "32768",
        PI_TEXT_CONTINUATION_WINDOW_SECONDS: ["slow-tool", "slow-response", "window"].includes(condition) ? "0.05" : "120" },
    });
    child.stdin.end();
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 25000);
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    clearTimeout(timer);
    assert.ifError(serverError);
    assert(!timedOut, `${condition} stalled: ${stderr}`);
    assert(!/Failed to load extension|Extension.*error|extension_error/i.test(stderr), stderr);
    const events = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const stops = events.filter(e => e.type === "message_end" && e.message?.role === "assistant").map(e => e.message.stopReason);
    const records = [];
    for (const file of await readdir(sessions)) {
      if (file.endsWith(".jsonl")) records.push(...(await readFile(join(sessions, file), "utf8"))
        .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    }
    const audit = records.filter(e => e.type === "custom" && e.customType === "pi-text-continuation").map(e => e.data);
    const continued = audit.filter(e => e.action === "continued");
    const expectedRequests = ["disabled", "normal"].includes(condition) ? 1
      : ["limit", "budget", "slow-tool"].includes(condition) ? 3 : 2;
    const details = JSON.stringify({ condition, code, requests: requests.length, stops, audit, stderr });
    assert.equal(requests.length, expectedRequests, details);
    if (condition !== "cancel") assert.equal(code, 0, details);
    if (["disabled", "normal", "truncated-tool"].includes(condition)) assert.equal(continued.length, 0, details);
    else assert.equal(continued.length, ["limit", "budget"].includes(condition) ? 2 : 1, details);
    if (["length", "slow-response"].includes(condition)) {
      assert.deepEqual(stops, ["length", "stop"], details);
      assert(JSON.stringify(requests[1].messages).includes("PARTIAL_RESPONSE_SENTINEL"));
      assert(JSON.stringify(requests[1].messages).includes("Do not repeat completed work"));
    }
    if (condition === "budget") {
      assert.deepEqual(requests.map(r => r.max_tokens ?? r.max_completion_tokens), [16384, 9, 4]);
      assert(audit.some(e => e.reason === "output_budget"), details);
    }
    if (condition === "limit") assert(audit.some(e => e.reason === "continuation_limit"), details);
    if (condition === "missing-usage") assert(audit.some(e => e.reason === "missing_output_usage"), details);
    if (condition === "window") {
      assert.deepEqual(stops, ["length", "length"], details);
      assert(audit.some(e => e.reason === "continuation_window"), details);
    }
    if (["slow-tool", "budget-tool"].includes(condition)) {
      const tool = events.find(e => e.type === "tool_execution_end");
      assert(tool && !tool.isError && tool.result.content.some(c => c.text?.includes("TOOL_COMPLETE")), details);
      if (condition === "slow-tool") {
        assert.deepEqual(stops, ["length", "toolUse", "stop"], details);
        assert(!audit.some(e => e.action === "stopped"), details);
      } else assert(audit.some(e => e.reason === "output_budget"), details);
    }
    if (condition === "truncated-tool") {
      assert.deepEqual(stops, ["length", "stop"], details);
      assert(!JSON.stringify(requests[1].messages).includes("Do not repeat completed work"));
      const tool = events.find(e => e.type === "tool_execution_end");
      assert(tool?.isError && tool.result.content.some(c => c.text?.includes("was not executed")), details);
    }
    await assert.rejects(readFile(join(temp, "must-not-exist")), { code: "ENOENT" });
  });
}
