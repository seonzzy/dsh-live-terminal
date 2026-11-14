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

## 面板挂在哪

面板是 **DSH 自带右侧栏的一个页签**，只注册一次：

```js
ctx.sidebarRightTabs.register({ id, kind, title, guide: [...] })   // 声明类型
ctx.slots.register({ name: 'sidebar.right.pane.tab',       key: id }, Body)
ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: id }, Title)
```

三件缺一不可：类型没人分发就渲染不出来，内容槽没有类型就永远不会被打开。

**不依赖 Better Sidebar。** 这条通路由宿主自己提供，所以装、不装、中途卸载 Better Sidebar，入口都是同一个、永远在、只出现一次。此前两套都注册会让同一块面板在侧栏里出现两次，那是要避免的。

自动打开用 `sidebarRight.openTabIn(sessionId, kind, ...)` 而不是 `openTab(kind)`：后者取「当前挂到栏上的会话」，而侧栏关着时没人挂上去，调用会静默失效——偏偏那正是最需要它生效的场景。

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
client.js              浏览器：DSH 右侧栏页签 + 终端画布
vendor/xterm.js        终端模拟器 6.0.0（MIT，见 THIRD-PARTY-NOTICES.md）
vendor/xterm.css
vendor/addon-fit.js    尺寸自适应 0.11.0
vendor/addon-webgl.js  WebGL 渲染器 0.19.0（无 WebGL 或 CSS zoom 下回落 DOM 渲染）
cordis.patch.yml       一条 Host 行（id: live-terminal）
locale/{en,zh}.json    插件页显示用的元数据
icon.svg               插件图标
```

## 说明

- PTY 通过已挂载的 `subprocess` 服务创建，shell、工作目录、进程树 containment 都跟随本机其余部分的同一套规则。
- 从面板点「启动」时，工作目录随请求带上——路由里看不到 agent 作用域，没有它 shell 会开在 host 进程的目录。
- 卸载插件会结束全部 shell 并断开所有镜像。
- 想要 SSH：直接在面板里敲 `ssh 用户@主机` 即可；它就是终端，不需要额外适配。
- 拖宽面板会触发重排：客户端对尺寸变化去抖、Host 端把一次拖动合并成一次 PTY 几何变更，结果切分又锚定在命令回显行上，所以重排不会污染 `live_terminal_run` 的返回值。
- 「清屏」按钮发的是 shell 自己的清屏命令（PowerShell 用 `Clear-Host`，cmd 用 `cls`，POSIX 用 `clear`），再抹掉面板本地的 scrollback——本地画面和 Host 的权威屏幕因此始终一致。vim / htop 这类全屏程序占着屏幕时什么都不输入，只把两侧一起擦干净。不用 Ctrl-L：它在 Windows PowerShell 里不是清屏键，会被当成普通字符插进输入行。

## License

MIT。`vendor/` 里的第三方代码许可见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
