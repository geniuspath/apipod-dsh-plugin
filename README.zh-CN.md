# APIPod for DeepSeek Harness

[English](README.md) | 简体中文

为 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)（dsh）提供图片与视频生成工具，
由 [APIPod](https://www.apipod.ai) 提供模型能力。装上这一个插件，dsh 里的 agent 就能查询 APIPod 的模型目录、
预估价格，并提交异步的图片和视频生成任务。

这是一个原生 dsh 插件：它运行在 dsh 进程内，直接调用 APIPod 的 HTTP API，不需要 APIPod 的 MCP 服务器。

## 安装

要求 dsh `>=0.2.2-rc.5 <0.3.0`。

```bash
dsh plugin --profile <profile> add @apipod/dsh-plugin
```

然后把 API Key 交给 dsh（在 [APIPod 控制台](https://www.apipod.ai/console/api-keys)创建）。
插件读取名为 `APIPOD_API_KEY` 的凭据引用，dsh 会从自己的凭据设置或环境变量中解析它：

```bash
export APIPOD_API_KEY=...
```

用该 profile 启动 dsh 即可。确认插件这一层已生效：

```bash
dsh --profile <profile> --dump-config
```

安装时 pnpm 可能提示若干 `@deepseek-ai/*` peer 依赖缺失。这些包由 dsh 安装目录提供，可以忽略。

## 工具

| 工具 | 作用 | 是否扣费 |
| --- | --- | --- |
| `apipod_list_models` | 列出图片、视频、语音模型 | 否 |
| `apipod_get_model_params` | 返回某个模型的请求参数 schema | 否 |
| `apipod_estimate_cost` | 预估一次生成的价格，并与余额比较 | 否 |
| `apipod_get_balance` | 读取账户余额（美元） | 否 |
| `apipod_generate_image` | 提交图片任务，返回 `job_id` | **是** |
| `apipod_generate_video` | 提交视频任务，返回 `job_id` | **是** |
| `apipod_check_job` | 读取任务状态、结果 URL 与最终费用 | 否 |

生成是异步的：生成工具立即返回 `job_id` 和 `kind`，agent 再轮询 `apipod_check_job`，
直到状态变为 `completed`、`failed` 或 `cancelled`。失败的任务由 APIPod 自动退款。

模型专属参数放在 `extras` 里，可用 `apipod_get_model_params` 查看有哪些。

## 配置

在 `cordis.patch.yml` 中插件所在的行下设置。patch 会整体替换该行的 `config`，所以要保留的键都需要重新写一遍。

```yaml
- id: apipod
  name: '@apipod/dsh-plugin'
  config:
    apiKeyRef: APIPOD_API_KEY
    approvalMode: generation
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyRef` | `APIPOD_API_KEY` | 保存 API Key 的凭据引用的名字。只填名字，不要填 Key 本身 |
| `approvalMode` | `generation` | `generation`：扣费工具先询问。`always`：所有工具都询问。`never`：本插件不弹询问 |
| `baseUrl` | `https://api.apipod.ai` | API 地址，必须是 https |
| `allowInsecureBaseUrl` | `false` | 允许 `http://` 的 `baseUrl`，且仅限本机回环地址 |
| `requestTimeoutMs` | `30000` | 单次 HTTP 请求的超时时间 |
| `maxExtrasKeys` | `32` | `extras` 最多接受的键数 |
| `topupUrl` | APIPod 充值页 | 随余额一起返回。设为空字符串则不返回 |

配置值不合法时插件不会加载，并给出原因。

`approvalMode` 只会增加询问，不会推翻 dsh 自身权限策略的拒绝；设为 `never` 时完全由 dsh 的策略决定。

## 安全

- API Key 不会写进配置、不会进日志，也不会返回给模型。
- 扣费调用默认先询问用户。
- 同一次调用被重复提交时使用同一个 `Idempotency-Key`，APIPod 会返回第一次的任务，不会重复扣费。
- 模型无法设置 `callback_url` 或 `user`；参考素材只能是 https URL 或内联的 `data:` 数据。插件不读取本地文件。
- 安装这个包不会执行它的任何代码（没有安装脚本），发布版本带有 npm provenance。

细节以及如何报告漏洞见 [SECURITY.md](SECURITY.md)。

## 限制

- 不支持上传本地文件，请传公开的 https URL 或 `data:` 数据。
- 暂无语音生成工具，语音模型只出现在模型目录里。
- 插件不会把 APIPod 注册为 dsh 的对话模型提供方。

## 插件索引

要在 dsh 的 Discover 页里看到本插件，先开启 **Custom plugin indexes**，再添加这个索引源：

```
https://geniuspath.github.io/apipod-dsh-plugin/index.json
```

索引在每次发布时由 `scripts/build-index.mjs` 根据 npm 上的版本生成。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check:pack
```

测试把插件跑在真实的 dsh 工具管线上，只替换了 `fetch`；不发起网络请求，也不需要 API Key。

要在 dsh 里试用本地代码，先构建，再链接：

```bash
dsh plugin --profile dev add /absolute/path/to/apipod-dsh-plugin
```

## 许可证

[Apache-2.0](LICENSE)
