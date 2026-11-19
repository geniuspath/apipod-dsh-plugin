# APIPod for DeepSeek Harness

Image and video generation tools for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (dsh),
backed by [APIPod](https://www.apipod.ai). One plugin gives a dsh agent the
APIPod model catalog, price quotes, and asynchronous image and video jobs.

It is a native dsh plugin: it runs inside dsh and calls the APIPod HTTP API
directly. It does not need the APIPod MCP server.

## Install

Requires dsh `>=0.2.2-rc.5 <0.3.0`.

```bash
dsh plugin --profile <profile> add @apipod/dsh-plugin
```

Then give dsh your API key (create one in the
[APIPod console](https://www.apipod.ai/console/api-keys)). The plugin reads the
credential reference `APIPOD_API_KEY`, which dsh resolves from its credential
settings or from the environment:

```bash
export APIPOD_API_KEY=...
```

Start dsh with that profile. To confirm the layer is applied:

```bash
dsh --profile <profile> --dump-config
```

## Tools

| Tool | What it does | Spends balance |
| --- | --- | --- |
| `apipod_list_models` | Lists image, video and speech models | no |
| `apipod_get_model_params` | Returns one model's request schema | no |
| `apipod_estimate_cost` | Quotes a generation and compares it with the balance | no |
| `apipod_get_balance` | Reads the account balance in USD | no |
| `apipod_generate_image` | Starts an image job, returns `job_id` | **yes** |
| `apipod_generate_video` | Starts a video job, returns `job_id` | **yes** |
| `apipod_check_job` | Reads a job's status, result URLs and final cost | no |

Generation is asynchronous: a generate call returns a `job_id` and `kind` at
once, and the agent polls `apipod_check_job` until the status is `completed`,
`failed` or `cancelled`. A failed job is refunded by APIPod.

Model-specific parameters go in `extras`; `apipod_get_model_params` lists them.

## Configuration

Set these under the plugin's row in a `cordis.patch.yml`. A patch replaces a
row's whole `config`, so restate every key you want to keep.

```yaml
- id: apipod
  name: '@apipod/dsh-plugin'
  config:
    apiKeyRef: APIPOD_API_KEY
    approvalMode: generation
```

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKeyRef` | `APIPOD_API_KEY` | Name of the credential reference holding the key. Never the key itself |
| `approvalMode` | `generation` | `generation`: spending tools ask first. `always`: every tool asks. `never`: no prompt from this plugin |
| `baseUrl` | `https://api.apipod.ai` | API origin. Must be https |
| `allowInsecureBaseUrl` | `false` | Allow an `http://` `baseUrl` for a loopback host only |
| `requestTimeoutMs` | `30000` | Deadline for one HTTP request |
| `maxExtrasKeys` | `32` | Most keys accepted in `extras` |
| `topupUrl` | APIPod billing page | Returned with the balance. Empty string omits it |

An invalid value stops the plugin from loading, with the reason.

`approvalMode` only adds a prompt. It never overrides a denial from dsh's own
permission policy, and `never` leaves that policy fully in charge.

## Safety

- The API key is never stored in configuration, logged, or returned to the model.
- Spending calls ask the user first by default.
- A repeated submission of the same call reuses one `Idempotency-Key`, so it
  returns the first job instead of charging twice.
- The model cannot set `callback_url` or `user`, and reference media must be an
  https URL or an inline `data:` payload. The plugin reads no local files.
- Installing the package runs none of its code (no install scripts), and
  releases carry npm provenance.

Details and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## Limits

- No upload of local files; pass a public https URL or a `data:` payload.
- No speech generation tool yet. Speech models appear in the catalog only.
- The plugin does not register APIPod as a chat model provider for dsh.

## Plugin index

To list the plugin in dsh's Discover tab, enable **Custom plugin indexes** and
add this index source:

```
https://geniuspath.github.io/apipod-dsh-plugin/index.json
```

The index is generated from npm on each release by `scripts/build-index.mjs`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check:pack
```

Tests run the plugin on a real dsh tool pipeline with a stubbed `fetch`; they
make no network calls and need no API key.

To try a local checkout in dsh, build it first, then link it:

```bash
dsh plugin --profile dev add /absolute/path/to/apipod-dsh-plugin
```

## License

[Apache-2.0](LICENSE)
