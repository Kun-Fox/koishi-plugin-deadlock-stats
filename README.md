# koishi-plugin-deadlock-stats

Deadlock（死锁）战绩查询插件。支持绑定玩家、查看玩家资料、近期战绩、指定对局和最近一局。

数据来自社区公开 API [deadlock-api.com](https://api.deadlock-api.com)，不需要 API Key。该站点不是 Valve 官方服务，接口或数据格式可能变化。

## 功能

- 绑定 / 解绑 Deadlock 玩家
- 按玩家名搜索，处理重名
- 玩家资料：段位、近期胜率、KDA、常用英雄
- 近期战绩列表，可指定条数
- 指定 `match_id` 的完整对局；12 名玩家、双方队伍、KDA、净值、补刀、等级
- 最近一局
- 请求超时、429/5xx 重试、对局历史 30 秒缓存、可选用户冷却
- 绑定关系按平台 + 用户 ID 持久化到 JSON，不依赖数据库

## 安装

### 从本地 tgz 安装

```bash
cd <你的 Koishi 实例目录>
npm install ./koishi-plugin-deadlock-stats-0.1.0.tgz
```

Yarn 4 实例：

```bash
corepack yarn add "koishi-plugin-deadlock-stats@file:./koishi-plugin-deadlock-stats-0.1.0.tgz"
```

安装后在 Koishi 控制台启用 `deadlock-stats`。

### 从源码运行

```bash
cd koishi-plugin-deadlock-stats
npm install
npm test
```

## 命令

默认指令前缀以你的 Koishi 配置为准，下面省略前缀。

| 命令 | 说明 |
| --- | --- |
| `deadlock.bind <玩家名>` | 搜索并绑定玩家；只有一个精确匹配时直接绑定，多个候选时列出候选 |
| `deadlock.bindid <account_id>` | 已知 32 位 Steam account_id 时直接绑定 |
| `deadlock.unbind` | 解除绑定 |
| `deadlock.whoami` | 查看当前绑定 |
| `deadlock.profile [玩家名]` | 玩家资料 + 近 20 局汇总；不填则用绑定玩家 |
| `deadlock.recent [局数]` | 近期战绩，默认 5，最大 20 |
| `deadlock.match <match_id>` | 指定对局详情 |
| `deadlock.last` | 最近一局详情 |
| `deadlock.search <玩家名>` | 只搜索玩家，不绑定 |

`deadlock` 的别名是 `dl`，例如 `dl.recent 3`。

### 示例

```text
deadlock.bind Shroud
deadlock.profile
deadlock.recent 5
deadlock.match 131620367
deadlock.last
```

输出示例：

```text
玩家：Shroud（account_id 950062689）
Steam：https://steamcommunity.com/profiles/76561198910328417/
段位：近卫 II
近 20 局：8 胜 12 负 · 胜率 40.0% · KDA 3.87
常用英雄：门侍 ×7、鼠王 ×3、空骨丹尼 ×2
最近一局：11/05 16:47 · 鼠王 · 胜 · 10/3/22 · #131620367
```

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiBase` | `https://api.deadlock-api.com` | API 地址；可换成自建反代 |
| `language` | `schinese` | 英雄/段位资产语言 |
| `timeout` | `12000` | 单次请求超时（毫秒） |
| `retries` | `2` | 429 / 5xx / 网络错误重试次数 |
| `recentLimit` | `5` | `deadlock.recent` 默认局数 |
| `maxRecent` | `20` | `deadlock.recent` 允许的最大局数 |
| `cooldown` | `0` | 同一用户命令冷却（毫秒），0 为关闭 |
| `bindingsFile` | `data/deadlock-stats/bindings.json` | 绑定文件；相对路径基于 Koishi 根目录 |

## 数据源与接口

插件使用以下公开接口：

```text
GET /v1/players/steam-search?search_query=<name>&limit=25&min_matches_played_last_30d=0
GET /v1/players/steam?account_ids=<id>&account_ids=<id>
GET /v1/players/{account_id}/match-history
GET /v1/players/{account_id}/rank
GET /v1/matches/{match_id}/metadata
GET /v1/assets/heroes?language=schinese
GET /v1/assets/ranks?language=schinese
```

- `match-history` 返回 `player_match_outcome`：1 胜、2 负、3/4 惩罚、5 未计分。
- `matches/{id}/metadata` 的 `match_info.players` 包含 12 名玩家的英雄、队伍、KDA、净值、补刀、等级。
- 英雄和段位名称来自 assets 接口；插件会缓存本次进程内的映射。

如果你的网络无法直连 `api.deadlock-api.com`，把 `apiBase` 改成可访问的反向代理地址。

## 缓存、重试与限流

- `getMatchHistory` 在进程内缓存 30 秒，避免连续命令重复请求。
- `request` 对 429、5xx 和网络错误按 `retries` 重试，并遵守 `Retry-After`（如果响应提供）。
- 单次请求受 `timeout` 限制。
- `cooldown > 0` 时，同一平台 + 用户在该时间内只能触发一次命令。

## 权限与隐私

- 绑定键是 `platform:userId`，绑定文件只保存 `accountId` 和 `personaName`，不保存聊天内容。
- 插件没有管理员命令；任何用户都可以绑定自己的账号。
- 对局详情会展示同场其他玩家的昵称，这是公开 API 返回的数据。

## 限制

- 只支持 Deadlock 的 Steam 玩家；不支持主机账号。
- 玩家名搜索可能返回多个候选，必须用 `bindid` 或更精确的名字。
- 段位接口可能对无段位玩家返回空，显示为“未定级”。
- 对局详情较长，QQ 等平台可能触发消息长度限制；必要时先看 `deadlock.recent` 再用 `deadlock.match`。
- 依赖第三方社区 API，若站点变更或限流，插件会返回错误提示，不会伪造数据。
- 目前只输出文本，不含英雄头像/战绩图片。

## 测试

```bash
npm test
```

测试会访问真实 API，使用 `Shroud` 和 match `131620367` 作为样本；可通过环境变量覆盖玩家：

```bash
DEADLOCK_TEST_PLAYER=Shroud npm test
```

测试覆盖：

- `BindingStore` 读写/删除
- 玩家搜索、资料、近期战绩、对局详情
- 中文格式化
- 插件命令的 mock Koishi 上下文调用

## 与参考插件的差异

- 不依赖数据库或图片渲染，安装即用。
- 先做查询与绑定，不做战绩图片；后续可以加 renderer。
- 数据源选用可直接返回 JSON 的社区 API，而不是抓取网页。

## License

MIT
