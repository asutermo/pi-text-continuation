# Changelog

## 0.1.0 — 2026-10-05

- Extract the campaign prototype into a standalone, opt-in Pi package.
- Replace the timer that aborted productive work with a soft window checked
  only before starting another automatic text continuation.
- Bound continuation count and shared extra output; preserve smaller request caps.
- Defer budget/accounting aborts to the next provider request so tools can finish.
- Leave Pi's truncated-tool recovery, normal stops, and user cancellation intact.
- Record versioned audit metadata and final extra-output usage in native sessions.
- Add unit and real Pi 1.0.0 CLI tests against a local synthetic provider.

This is a new package candidate. Existing campaign scores describe the earlier
bundled prototype and do not validate this package's revised timeout policy.
