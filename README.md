# hotBrief

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://docs.docker.com/)

A self-hosted news aggregator that delivers a daily LLM-powered digest and
real-time major-event alerts to your WeChat via [ServerChan](https://sct.ftqq.com).
Pulls from two providers and unifies them into one ranked, deduplicated feed:

- **[imsyy/DailyHotApi](https://github.com/imsyy/DailyHotApi)** — 30+ Chinese
  platforms (Hacker News, V2EX, Zhihu, Weibo, Bilibili, GitHub Trending,
  IT之家, …).
- **[DIYgod/RSSHub](https://github.com/DIYgod/RSSHub)** — thousands of foreign
  routes (Reddit, Lobsters, Mastodon, Hacker News raw, Substack, Twitter via
  Nitter, YouTube channels, …). Configure feeds in `config.yml`.

## Why

- **One inbox for trending content.** Pull hot lists from many platforms in one place.
- **Read inside WeChat.** Each digest item ships with a 300-500 character
  Chinese summary so you don't need to leave the chat.
- **Surface what matters.** When the same story trends on N+ platforms simultaneously,
  hotBrief detects "resonance" and pushes the full article on the spot.
- **Self-hosted, push-only.** No public domain, no ICP filing, no inbound ports.
- **Configurable.** Per-source `top_n`, category, weight; keyword black/whitelist;
  pluggable LLM provider (DeepSeek, Kimi, Qwen, OpenAI, …).

## Architecture

```
┌──────────────────────────── your server ────────────────────────────┐
│                                                                      │
│  ┌────────────────────┐                                              │
│  │   DailyHotApi      │  loopback :6688                              │
│  │   (upstream image) │                                              │
│  └─────────┬──────────┘                                              │
│            │ HTTP                                                    │
│            ▼                                                         │
│  ┌─────────────────────────────────────────────┐                    │
│  │  aggregator (this project, Node.js)          │                    │
│  │   • cron fetch every N minutes               │                    │
│  │   • keyword black/whitelist                  │                    │
│  │   • SQLite dedup window                      │                    │
│  │   • cross-platform resonance detection       │                    │
│  │   • two push lanes:                          │                    │
│  │       digest    (3×/day, LLM summaries)      │                    │
│  │       fulltext  (event-driven, jina reader)  │                    │
│  └────┬─────────────────┬─────────────────┬─────┘                    │
└───────┼─────────────────┼─────────────────┼──────────────────────────┘
        ▼                 ▼                 ▼
   LLM API          r.jina.ai          ServerChan SCT
                                              │
                                              ▼
                                          WeChat → iPhone
```

## Quick Start

```bash
git clone https://github.com/<you>/hotBrief.git
cd hotBrief
make setup            # copies .env.example -> .env, config.example.yml -> config.yml
$EDITOR .env          # fill in SERVERCHAN_SCT_KEY, LLM_API_KEY, LLM_BASE_URL
$EDITOR config.yml    # tune sources, schedule, keywords
make start            # docker compose up -d
make logs             # tail aggregator output
make test             # send a one-shot digest push
```

## Configuration

| File                  | Role                                    | Tracked in git |
| --------------------- | --------------------------------------- | :------------: |
| `.env`                | secrets (SCT key, LLM API key)          |       no       |
| `config.yml`          | sources, schedule, keywords, LLM model  |       no       |
| `.env.example`        | committed template, copy on first run   |      yes       |
| `config.example.yml`  | committed template with full reference  |      yes       |

See `config.example.yml` for the full reference; comments inline.

### Choosing an LLM

`LLM_BASE_URL` and `LLM_API_KEY` use the OpenAI-compatible HTTP protocol, so
you can plug in any compatible provider without code changes:

| Provider | Base URL                                                        | Notes              |
| -------- | --------------------------------------------------------------- | ------------------ |
| DeepSeek | `https://api.deepseek.com`                                      | recommended (cheap, good Chinese) |
| Kimi     | `https://api.moonshot.cn/v1`                                    | longer context     |
| Qwen     | `https://dashscope.aliyuncs.com/compatible-mode/v1`             | Alibaba-hosted     |
| OpenAI   | `https://api.openai.com/v1`                                     |                    |

For Anthropic Claude, use the official anthropic SDK (out of scope here).

## Development

```bash
cd aggregator
npm install
# Run locally (requires DailyHotApi reachable):
DAILYHOTAPI_URL=http://localhost:6688 \
CONFIG_PATH=../config.yml \
DATA_DIR=../data \
node --env-file=../.env src/index.js
```

Source layout:

```
aggregator/src/
  index.js       entrypoint, cron scheduler
  config.js      load + merge config.yml + env
  db.js          SQLite schema + helpers
  fetch.js       call DailyHotApi for enabled sources
  filter.js      keyword black/whitelist
  dedup.js       per-item / per-cluster cooldown
  major.js       cross-platform resonance clustering
  summarize.js   LLM-powered Chinese summaries
  fulltext.js    fetch article body via r.jina.ai
  push.js        render Markdown + send via ServerChan
```

## Roadmap

- **Stage 1.0** *(shipped)* — ServerChan WeChat push, two-lane digest/fulltext
- **Stage 1.5** — PWA browse UI behind a Cloudflare Tunnel; read/star state
- **Stage 2** — Native iOS App (SwiftUI) reusing the same backend API
- **Stage 3** *(shipped)* — RSSHub adapter for foreign feeds (Reddit, Lobsters,
  Mastodon, Substack, …). Configure in `rsshub:` block of `config.yml`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and small focused PRs welcome.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and third-party attributions in [NOTICE](NOTICE).

---

# hotBrief（中文）

> 自托管的个人新闻聚合服务。基于 [DailyHotApi](https://github.com/imsyy/DailyHotApi) 拉取
> 30+ 平台热榜，经 LLM 生成中文深度摘要，通过 [Server酱](https://sct.ftqq.com)
> 推送到微信。支持一日三报和重大事件实时全文推送。

## 为什么用它

- **一处汇总热榜**：知乎、微博、HN、V2EX、B站、GitHub Trending 等 30+ 来源
- **微信里直接读**：每条带 300-500 字深度摘要，不必跳出原站
- **重大事件即推**：跨平台共振检测命中阈值，立刻推全文
- **自托管 / 免备案**：纯推送架构，国内服务器即可，不需要域名
- **高度可配**：每源 Top N、分组、权重、关键词黑白名单、LLM 提供商均可调

## 架构图

见上文 English 段的 Architecture 图。

## 快速开始

```bash
git clone https://github.com/<你>/hotBrief.git
cd hotBrief
make setup            # 自动复制 .env.example、config.example.yml
$EDITOR .env          # 填入 SERVERCHAN_SCT_KEY、LLM_API_KEY、LLM_BASE_URL
$EDITOR config.yml    # 按需调整源、时间表、关键词
make start            # 启动
make logs             # 看日志
make test             # 立刻发一条测试日报
```

## 配置说明

- `.env`：密钥，git 忽略
- `config.yml`：行为参数（源、时间、关键词、LLM 模型），git 忽略
- 仓库里只保留 `.env.example` 和 `config.example.yml` 两份模板

详细字段说明见 `config.example.yml` 内联注释。

## LLM 选择建议

默认推荐 **DeepSeek**（输入约 ¥1/M tokens，输出约 ¥2/M tokens；按一日三报每报 15 条估算 ~¥1.5/月）。
DeepSeek、Kimi、Qwen、OpenAI 都遵循 OpenAI 协议，换 provider 只需改 `.env` 里的
`LLM_API_KEY` 和 `LLM_BASE_URL`，再在 `config.yml` 改 `model` 名即可。

## 路线图

- **阶段 1.0**（当前版本）：Server酱 微信推送
- **阶段 1.5**：加 PWA 浏览界面（Cloudflare Tunnel + 已读/收藏状态）
- **阶段 2**：SwiftUI 原生 iOS App，复用同一套后端
- **阶段 3**：接入 Reddit、HN、Twitter 等境外源（境外中继代理）

## License

Apache License 2.0 — 详见 [LICENSE](LICENSE)，第三方组件归属见 [NOTICE](NOTICE)。
