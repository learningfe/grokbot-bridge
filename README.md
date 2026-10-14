# grokbot-bridge

把飞书消息交给 Grok Bot，再把 bot 要发的内容送回飞书。每个用户可以跑多个 bot。桥接很薄：收消息、按会话路由、把 bot 写好的回复发出去。它不记任务、不排跟进、不做 agent。那些在 bot 自己的记忆和 routine 里。

外面的程序没有聊天 API。bot 主人在 Grok Bot 里建一个 webhook routine，从应用里复制 URL 和 sender key。桥接对这个 URL 发 HTTP POST，载荷会作为 `<webhook_event>` 和 routine 里保存的提示词一起交给 bot。POST 返回 200 只表示「已开始」，没有结果回调。bot 和桥接在同一台 Linux 上，bot 用本机 CLI 把要发的内容交回来。

飞书是第一个通道。通道实现集中在 `src/feishu.ts`，对内只暴露 `Channel`。再加 Slack 时实现同一个接口即可，这里没有为它预留空框架。

## 一条消息怎么走

```
飞书长连接
  -> 立刻确认，再异步处理
  -> 用 event id / message id 去重（落盘）
  -> 只用 open_id + sender_type 判定 trust
  -> 按允许名单过滤
  -> 同一 scope 上一次 bot 运行没结束就排队，结束后一批送出
  -> POST 到该 scope 对应 bot 的 webhook

bot 调用本机 CLI
  -> 127.0.0.1 上的 HTTP
  -> 撤回检查、允许名单、飞书幂等 uuid
  -> 飞书发消息 / 回复 / 表情
```

scope 有三种：`dm:<open_id>`、`group:<chat_id>`、`thread:<thread_id>`（话题）。路由先看精确 scope，话题没有单独路由时用所在群的路由，再否则用默认 bot。

## 飞书应用

自建应用，打开机器人能力。事件订阅使用**长连接**，不要配请求地址。Node SDK 用 `WSClient` 收事件。长连接只支持企业自建应用；同一应用多个客户端时只有一个会收到消息，所以一个应用只跑一个桥接进程。

在「事件与回调」里订阅：

- `im.message.receive_v1` 接收消息
- `im.message.recalled_v1` 撤回消息

开通权限（名称以飞书后台为准，开下列能力即可）：

- 获取用户发给机器人的单聊消息
- 接收群聊中 @ 机器人的消息
- 获取群组中所有消息。回复不 @ 机器人、以及受信任 bot 不 @ 就发言，都依赖这条。它是敏感权限
- 获取与发送单聊、群组消息，或以应用身份发消息
- 获取消息内容（回复前确认是否已撤回，以及最近上下文）
- 添加消息表情回复
- 获取群信息（群名，失败时省略）

把机器人拉进要听的群，发布应用版本。应用凭证是 `cli_` 加 16 位十六进制的 App ID，以及 App Secret。

受信任 bot 填它的 **open_id**（`ou_`），不是 App ID（`cli_`）。在对方机器人的 `bot/v3/info` 或它发言时的 `sender.sender_id.open_id` 里看。

3 秒内不确认，飞书会重推。处理函数只做解析并把消息交出去，不在里面等待 webhook。

## 谁的消息会送进 bot

身份只来自事件里的 `open_id` 和 `sender_type`。展示名、正文、`user_id` 字段都不参与。

转发给 bot 的 `sender.trust`：

| 值             | 条件                                           |
| -------------- | ---------------------------------------------- |
| `owner`        | `sender_type=user` 且 open_id 是 `ownerOpenId` |
| `trusted_user` | 用户，且在 `allow.trustedUsers`                |
| `allowed_user` | 用户，且在 `allow.users`                       |
| `trusted_bot`  | bot，且在 `allow.trustedBots`                  |
| `unknown`      | 其他                                           |

过滤：

- 单聊：主人、trusted user、allowed user、trusted bot
- 群：`chat_id` 在 `allow.chats` 里，并且 @ 了本机器人（含 `@_all`），或回复了本机器人发出的消息，或发送者是 trusted bot
- 群里的主人也要 @ 或回复，不会因为是主人就收全部群消息
- 本机器人自己的消息丢掉

`sender.name` 只是展示。接收消息事件通常没有姓名，没有就不填。

## 会话队列和 bot 互相对话

一个 scope 同时只有一次送给 bot 的运行。这次还没 `reply` / `noreply`、也没超时之前，后来的消息留在这个 scope 里，释放后合成一次 POST。不同 scope 互不等待。超时默认 15 分钟，超时会记日志并放行队列。

bot 连续发言达到 `maxBotExchanges`（默认 5，第 6 条起）后，这个 scope 不再把 bot 消息送进去，并给主人发一条私聊说明。允许的群里只要有人说话（即使没 @、因此没送进 bot），计数就从 0 重计。通知正文不含对方的消息内容。

主动 `send` 的目标必须是主人、允许名单里的用户或 trusted bot 的 open_id，或允许名单里的 chat_id。其他目标直接拒绝，让 bot 去问主人。展示名不能当目标。

回复前会看本地撤回记录，并向飞书再确认一次。已撤回则跳过，不发第二遍。发出去的消息带 uuid，同一次发送的重试复用它。

## 配置

复制 `config.example.json`。密钥放在环境变量里，不要写进配置文件，也不要提交。

```bash
cp config.example.json ~/.config/grokbot-bridge/config.json
cp .env.example ~/.config/grokbot-bridge/env
```

改掉 open_id、chat_id 和 webhook URL。`http.tokenEnv` 可删；删了就只靠绑定在 `127.0.0.1`。绑到非本机地址时必须设置 token。

路由、允许名单、bot webhook、超时和回路上限在配置文件变更后自动重载。飞书凭证、bot open_id、HTTP 地址和端口、token、数据目录变了需要重启进程。

每个 bot：

```json
"alpha": {
  "webhookUrl": "https://...",
  "webhookKeyEnv": "GROK_ALPHA_KEY"
}
```

`webhookKeyEnv` 的值是环境变量名。变量的内容是 Grok Bot 给出的 sender key，请求时放在 `Authorization: Bearer`。

## 运行

需要 Node.js 22 或更新的版本。

```bash
npm ci
npm run build
set -a
source ~/.config/grokbot-bridge/env
set +a
node dist/cli.js serve --config ~/.config/grokbot-bridge/config.json
```

CLI 和进程读 `GROKBOT_BRIDGE_URL`（默认 `http://127.0.0.1:8787`）和 `GROKBOT_BRIDGE_TOKEN`。

```bash
grokbot-bridge reply <event_id> --text "你好"
grokbot-bridge noreply <event_id>
grokbot-bridge send --to ou_xxx --text "你好"
grokbot-bridge send --to oc_xxx --text "大家好"
grokbot-bridge react om_xxx THUMBSUP
```

`--text -` 从标准输入读正文。重试同一次发送时加上次的 `--uuid`。表情是飞书的类型名，例如 `THUMBSUP`，不是 emoji 字符。

成功时 stdout 是一行 JSON，进程退出码 0。拒绝或失败时同样是一行 JSON，退出码 1。`target_not_allowed` 表示目标不在允许名单。`skipped` 为 `recalled` 表示原消息已撤回。`late: true` 表示这条回复发出去了，但该 scope 的队列早已释放（超时或已经回复过）。

bot routine 要贴的提示词在 [docs/routine-prompt.md](docs/routine-prompt.md)。

## systemd 用户服务

`deploy/grokbot-bridge.service` 按下面的目录写。`/usr/bin/node` 换成实际的 Node。用户服务读不到 nvm 的 shell 初始化，用一个登录后也能找到的 node。

```text
~/.config/grokbot-bridge/config.json
~/.config/grokbot-bridge/env
~/.local/share/grokbot-bridge/    # 这里放构建好的程序，WorkingDirectory
```

```bash
mkdir -p ~/.config/systemd/user
cp deploy/grokbot-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now grokbot-bridge
sudo loginctl enable-linger "$USER"
```

`linger` 让服务在不登录时也保持运行。日志：`journalctl --user -u grokbot-bridge -f`。

数据在工作目录的 `data/state.json`（或配置里的 `dataDir`）：去重 id、发出的消息 id、撤回记录、回路计数、未完成的 scope 队列。进程重启后，已经 POST 成功、还在等 bot 的批次不会再 POST 一次；POST 没完成的会再送。7 天前的 id 会清掉。

## 开发

```bash
npm run typecheck
npm run lint
npm test
```

测试覆盖去重、路由、入站过滤、scope 队列、bot 回路上限、主动发送的允许名单，以及 trust 不读展示名和正文。没有接真实飞书或 Grok Bot。
