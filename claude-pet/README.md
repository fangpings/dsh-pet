# claude-pet

用 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的桌面宠物显示 Claude Code 的状态，不需要 DeepSeek Harness。

- 原作者：<https://github.com/PC2005-cloud/dsh-pet>
- 代码：MIT。素材（动画、提示词、源视频）：允许开源使用，**禁止商用**。

## 原理

- Claude Code hooks 把每个会话的状态写到 `~/.cache/claude-agent-status/`。hooks 和写状态的脚本在 dotfiles 仓库的 `zellij/scripts/agent-status.sh` 里。
- `server.mjs` 模拟 DSH 宿主，提供 `/config`、`/work-status` 和动画素材，然后拉起 dsh-pet 自带的 Electron 小窗。
- 多个 Claude 合并成一个状态：

| 条件 | 动画 |
|---|---|
| 有 Claude 在等你批准或回答 | `工作状态-原地踱步张望`（循环） |
| 有 Claude 在跑 | `工作状态-忙碌点按`（循环） |
| 有 Claude 做完了 | `工作状态-雀跃庆祝`（播一遍） |
| 都空闲 | 普通待机和随机动作 |

不弹气泡。具体是哪个 Claude，看 zellij 底栏。

## 安装

```sh
cd dsh-pet
npm install --legacy-peer-deps --ignore-scripts   # 不装 DSH 的 peer 依赖
node scripts/build-desktop-core.mjs               # 生成 runtime/electron-helper/shared-core.js
npm run ensure:electron                           # 下载 Electron 到 ~/.dsh/electron/
```

## 使用

```sh
claude-pet/claude-pet start     # 后台启动；也可以 stop / restart / status / log
PET_SIZE=160 claude-pet/claude-pet restart   # 调大小（宽度 px，默认 200）
```

日志在 `~/.local/state/claude-pet/log`。关掉小窗，服务也会退出。
