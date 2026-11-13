# dsh-live-terminal

一条**真正的**终端，同时属于你和模型，**按会话隔离**。

每个对话在右侧栏有一条独立的终端。模型用工具在里面执行命令，你在同一块屏幕上实时看到它敲了什么、出了什么，也能直接自己敲。`ssh`、`vim`、`htop`、`tmux` 以及任何密码提示都按终端原本的方式工作。

## 安装

```bash
# 从 npm（推荐，装的是构建产物）
dsh plugin --profile <你的 profile> add dsh-live-terminal

# 或直接从 GitHub
dsh plugin --profile <你的 profile> add https://github.com/seonzzy/dsh-live-terminal
```

要求 **DSH >= 0.2.1 < 0.3.0**（由 `engines.dsh` 声明；不满足的版本会在安装和启动时被拒绝）。

装完在 **右侧栏** 就能看到「实时终端」页签。默认**自动打开**：模型启动终端或往里发命令、而当前没有页签在显示时，侧栏会自动弹出。

## 为什么是「真」终端

面板里跑的是 xterm.js，主机侧用**同一个模拟器的 headless 版本**（`@xterm/headless`）维护权威屏幕。于是：

- 页面收到的是 PTY 的**原始字节**，不是被加工过的文本——光标寻址、备用屏幕、括号粘贴、鼠标上报全都原样生效；
- 模型读到的文字来自同一个模拟器的屏幕缓冲，所以「你看到的」和「模型读到的」是同一块屏幕；
- 面板晚打开或重连时，先收一份序列化的整屏，落在完全相同的画面上，而不是靠重放历史。

## 按会话隔离

Host 侧是一张以 session id 为键的表：

| 谁 | 怎么标明是哪个会话 |
| --- | --- |
| 页签 | `scope.sessionId` → 请求带 `?session=` |
| 工具 | 调用方的 agent id |

两者是同一个键，所以「模型在跑的命令」和「你在看的面板」永远是同一条 PTY。一个 host 进程最多同时保留 8 条，最久没动静的那条会被回收。

## 和 Better Sidebar 的关系

面板是 **Better Sidebar 的一个页签**，用的是它开放给所有插件的接口：

```js
ctx.inject(['betterSidebar'], (sctx) => {
  sctx.effect(() => sctx.get('betterSidebar').registerTab({
    id: 'live-terminal',
    title: () => '实时终端',
    single: true,
    component: ({ scope }) => <Pane sessionId={scope.sessionId} cwd={scope.cwd} />,
  }));
});
```

`ctx.inject` 是客户端的**可选服务**接缝：服务出现时才执行，被禁用时连同注册一起撤掉，所以两个插件的加载顺序无关紧要。Better Sidebar 不在时，会退回插件自己的侧栏入口 + 主面板，终端照样可用。

## 工具

| 工具 | 作用 |
| --- | --- |
| `live_terminal_open` | 启动当前会话的 PTY（幂等：已在运行就返回它）。 |
| `live_terminal_run` | 敲一行，等输出停下，返回**这条命令新增的**文本（默认上限 6000 字符，超出保留头尾并标注省略）。 |
| `live_terminal_send` | 原始字节，不回车、不等待——REPL、密码、方向键、`\u0003`。 |
| `live_terminal_read` | 只读屏幕，不动进程。 |
| `live_terminal_signal` | 向前台进程组发 SIGINT / SIGTERM / SIGTSTP。 |
| `live_terminal_close` | 结束当前会话的 shell。 |

`live_terminal_run` 的边界锚定在**命令回显行**上，不是行号：面板被拖动改变宽度会让缓冲区重排、行号漂移，回显行则跟着命令走。这让「返回的就是这条命令的结果」在重排、滚动、清屏之后依然成立。

## 设置

插件详情页（设置 → 插件 → dsh-live-terminal）有一个开关：

- **自动打开右侧栏**（默认开启）——模型启动终端或发命令、且没有页签在显示时，自动把页签打开。关掉就不再自动弹出，但屏幕内容保留，你手点页签时照样接得上。

开关是插件 `Config` schema 里的 `autoOpenPanel` 字段，由 DSH 自己的设置表单渲染并写回 profile patch。

## 结构

```
index.js               Host：PTY 表、权威屏幕、路由、工具
client.js              浏览器：Better Sidebar 页签 + 自绘回退
vendor/xterm.js        终端模拟器 6.0.0（MIT，见 THIRD-PARTY-NOTICES.md）
vendor/xterm.css
vendor/addon-fit.js    尺寸自适应 0.11.0
cordis.patch.yml       一条 Host 行（id: live-terminal）
locale/{en,zh}.json    插件页显示用的元数据
icon.svg               插件图标
```

## 说明

- PTY 通过已挂载的 `subprocess` 服务创建，shell、工作目录、进程树 containment 都跟随本机其余部分的同一套规则。
- 从面板点「启动」时，`scope.cwd` 会随请求带上——路由里看不到 agent 作用域，没有它 shell 会开在 host 进程的目录。
- 卸载插件会结束全部 shell 并断开所有镜像。
- 想要 SSH：直接在面板里敲 `ssh 用户@主机` 即可；它就是终端，不需要额外适配。

## License

MIT。`vendor/` 里的第三方代码许可见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
