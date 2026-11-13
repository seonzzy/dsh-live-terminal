# dsh-live-terminal

一条**真正的**终端，同时属于你和模型，**按会话隔离**：每个对话在自己的右侧栏里
有一条独立终端，切到别的对话就是另一条。模型用工具在里面执行，你在同一块屏幕上
实时看到它敲了什么、出了什么，也能直接自己敲。`ssh`、`vim`、`htop`、`tmux`
以及任何密码提示都按终端原本的方式工作。

## 装成右侧栏页签（Better Sidebar）

面板是 **Better Sidebar 的一个页签**，所以它天然长在当前对话的右侧栏里，跟着
会话走。用的是 Better Sidebar 自己开放给所有插件的接口，不是自绘：

```js
ctx.inject(['betterSidebar'], (sctx) => {
  sctx.effect(() => sctx.get('betterSidebar').registerTab({
    id: 'live-terminal',
    title: () => '实时终端',
    single: true,                       // 同一对话只开一个
    component: ({ scope }) => <Pane sessionId={scope.sessionId} cwd={scope.cwd} />,
  }));
});
```

- `ctx.inject` 是客户端侧的**可选服务**接缝：服务出现时才执行，服务被禁用时连同
  注册一起撤掉，所以两个插件的加载顺序无关紧要。
- 页签的 `component` 拿到 `scope`（包含 `sessionId` 和 `cwd`），这就是「跟着会话走」
  的机制：每个对话的页签各自渲染自己那条终端。
- Better Sidebar 不在时，会自动退回插件自己的侧栏入口 + 主面板，终端照样可用。

## 为什么是真正的终端

面板里跑的是 xterm.js（vendored 在 `vendor/`），主机侧用**同一个模拟器的 headless
版本**（`@xterm/headless`）维护权威屏幕。于是：

- 页面收到的是 PTY 的**原始字节**，不是被加工过的文本——光标寻址、备用屏幕、
  括号粘贴、鼠标上报全都原样生效；
- 模型读到的文字来自同一个模拟器的屏幕缓冲，所以「你看到的」和「模型读到的」
  是同一块屏幕；
- 面板晚打开或重连时，先收一份序列化的整屏（`SerializeAddon`），落在完全相同的
  画面上，而不是靠重放历史。

`@xterm/headless` 从 Harness 安装目录里解析（它随 `app.asar` 一起发布）。万一
解析不到，插件降级为纯文本模式并在日志里说明——不会因此加载失败。

## 按会话隔离

Host 侧是一个以 session id 为键的表：

| 谁 | 怎么标明是哪个会话 |
| --- | --- |
| 页签 | `scope.sessionId` → 请求带 `?session=` |
| 工具 | 调用方的 agent id |

两者是同一个键，所以「模型在跑的命令」和「你在看的面板」永远是同一条 PTY。
一个 host 进程最多同时保留 8 条，最久没动静的那条会被回收。

## 注册了什么

Host（`index.js`）：

| 表面 | 作用 |
| --- | --- |
| `live_terminal_open` | 启动当前会话的 PTY（幂等：已在运行就返回它）。 |
| `live_terminal_run` | 敲一行，等输出停下，返回这条命令新增的行。 |
| `live_terminal_send` | 原始字节，不回车、不等待——REPL、密码、方向键、`\u0003`。 |
| `live_terminal_read` | 只读屏幕，不动进程。 |
| `live_terminal_signal` | 向前台进程组发 SIGINT / SIGTERM / SIGTSTP。 |
| `live_terminal_close` | 结束当前会话的 shell。 |
| `GET/POST /live-terminal?session=` | 页签用的状态与操作。 |
| `GET /live-terminal/stream?session=` | 原始输出流（先一整屏序列化，之后是原始字节）。 |
| `GET /live-terminal/vendor/*` | 页签用的 xterm.js / xterm.css / addon-fit.js。 |

Client（`client.js`）：注册 `live-terminal` 页签到 Better Sidebar，并保留一套
自绘回退；页签内有真正的 xterm 画布、状态行（shell / 目录 / 镜像连接）、
启动·Ctrl-C·清屏·关闭。

## 结构

```
index.js            Host：PTY 表、权威屏幕、路由、工具
client.js           浏览器：Better Sidebar 页签 + 自绘回退
vendor/xterm.js     终端模拟器（6.0.0）
vendor/xterm.css
vendor/addon-fit.js 尺寸自适应（0.11.0）
cordis.patch.yml    一条 Host 行（id: live-terminal）
locale/{en,zh}.json 插件页显示用的元数据
icon.svg            插件图标
```

## 说明

- PTY 通过已挂载的 `subprocess` 服务创建，shell、工作目录、进程树 containment
  都跟随本机其余部分的同一套规则。
- 从面板点「启动」时，`scope.cwd` 会随请求带上——路由里看不到 agent 作用域，
  没有它 shell 会开在 host 进程的目录，而不是对话的工作目录。
- 卸载插件会结束全部 shell 并断开所有镜像。
- 想要 SSH：直接在面板里敲 `ssh 用户@主机` 即可；它就是终端，不需要额外适配。
