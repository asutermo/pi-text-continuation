import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Before committing: npm run commit-check -- --message-file /path/to/message.
// After committing / in CI: npm run commit-check -- [base..head].
const git = args => execFileSync("git", args, { encoding: "utf8" });
const args = process.argv.slice(2);
git(["diff", "--check"]);
git(["diff", "--cached", "--check"]);
const messages = args[0] === "--message-file"
  ? [readFileSync(args[1], "utf8")]
  : git(["log", "--format=%B%x00", args[0] || "-1"]).split("\0").map(s => s.trim()).filter(Boolean);
assert(messages.length, "No commit messages checked");
for (const message of messages) {
  assert(/^(feat|fix|docs|test|refactor|build|ci|chore)(\([\w-]+\))?!?: [a-z].+/u.test(message),
    "Use a Conventional Commit subject beginning with lowercase text");
  assert(/^Signed-off-by: .+ <[^<>\s]+@[^<>\s]+>$/mu.test(message), "DCO Signed-off-by trailer required");
}
console.log(`Commit checks passed (${messages.length} message(s))`);
