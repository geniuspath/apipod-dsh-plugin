# Security

## Reporting a vulnerability

Please report security issues privately, through
[GitHub private vulnerability reporting](https://github.com/geniuspath/apipod-dsh-plugin/security/advisories/new).
Do not open a public issue for a vulnerability. Include the plugin version, the
dsh version, and steps to reproduce.

## What this plugin does with your API key

- The configuration holds only the **name** of a credential reference
  (`apiKeyRef`, default `APIPOD_API_KEY`). A value that is not a reference name
  fails the plugin load, so a key pasted into `cordis.yml` is rejected.
- The key is resolved from dsh's credential service for each request and is not
  kept in memory between requests, logged, or written to disk by this plugin.
- It is sent only as an `Authorization` header, only to `baseUrl`, only over
  https (http is accepted solely for a loopback host with `allowInsecureBaseUrl`),
  and redirects are refused. The public catalog endpoints are called without it.
- Error text from the server is truncated and has the key removed before it
  reaches the model or the session log.

## What a model can and cannot make it do

- Calls that spend the account balance ask the user first by default
  (`approvalMode: generation`).
- A repeated submission of the same call carries the same `Idempotency-Key`, so
  APIPod returns the first job rather than charging twice.
- The model cannot set `callback_url`, `user` or override `model` through `extras`.
- Reference media must be an https URL or an inline `data:` payload. The plugin
  never reads local files and has no file-system or subprocess access.

## Supply chain

- The package has no `preinstall`, `install`, `postinstall` or `prepare` script;
  installing it runs none of its code. CI fails if one is added.
- Releases are published from GitHub Actions with npm provenance, so the tarball
  can be traced to the commit that built it. Workflow actions are pinned by commit.
- The published tarball contains only `lib/`, `cordis.patch.yml`, `README.md`,
  `README.zh-CN.md`, `LICENSE` and `package.json`.

A dsh plugin runs inside the dsh process with the same access as dsh itself.
Install plugins, including this one, only from a source you trust.
