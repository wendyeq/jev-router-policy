# jev-router-policy

Shared Jev effort policy for DSH and Pi. `src/index.ts` remains a pure entry: no filesystem, network, host SDK or effects. Policy version, evidence preparation, budget eviction and effort decisions are unchanged by the transport extraction.

## Node-only client

`src/client.ts` (package export `jev-router-policy/client`) is a separate entry. Both hosts import its sibling source directly:

- `serializeJevRequest(state, questions)` returns exactly `JSON.stringify({ model: 'typesafe-ai/jev', state, questions })`. Hosts use it for byte-budget checks and the final body.
- `sendJevRequest({ body, apiKey, signal, record })` sends one POST to `https://ai-gateway.vercel.sh/v1/evaluate` and returns the original `Response`. It does not resolve credentials, retry, parse responses or decide effort. The host still owns its request-started flag, timeout, cancellation, errors and metering.
- `record` supplies the host's request directory, owning session ID, existing safe session filename and warning sink. Each call at the fetch position schedules an asynchronous append of `{ time, sessionId, body }` only. The same complete body string is used for fetch and logging; headers, responses and decision snapshots are never added.

DSH stores records in `<stateDirectory>/requests/<encodeURIComponent(sessionId)>.jsonl`. Pi stores them in `<Pi agent dir>/jev-router/requests/<safeSessionId>.jsonl`, using its existing session filename allowlist. They are outside metadata ledger scans. Retries generate a line per actual POST; single-choice shortcuts, reused decisions and unsent budget failures do not.

**Privacy:** body is unredacted actual Jev input and may contain private conversation or tool text and secrets. Authorization and API keys are not copied from request headers. A secret already inside conversation text remains inside body. New request directories are mode `0700`, files `0600`; the writer also tightens existing modes and rejects traversal filenames, symlink request directories/files, nonregular files and multiply-linked files. Keep access to this directory private; retention/removal is manual, not an automatic service.

**Best effort:** fetch and the main request never await disk I/O. A write failure reports only `Jev request log write failed` through the host warning sink, without filesystem error text, body or credentials. Sudden process exit can lose unfinished appends; this is not transactional durability. The append adds local CPU/filesystem work, not zero performance overhead, but adds no network request or disk wait to generation.

## Verification and loading

`npm test` runs pure contracts and mock-fetch/client tests, including exact old-format bytes, fetch/log equality, retry-shaped repeated POSTs, privacy, modes, traversal/symlink rejection, slow/failing disk and unchanged network errors. No real credentials or Gateway calls are needed. Tests wait for complete asynchronous records before checking/cleaning their private temporary directories.

This source-only project has no build artifact. DSH's `npm run build` bundles the shared source into its own bundle; the host must load the rebuilt plugin on its next process start. Pi loads sibling sources when its extension loads: `/reload` is required for a running instance. Rebuilding DSH does not hot-reload a running Harness; editing the sibling source does not change an already loaded Pi extension. Runtime reload/restart is left to the operator.

[Synthetic request example](examples/requests/synthetic-demo.jsonl) was generated through the shared sender with mock fetch and checked against the body received by that mock. Example line (the body field is a JSON string, not a reconstructed object):

```jsonl
{"time":"2026-09-30T16:00:41.158Z","sessionId":"synthetic-demo","body":"{\"model\":\"typesafe-ai/jev\",\"state\":{\"messages\":[{\"role\":\"user\",\"text\":\"synthetic task\"}]},\"questions\":{\"route\":{\"type\":\"choice\",\"instructions\":\"Choose one\",\"criteria\":{\"low\":\"simple\",\"high\":\"hard\"}}}}"}
```

The example is synthetic; production records are triggered only at an actual fetch attempt.
