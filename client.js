/**
 * Browser half of `dsh-live-terminal`.
 *
 * The panel is a real terminal rendered as a **Better Sidebar tab**, so it lives
 * in the right sidebar of the conversation it belongs to and follows that
 * conversation when the user switches. It loads the vendored xterm.js, receives
 * the PTY's raw bytes and sends every keystroke back unmodified — which is what
 * makes `ssh`, `vim`, `htop` and `tmux` behave the way they do in a terminal
 * application.
 *
 * Host and page run the same emulator (`@xterm/headless` on the host side), so
 * the screen the model reads is the screen you see.
 *
 * Better Sidebar is NOT involved. The panel is a tab of DSH's own right sidebar
 * (`sidebarRightTabs` + `sidebar.right.pane.tab`), so one registration serves
 * every profile: installed alongside Better Sidebar or without it, the entry is
 * the same one and appears exactly once.
 */
window.__ModuleLoader__.load({
  id: 'dsh-live-terminal',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'liveTerminal';
    /** Tab type registered with DSH's own right sidebar. */
    const DSH_TAB_ID = 'dsh-live-terminal';
    const DSH_TAB_KIND = 'dsh-live-terminal';
    /** Package name, and the Loader-row id the settings page keys this plugin by. */
    const PLUGIN_PACKAGE = 'dsh-live-terminal';
    /* The settings namespace is the Loader ROW's own id — `entry.options.id` in
     * `settings.describe()` — which for this row is `live-terminal`. It is NOT
     * the manager's entry id (`include:live-terminal`): that one names the
     * include wrapper in the plugin list, and asking the form controller for it
     * yields no namespace at all. */
    const ROW_ID = 'live-terminal';
    /** Host routes registered by the Host half. */
    const CONTROL = '/live-terminal';
    const STREAM = '/live-terminal/stream';
    const VENDOR = '/live-terminal/vendor';
    const SIGNAL = '/live-terminal/signal';

    const zh = {
      panel: '实时终端',
      title: '实时终端',
      intro: '这是一条真正的终端：模型用工具在里头执行，你在同一块屏幕上看着它敲、它出，也能自己直接敲——ssh、vim、tmux 都照常工作。',
      tabDesc: '模型和你在同一条真实终端里操作，ssh / vim / tmux 都照常',
      state: '状态',
      stateIdle: '未启动',
      stateRunning: '运行中',
      stateExited: '已退出',
      stateFailed: '已失败',
      shell: 'shell',
      cwd: '目录',
      pid: '进程',
      streaming: '镜像',
      connected: '已连接',
      disconnected: '断线重连中',
      start: '启动',
      restart: '重新启动',
      stop: '关闭',
      clear: '清屏',
      focus: '专注模式',
      exitFocus: '退出专注',
      inputHint: '点一下屏幕即可直接输入；也可以让模型执行。',
      empty: '正在启动终端…',
      noHost: 'Host 半侧没响应：插件可能只装了一半，或路由被占用。',
      noXterm: '没能加载终端模拟器（vendor/xterm.js）：插件可能没装全。',
      lastNote: '模型动作',
      notRunning: '终端没在运行。',
      detailTitle: '实时终端',
      detailBody: '每个对话在右侧栏有一条独立终端；模型用 live_terminal_* 工具在里面执行，你在同一块屏幕上看着它敲、它出，也能直接自己敲。',
      autoOpenLabel: '自动打开右侧栏',
      autoOpenHint: '模型启动终端且当前没有页签在显示它时，自动把这个页签打开。',
      autoOpenUnavailable: 'Host 没有把这个插件的设置表单交给界面，开关暂时写不进去。',
      autoOpenRejected: 'Host 拒绝了这次写入，开关已复位。',
      detailPerSession: 'ssh / vim / htop / tmux 以及密码提示都按终端原本的方式工作。',
    };

    const en = {
      panel: 'Live terminal',
      title: 'Live terminal',
      intro: 'A real terminal: the model drives it through tools, you watch the same screen and can type into it — ssh, vim and tmux behave normally.',
      tabDesc: 'One real terminal shared with the model; ssh, vim and tmux work',
      state: 'State',
      stateIdle: 'Not started',
      stateRunning: 'Running',
      stateExited: 'Exited',
      stateFailed: 'Failed',
      shell: 'shell',
      cwd: 'cwd',
      pid: 'pid',
      streaming: 'Mirror',
      connected: 'connected',
      disconnected: 'reconnecting',
      start: 'Start',
      restart: 'Restart',
      stop: 'Close',
      clear: 'Clear',
      focus: 'Focus',
      exitFocus: 'Exit focus',
      inputHint: 'Click the screen and type; the model can run commands too.',
      empty: 'Starting the terminal…',
      noHost: 'The Host half did not answer: the plugin may be half-installed or its routes are taken.',
      noXterm: 'The terminal emulator (vendor/xterm.js) did not load: the plugin may be incomplete.',
      lastNote: 'Model action',
      notRunning: 'The terminal is not running.',
      detailTitle: 'Live terminal',
      detailBody: 'One terminal per conversation in the right sidebar; the model drives it with the live_terminal_* tools, you watch the same screen and can type into it yourself.',
      autoOpenLabel: 'Open the right sidebar automatically',
      autoOpenHint: 'When the model starts a terminal and no tab is showing it, open this tab.',
      autoOpenUnavailable: 'The Host does not serve this plugin’s settings form to the UI, so the switch cannot be written here.',
      autoOpenRejected: 'The Host refused the write; the switch has been put back.',
      detailPerSession: 'ssh / vim / htop / tmux and password prompts all behave like a real terminal.',
    };

    /**
     * Styles use only `--dsw-alias-*` theme tokens so light and dark both hold.
     * The terminal itself is themed through xterm's own `theme` option.
     */
    const CSS = `
.lvt-root{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;padding:8px 10px 10px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font:inherit}
.lvt-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.lvt-pill{display:inline-flex;align-items:center;gap:5px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.lvt-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.lvt-dot[data-state="running"]{background:var(--dsw-alias-state-success-primary)}
.lvt-dot[data-state="exited"]{background:var(--dsw-alias-state-warn-primary)}
.lvt-dot[data-state="failed"]{background:var(--dsw-alias-state-error-primary)}
.lvt-meta{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:26ch}
.lvt-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;line-height:1;padding:4px 8px;border-radius:5px;cursor:pointer}
.lvt-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.lvt-btn:disabled{opacity:.5;cursor:default}
.lvt-btn[data-tone="primary"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.lvt-btn[data-tone="danger"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
/* Every layer in the stack carries the SAME concrete colour the emulator paints
 * with. The theme token cannot be used here: the bg-base alias resolves to
 * nothing inside this shadowed slot, so var(...) fell back to a translucent
 * value while xterm itself painted an opaque one — which is exactly the seam
 * that showed as a darker band under the transcript. The --lvt-bg variable is
 * set from the emulator's own theme at mount, so the two cannot drift apart. */
.lvt-screen{flex:1 1 auto;min-height:160px;position:relative;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--lvt-bg,#1b1b1f);overflow:hidden}
.lvt-screen .lvt-term,.lvt-screen .xterm,.lvt-screen .xterm-screen,.lvt-screen .xterm-viewport{background:var(--lvt-bg,#1b1b1f)}
/* Focus mode lifts the terminal out of the narrow column. Fixed positioning keeps
 * the surrounding layout untouched. The inset is small on purpose: the point of
 * this mode is to use the room, so a wide margin would waste the columns it was
 * opened for. */
.lvt-screen.lvt-focus{position:fixed;inset:12px;z-index:2147483000;min-height:0;border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.55)}
.lvt-screen.lvt-focus::before{content:'';position:fixed;inset:0;z-index:-1;background:rgba(0,0,0,.45)}
/* In flow, not absolutely positioned: FitAddon sizes itself from the parent's
 * computed width/height, and an absolutely positioned box without an explicit
 * size reports the wrong one before layout settles — the symptom is a grid that
 * fills only the top strip of the pane and leaves the rest empty. A flex child
 * with min-height:0 tracks the column exactly, at any pane size. */
.lvt-term{position:relative;flex:1 1 auto;min-height:0;margin:6px 8px;box-sizing:border-box;overflow:hidden}
.lvt-screen.lvt-focus .lvt-term{margin:8px}
.lvt-term .xterm{height:100%}
.lvt-term .xterm-viewport{overflow-y:auto !important}
.lvt-term canvas{background:var(--lvt-bg,#1b1b1f)}
.lvt-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:18px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary);pointer-events:none}
.lvt-note{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 0 auto}
.lvt-error{font-size:11.5px;color:var(--dsw-alias-state-error-primary);flex:0 0 auto}
.lvt-detail{display:flex;flex-direction:column;gap:8px;margin-top:6px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.lvt-detail-title{margin:0;font-size:14px;font-weight:600}
.lvt-detail-body{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.lvt-detail-list{margin:0;padding-left:18px;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.lvt-detail-switch{display:flex;align-items:center;gap:10px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.lvt-detail-switch-text{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.lvt-detail-switch-text strong{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.lvt-toggle{appearance:none;flex:none;width:38px;height:22px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;transition:background .15s ease}
.lvt-toggle[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.lvt-toggle:disabled{opacity:.5;cursor:default}
.lvt-toggle-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease}
.lvt-toggle[data-on="true"] .lvt-toggle-knob{transform:translateX(16px)}
`;

    /** POST one control action for one conversation. */
    async function control(sessionId, body) {
      const response = await fetch(`${CONTROL}?session=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, session: sessionId }),
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text === '' ? {} : JSON.parse(text);
      } catch {
        payload = { error: text.slice(0, 400) };
      }
      if (!response.ok || payload.error !== undefined) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      return payload;
    }

    /** Load a classic script once; resolves after it has executed. */
    const scriptCache = new Map();
    function loadScript(src) {
      const cached = scriptCache.get(src);
      if (cached !== undefined) return cached;
      const pending = new Promise((resolve, reject) => {
        const element = document.createElement('script');
        element.src = src;
        element.async = false;
        element.onload = () => resolve();
        element.onerror = () => reject(new Error(`failed to load ${src}`));
        document.head.appendChild(element);
      });
      scriptCache.set(src, pending);
      return pending;
    }

    /** Load the emulator stylesheet once. */
    let stylesheetOnce;
    function loadStylesheet() {
      if (stylesheetOnce !== undefined) return stylesheetOnce;
      stylesheetOnce = new Promise((resolve) => {
        if (document.querySelector(`link[data-lvt="xterm"]`) !== null) {
          resolve();
          return;
        }
        const element = document.createElement('link');
        element.rel = 'stylesheet';
        element.href = `${VENDOR}/xterm.css`;
        element.setAttribute('data-lvt', 'xterm');
        element.onload = () => resolve();
        element.onerror = () => resolve();
        document.head.appendChild(element);
      });
      return stylesheetOnce;
    }

    /** A terminal glyph, used by the tab strip and the fallback sidebar entry. */
    function TerminalIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('rect', { x: 1.6, y: 2.6, width: 12.8, height: 10.8, rx: 2 }),
        h('path', { d: 'M1.6 5.6h12.8' }),
        h('path', { d: 'M4.4 8.1l1.9 1.5-1.9 1.5' }),
        h('path', { d: 'M8.4 11.1h3.1' }),
      );
    }

    /** Read a theme token, falling back to a literal so a missing token cannot blank the screen. */
    function token(name, fallback) {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value === '' ? fallback : value;
    }

    /** Build the xterm theme from the app's own tokens. */
    function theme() {
      return {
        background: token('--dsw-alias-bg-base', '#1b1b1f'),
        foreground: token('--dsw-alias-label-primary', '#e6e6e6'),
        cursor: token('--dsw-alias-brand-primary', '#4d9fff'),
        cursorAccent: token('--dsw-alias-bg-base', '#1b1b1f'),
        selectionBackground: token('--dsw-alias-bg-layer-2', '#33333a'),
        black: '#1b1b1f',
        red: token('--dsw-alias-state-error-primary', '#ff6b6b'),
        green: token('--dsw-alias-state-success-primary', '#5ad469'),
        yellow: token('--dsw-alias-state-warn-primary', '#e5c07b'),
        blue: token('--dsw-alias-brand-primary', '#4d9fff'),
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: token('--dsw-alias-label-primary', '#e6e6e6'),
      };
    }

    /**
     * The terminal view, shared by the Better Sidebar tab and the fallback panel.
     * @param props - `t` bound to this plugin's namespace, the conversation id,
     *   and that conversation's working directory when the host knows it.
     */
    function TerminalPane({ t, sessionId, cwd }) {
      const [snapshot, setSnapshot] = React.useState({ state: 'idle', pid: null, cwd: null });
      const [connected, setConnected] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);
      const [hasOutput, setHasOutput] = React.useState(false);
      const [missing, setMissing] = React.useState(false);
      const [geometry, setGeometry] = React.useState(null);
      /** Widen the terminal past the sidebar, for output the column is too narrow to read. */
      const [focused, setFocused] = React.useState(false);
      /** Re-fits the emulator; set by the mount effect once the instance exists. */
      const fitRef = React.useRef(null);
      /** True while the overlay is open, so its size change is not sent to the PTY. */
      const focusRef = React.useRef(false);
      focusRef.current = focused;
      /** Suppresses the next resize report, which belongs to a focus toggle. */
      const skipResizeRef = React.useRef(false);
      const host = React.useRef(null);
      const term = React.useRef(null);
      const stateRef = React.useRef('idle');
      stateRef.current = snapshot.state;
      /** Frames that arrived before the emulator finished loading.
       *
       * xterm is a classic script loaded from the plugin's own route, so the
       * stream is already open when it finishes. Without this queue the first
       * `screen` frame — the entire current screen — would be dropped and the
       * panel would stay blank. */
      const pending = React.useRef([]);

      /* Mount the emulator once per conversation. Re-keying the component on a
       * session switch unmounts it, which drops this state with it. */
      React.useEffect(() => {
        let disposed = false;
        let resizeObserver;
        let resizeSend;
        /** Detaches the pointer correction; set by the mount effect. */
        let detachPointer;
        let detachData;
        void (async () => {
          try {
            await loadStylesheet();
            await loadScript(`${VENDOR}/xterm.js`);
            await loadScript(`${VENDOR}/addon-fit.js`);
          } catch (failure) {
            if (!disposed) {
              setMissing(true);
              setError(failure instanceof Error ? failure.message : String(failure));
            }
            return;
          }
          if (disposed || host.current === null) return;
          const TerminalCtor = window.Terminal;
          if (typeof TerminalCtor !== 'function') {
            setMissing(true);
            return;
          }
          const instance = new TerminalCtor({
            cols: 100,
            rows: 24,
            scrollback: 5000,
            cursorBlink: true,
            /* Consolas resolves everywhere on Windows and is真 monospace; the
             * generic stack can fall back to a proportional face, and xterm
             * measures ONE character and multiplies, so a fallback would put
             * every glyph at the wrong x. */
            fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
            fontSize: 12,
            /* Compact rows: the pane is tall and narrow, so a tighter line height
             * fits noticeably more of the transcript. It must stay an integer
             * pixel count after the host's zoom multiplies it, or the row index a
             * pointer maps to drifts by a row further down the screen. */
            lineHeight: 1.2,
            letterSpacing: 0,
            theme: theme(),
            allowProposedApi: true,
          });
          term.current = instance;
          /* Publish the emulator's own background as a CSS variable so every
           * wrapper paints the identical colour. Reading it from the theme
           * instead of re-reading the design token is deliberate: the token does
           * not resolve in this slot, and a mismatch here is visible as a seam. */
          const themeBackground = theme().background;
          const screenBox = host.current?.parentElement;
          if (screenBox) {
            screenBox.style.setProperty('--lvt-bg', themeBackground);
            /* Inline as well as the variable: a CSS rule from the host could
             * still win over ours, and one opaque colour on the box is what
             * removes the band regardless of rule order. */
            screenBox.style.backgroundColor = themeBackground;
          }
          instance.open(host.current);
          const fitAddon = typeof window.FitAddon?.FitAddon === 'function' ? new window.FitAddon.FitAddon() : undefined;
          if (fitAddon !== undefined) instance.loadAddon(fitAddon);
          const measure = () => {
            if (fitAddon === undefined) return;
            try {
              fitAddon.fit();
            } catch {
              /* the element is not laid out yet */
            }
          };
          measure();

          /* --------------------------------------------------------------
           * An ancestor's CSS `zoom` is left entirely alone.
           *
           * Earlier attempts compensated for the host's UI scale here — dividing
           * pointer coordinates, multiplying the row count — and every one of
           * them made things worse: the row count is derived by `fit()` from the
           * box it actually occupies, so overriding it pushed the grid past the
           * viewport and cost the scrollbar. Under CSS `zoom` the emulator's
           * measurements and the painted geometry scale together, which is
           * self-consistent; the only thing that needed correcting was which
           * pixel space a pointer is reported in, and that is handled at the
           * event level below.
           * -------------------------------------------------------------- */
          const zoomFactor = () => {
            const box = host.current;
            if (box === null) return 1;
            const layout = box.offsetWidth;
            const painted = box.getBoundingClientRect().width;
            if (!(layout > 0) || !(painted > 0)) return 1;
            const ratio = painted / layout;
            return Number.isFinite(ratio) && ratio > 1.001 ? ratio : 1;
          };
          const refit = () => {
            measure();
            /* `fit()` resizes the buffer but does not always repaint the rows it
             * grew into — the grid then reports 61 rows while the DOM has only
             * the handful that were visible before, and the rest of the pane
             * stays blank. A full refresh of the addressable range is what makes
             * the painted rows catch up with the buffer. */
            try {
              instance.refresh(0, Math.max(0, instance.rows - 1));
            } catch {
              /* the emulator is mid-teardown */
            }
          };
          fitRef.current = refit;
          refit();
          /* Every keystroke, paste and escape sequence goes to the PTY untouched. */
          detachData = instance.onData((data) => {
            if (stateRef.current !== 'running') return;
            void control(sessionId, { action: 'input', data }).catch(() => undefined);
          });
          if (typeof ResizeObserver !== 'undefined') {
            /* Fit immediately so the viewport tracks the drag, but send the new
             * geometry to the Host only when the gesture settles: every resize
             * the PTY receives makes the shell repaint at the new width, and a
             * repaint landing mid-output is what smears the screen.
             *
             * A focus-mode toggle also changes this element's size, and those
             * changes must NOT reach the PTY: the shell would reflow its whole
             * transcript for a width that only exists while the overlay is open.
             * `focusRef` is what tells the two apart. */
            resizeObserver = new ResizeObserver(() => {
              refit();
              if (stateRef.current !== 'running') return;
              /* A focus toggle resizes this element twice (open and close); the
               * PTY must not hear about either, or the shell reflows a transcript
               * that can never be put back. */
              if (focusRef.current || skipResizeRef.current) {
                skipResizeRef.current = false;
                return;
              }
              clearTimeout(resizeSend);
              resizeSend = setTimeout(() => {
                void control(sessionId, { action: 'resize', cols: instance.cols, rows: instance.rows }).catch(() => undefined);
              }, 150);
            });
            resizeObserver.observe(host.current);
          }

          /* --------------------------------------------------------------
           * Pointer mapping under an ancestor's CSS `zoom`.
           *
           * The scale plugin sets `zoom` on a container above this terminal.
           * Under CSS zoom the pointer arrives in PAINTED pixels while xterm
           * divides the offset by a cell size measured in LAYOUT pixels, so a
           * click lands a row or two below the cursor.
           *
           * `getComputedStyle(node).zoom` on the terminal itself always reports
           * 1 — CSS zoom does not inherit into computed style — so the factor is
           * measured instead, as the painted/layout width ratio of this box.
           * Only the event coordinates are rewritten; nothing is written to the
           * DOM, so no other pane's zoom is disturbed.
           * -------------------------------------------------------------- */
          let pointerScale = zoomFactor();
          const correctPointer = (event) => {
            if (pointerScale === 1) return;
            const rect = host.current?.getBoundingClientRect();
            if (!rect) return;
            const x = rect.left + (event.clientX - rect.left) / pointerScale;
            const y = rect.top + (event.clientY - rect.top) / pointerScale;
            for (const [key, value] of [
              ['clientX', x],
              ['clientY', y],
            ]) {
              try {
                Object.defineProperty(event, key, { value, configurable: true });
              } catch {
                /* non-configurable on this event: leave it rather than throw */
              }
            }
          };
          const pointerEvents = ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu'];
          for (const name of pointerEvents) host.current?.addEventListener(name, correctPointer, true);
          let pointerTimer;
          const schedulePointerScale = () => {
            clearTimeout(pointerTimer);
            pointerTimer = setTimeout(() => {
              pointerScale = zoomFactor();
            }, 150);
          };
          window.addEventListener('resize', schedulePointerScale);
          detachPointer = () => {
            clearTimeout(pointerTimer);
            for (const name of pointerEvents) host.current?.removeEventListener(name, correctPointer, true);
            window.removeEventListener('resize', schedulePointerScale);
          };
          /* Replay whatever the stream delivered while this was loading. */
          const queued = pending.current.splice(0);
          for (const apply of queued) apply(instance);
        })();
        return () => {
          disposed = true;
          clearTimeout(resizeSend);
          resizeObserver?.disconnect();
          detachPointer?.();
          detachPointer = undefined;
          detachData?.dispose();
          term.current?.dispose();
          term.current = null;
        };
      }, [sessionId]);

      /* The raw byte stream for this conversation. */
      React.useEffect(() => {
        let source;
        let disposed = false;
        setHasOutput(false);
        setConnected(false);
        source = new EventSource(`${STREAM}?session=${encodeURIComponent(sessionId)}`);
        source.onopen = () => {
          if (!disposed) setConnected(true);
        };
        source.onerror = () => {
          if (!disposed) setConnected(false);
        };
        source.onmessage = (event) => {
          let frame;
          try {
            frame = JSON.parse(event.data);
          } catch {
            return;
          }
          if (frame.type === 'screen' || frame.type === 'output') {
            const data = frame.data ?? '';
            const applyTo = (instance) => {
              if (frame.type === 'screen') instance.reset();
              if (data !== '') instance.write(data);
            };
            const instance = term.current;
            if (instance === null) {
              pending.current.push(applyTo);
              return;
            }
            applyTo(instance);
            if (data !== '') setHasOutput(true);
            setError(null);
          } else if (frame.type === 'state') {
            setSnapshot(frame);
          } else if (frame.type === 'note') {
            setNote({ text: frame.text, at: frame.at });
          }
        };
        return () => {
          disposed = true;
          source?.close();
        };
      }, [sessionId]);

      /* Seed the state line once, so it is right before the first frame lands. */
      React.useEffect(() => {
        let cancelled = false;
        fetch(`${CONTROL}?session=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (!cancelled && payload?.state !== undefined) setSnapshot(payload);
          })
          .catch(() => {
            if (!cancelled) setError(new Error('host'));
          });
        return () => {
          cancelled = true;
        };
      }, [sessionId]);

      const act = React.useCallback(
        async (body) => {
          setBusy(true);
          try {
            const payload = await control(sessionId, body);
            if (payload?.state !== undefined) setSnapshot(payload);
            setError(null);
            return payload;
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
            return undefined;
          } finally {
            setBusy(false);
          }
        },
        [sessionId],
      );

      const running = snapshot.state === 'running';
      const stateLabel =
        snapshot.state === 'running'
          ? t('stateRunning')
          : snapshot.state === 'exited'
            ? t('stateExited')
            : snapshot.state === 'failed'
              ? t('stateFailed')
              : t('stateIdle');

      /* Clicking the viewport focuses the emulator's hidden textarea, which is
       * what actually receives keystrokes; without this a click lands on the
       * container and typing goes nowhere. */
      const focusTerminal = () => {
        term.current?.focus();
      };

      /* No Start button: opening the panel IS the intent to have a terminal, so
       * an idle pane spawns one. Only `idle` does — a running, exited or failed
       * session is left alone, so a remount cannot kill the model's shell. */
      const startRef = React.useRef(null);
      startRef.current = () => {
        const instance = term.current;
        void act({
          action: 'start',
          cols: instance?.cols ?? 100,
          rows: instance?.rows ?? 24,
          cwd,
          restart: snapshot.state !== 'idle',
        }).then((payload) => {
          if (payload !== undefined) {
            setHasOutput(false);
            term.current?.reset();
          }
        });
      };
      React.useEffect(() => {
        if (sessionId === '' || missing || snapshot.state !== 'idle') return;
        startRef.current?.();
        /* Keyed on the idle state alone: this is an entry action, not a reaction
         * to every snapshot. */
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId, missing, snapshot.state === 'idle']);

      /* Closing the panel closes its terminal, which is what closing a terminal
       * window means. Closing a tab without closing the panel only detaches a
       * viewer, and the auto-open signal can bring that back with the screen. */
      React.useEffect(
        () => () => {
          if (sessionId === '') return;
          void control(sessionId, { action: 'stop' }).catch(() => undefined);
        },
        [sessionId],
      );

      /* Focus mode is PURELY VISUAL and must not touch the emulator's grid.
       *
       * Changing `options.fontSize` looks free but is not: xterm re-measures the
       * font, rebuilds every row element and repaints the whole viewport, which
       * is the stutter on entering and leaving. A CSS transform is composited by
       * the browser instead — no re-measure, no reflow of the character grid, no
       * message to the PTY — so the switch costs one frame.
       *
       * The transform origin is the top-left so the visible text does not shift,
       * and the overlay already has the room for it. */
      /* Focus mode is PURELY VISUAL: one font size, one geometry, for the whole
       * session. Changing the type size does make xterm re-measure and repaint
       * the visible viewport, which is the cost of a switch — but it is bounded
       * by the viewport, not by scrollback, and it is far cheaper than the
       * alternative of letting the PTY reflow the transcript (which cannot be
       * undone once the shell has emitted its wrapping).
       *
       * `will-change` is set just before the change so the browser promotes the
       * layer ahead of the repaint instead of during it. */
      React.useEffect(() => {
        const instance = term.current;
        if (instance === null) return;
        const box = instance.element;
        /* Both directions of the toggle resize the element; neither belongs to
         * the shell. Set before the change so the observer sees it too. */
        skipResizeRef.current = true;
        box?.style.setProperty('will-change', 'scroll-position');

        /* The class change and the font change are not enough on their own: the
         * overlay's `position: fixed` box is only laid out after the browser's
         * next style pass, so a `fit()` inside the same frame measures the OLD
         * size and the grid keeps the narrow column's rows — which is the large
         * empty area under the prompt. Fitting across several frames, and again
         * when the resize observer has fired, converges on the real box. */
        const timers = [];
        const applyFont = () => {
          try {
            instance.options.fontSize = focused ? 15 : 12;
          } catch {
            /* frozen options: nothing to scale */
          }
        };
        applyFont();
        for (const delay of [0, 16, 60, 160, 320]) {
          timers.push(setTimeout(() => fitRef.current?.(), delay));
        }
        const settle = setTimeout(() => {
          box?.style.removeProperty('will-change');
        }, 360);
        timers.push(settle);
        return () => {
          for (const timer of timers) clearTimeout(timer);
        };
      }, [focused]);

      /* Esc leaves focus mode unless the terminal's program wants the key (vim,
       * less, ssh) — in that case xterm already consumed it. */
      React.useEffect(() => {
        if (!focused) return;
        const onKey = (event) => {
          if (event.key === 'Escape') setFocused(false);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [focused]);

      return h(
        'div',
        { className: 'lvt-root' },
        h('style', { key: 'style' }, CSS),
        h(
          'div',
          { className: 'lvt-bar' },
          h(
            'span',
            { className: 'lvt-pill', key: 'state' },
            h('span', { className: 'lvt-dot', 'data-state': snapshot.state }),
            stateLabel,
          ),
          h('span', { key: 'mirror', title: t('streaming') }, connected ? '●' : '○'),
          snapshot.shell !== undefined ? h('span', { className: 'lvt-meta', key: 'shell' }, snapshot.shell) : null,
          snapshot.cwd !== null && snapshot.cwd !== undefined
            ? h('span', { className: 'lvt-meta', key: 'cwd', title: snapshot.cwd }, snapshot.cwd)
            : null,
          h(
            'span',
            { style: { display: 'flex', gap: '6px', marginLeft: 'auto' }, key: 'actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'lvt-btn',
                disabled: busy || !running,
                onClick: () => {
                  void act({ action: 'signal', signal: 'SIGINT' });
                },
              },
              'Ctrl-C',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'lvt-btn',
                disabled: busy,
                onClick: () => {
                  term.current?.clear();
                  term.current?.reset();
                  setHasOutput(false);
                },
              },
              t('clear'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'lvt-btn',
                title: focused ? t('exitFocus') : t('focus'),
                'aria-pressed': focused,
                onClick: () => setFocused((value) => !value),
              },
              focused ? t('exitFocus') : t('focus'),
            ),
          ),
        ),
        note !== null ? h('div', { className: 'lvt-note' }, note.text) : null,
        missing
          ? h('div', { className: 'lvt-error' }, t('noXterm'))
          : error !== null
            ? h('div', { className: 'lvt-error' }, error === 'host' ? t('noHost') : String(error))
            : null,
        h(
          'div',
          { className: focused ? 'lvt-screen lvt-focus' : 'lvt-screen', onMouseDown: focusTerminal },
          h('div', { className: 'lvt-term', ref: host }),
          error === 'host' || missing || hasOutput || snapshot.state !== 'idle'
            ? null
            : h('div', { className: 'lvt-empty' }, t('empty')),
        ),
      );
    }

    return {
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'live-terminal: dictionaries');
        const t = ctx.locale.bind(NS);

        /**
         * Register as a Better Sidebar tab when that plugin is present.
         *
         * `ctx.inject` is the client-side optional-service seam: the callback
         * runs when the service appears and is torn down if it goes away, so
         * load order between the two plugins does not matter and disabling
         * Better Sidebar cannot leave a dangling tab registration behind.
         */
        /* Exactly one surface owns the sidebar entry. These flags decide which,
         * and both live at apply scope so either inject can win regardless of
         * which service resolves first. */
        /** DSH's own right-sidebar faces: the type registry, and the controller that opens one. */
        let dshTabRegistry;
        let dshRightController;
        let dshMounted = false;
        const disposers = [];

        /**
         * The Host's "open the panel" signal.
         *
         * This stream lives with the PAGE, not with a panel: a closed right
         * sidebar unmounts the tab, and a tab cannot ask to be reopened. One
         * long-lived connection per page is what makes the request reachable.
         *
         * The connection heals itself. An EventSource that meets a non-SSE
         * answer (an SPA fallback, a proxy that is not up yet at apply time)
         * gives up for good, so every failure tears the old one down and
         * reconnects a few seconds later. Each transition also reports itself
         * to the Host (`action: 'trace'`), which is how a page-side failure
         * becomes visible in `/live-terminal?diag=1` instead of guessing.
         */
        ctx.effect(() => {
          let source;
          let disposed = false;
          let retry;
          const trace = (detail) => {
            void control('', { action: 'trace', tag: 'signal', detail: String(detail).slice(0, 120) }).catch(() => undefined);
          };
          const connect = () => {
            if (disposed) return;
            try {
              source = new EventSource(`${SIGNAL}?ping=1`);
            } catch (failure) {
              trace(`construct failed: ${String(failure?.message ?? failure)}`);
              retry = setTimeout(connect, 4000);
              return;
            }
            source.onopen = () => trace('open');
            source.onerror = () => {
              trace(`error (readyState ${source.readyState})`);
              try {
                source.close();
              } catch {
                /* already closed */
              }
              if (disposed) return;
              retry = setTimeout(connect, 4000);
            };
            source.onmessage = (event) => {
              let frame;
              try {
                frame = JSON.parse(event.data);
              } catch {
                return;
              }
              if (frame?.type !== 'open') return;
              /* One surface, and it is DSH's own right sidebar — the entry that
               * exists whether or not Better Sidebar is installed. This is the
               * only registration the plugin makes, so the panel can never be
               * duplicated and can never disappear with a third-party plugin.
               *
               * `openTabIn` rather than `openTab`: the latter takes the session
               * currently adopted to the column, which is nobody while the
               * column is hidden, so it silently does nothing — the one case
               * this signal exists for. */
              const dshRight = dshRightController;
              /* No "already active" guard here: the Host only signals when NO
               * page is subscribed to this conversation's stream, which means
               * the tab component is not mounted — nothing is visible and there
               * is no focus to steal. */
              try {
                if (dshRight !== undefined && typeof dshRight.openTabIn === 'function') {
                  dshRight.openTabIn(frame.session, DSH_TAB_KIND, { replaceTab: true });
                  trace(`open requested for ${frame.session} (dsh-sidebar)`);
                } else {
                  trace(`no sidebar surface for ${frame.session}`);
                }
              } catch (failure) {
                trace(`open failed: ${String(failure?.message ?? failure)}`);
              }
            };
          };
          connect();
          return () => {
            disposed = true;
            clearTimeout(retry);
            try {
              source?.close();
            } catch {
              /* already closed */
            }
          };
        }, 'live-terminal: panel signal');

        /* The plugin's own page: Settings → Plugins → dsh-live-terminal (and the
         * row page under it).
         *
         * Two different pages, two different slots, and the difference matters:
         * the PACKAGE page renders `plugins.bundle.config` keyed by package name
         * and never renders a row's Config form; the ROW page renders
         * `plugins.row.config` with that row's `Config` form. So the switch the
         * Host renders from `Config` lives on the row page, and this panel gives
         * the package page — the one people actually land on — both the
         * description and a working switch of its own. */
        const isThisPackage = (subject) =>
          subject?.pkg?.name === 'dsh-live-terminal' || subject?.row?.name === 'dsh-live-terminal';

        /**
         * A switch that writes the same value the native form writes.
         *
         * It goes through the settings mirror rather than a private store, so the
         * row page's form and this control can never disagree: both read
         * `describe()` and both write through `update`.
         */
        function AutoOpenSwitch({ t }) {
          const [state, setState] = React.useState({ ready: false, on: true, busy: false, error: null });
          const formRef = React.useRef(null);

          React.useEffect(() => {
            let disposed = false;
            let off;
            ctx.inject(['configForms'], (sctx) => {
              const forms = sctx.get('configForms');
              if (forms === undefined || typeof forms.get !== 'function') return;
              const form = forms.get(ROW_ID);
              formRef.current = form;
              const read = () => {
                const snapshot = form.getSnapshot?.();
                if (disposed) return;
                const value = snapshot?.value;
                if (snapshot?.status === 'ready' && value !== undefined && value !== null) {
                  setState((previous) => ({ ...previous, ready: true, on: value.autoOpenPanel !== false, error: null }));
                } else if (snapshot?.status === 'unavailable') {
                  /* The Host does not serve this namespace: say so instead of
                   * showing a switch that would write nowhere. */
                  setState((previous) => ({ ...previous, ready: false, error: 'unavailable' }));
                }
              };
              read();
              off = form.subscribe?.(read);
              return () => {
                off?.();
                formRef.current = null;
              };
            });
            return () => {
              disposed = true;
              off?.();
            };
          }, []);

          const toggle = () => {
            const form = formRef.current;
            if (form === undefined || form === null || state.busy) return;
            const next = !state.on;
            setState((previous) => ({ ...previous, busy: true, on: next }));
            /* `mutate` resolves to a BOOLEAN — it does not throw when the Host
             * refuses the write — so the refusal has to be read off the result
             * or the switch would silently disagree with the stored value. */
            Promise.resolve(form.mutate?.([{ op: 'set', path: ['autoOpenPanel'], value: next }]))
              .then((accepted) => {
                if (accepted === false) {
                  setState((previous) => ({ ...previous, busy: false, on: !next, error: t('autoOpenRejected') }));
                  return;
                }
                setState((previous) => ({ ...previous, busy: false, error: null }));
              })
              .catch((error) => {
                setState((previous) => ({
                  ...previous,
                  busy: false,
                  on: !next,
                  error: String(error?.message ?? error),
                }));
              });
          };

          return h(
            'div',
            { className: 'lvt-detail-switch' },
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': state.on,
                'data-on': state.on ? 'true' : 'false',
                className: 'lvt-toggle',
                disabled: state.busy || state.error === 'unavailable',
                onClick: toggle,
                title: t('autoOpenLabel'),
              },
              h('span', { className: 'lvt-toggle-knob' }),
            ),
            h(
              'div',
              { className: 'lvt-detail-switch-text' },
              h('strong', null, t('autoOpenLabel')),
              h(
                'span',
                null,
                state.error === 'unavailable'
                  ? t('autoOpenUnavailable')
                  : state.error !== null
                    ? state.error
                    : t('autoOpenHint'),
              ),
            ),
          );
        }

        const detailPanel = (subject) =>
          isThisPackage(subject)
            ? h(
                'div',
                { className: 'lvt-detail' },
                h('style', { key: 'style' }, CSS),
                h('h3', { className: 'lvt-detail-title' }, t('detailTitle')),
                h('p', { className: 'lvt-detail-body' }, t('detailBody')),
                h(AutoOpenSwitch, { t }),
                h('ul', { className: 'lvt-detail-list' }, h('li', null, t('detailPerSession'))),
              )
            : null;
        /* One panel, one slot.
         *
         * `plugins.detail.section` is rendered by BOTH detail pages — the package
         * page and the row page — so registering here covers the page people
         * land on (Settings → Plugins → this plugin) without a second copy.
         * Registering `plugins.bundle.config` as well showed the same panel
         * twice on the package page, because that page renders both slots. */
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.detail.section', () =>
              ctx.slots.register(
                { name: 'plugins.detail.section', id: 'dsh-live-terminal-info', order: 80, locale: NS, inject: () => ({ t }) },
                (ownerProps = {}) => detailPanel(ownerProps.subject),
              ),
            ),
          'live-terminal: plugin detail',
        );

        /* ------------------------------------------------------------------
         * The panel's only home: DSH's own right sidebar.
         *
         * This is the surface the host itself provides, so it is the one entry
         * that exists in every profile — with Better Sidebar installed, without
         * it, and after it is uninstalled. Registering anywhere else as well put
         * the same panel in the sidebar twice; registering only there keeps one
         * entry that never depends on a third-party plugin.
         *
         * Three pieces are needed — a tab type nobody can dispatch renders
         * nothing, and a body slot with no type is never opened:
         *
         *   sidebarRightTabs.register(...)   declares the kind and its title
         *   sidebar.right.pane.tab          renders the body for that kind
         *   sidebar.right.pane.tab.title    renders the live tab chip
         * ------------------------------------------------------------------ */
        /**
         * Register on DSH's own right sidebar: type, body and title.
         *
         * All three are needed — a tab type nobody can dispatch renders nothing,
         * and a body slot with no type is never opened. The body is dispatched by
         * `entryKey: definition.id` and receives the conversation id through
         * `inject(sessionId)`, so no scope guessing (which is what left the old
         * left-sidebar entry bound to an empty session key).
         */
        const mountDsh = (sctx) => {
          if (dshMounted) return;
          const tabs = sctx.get('sidebarRightTabs');
          if (tabs === undefined || typeof tabs.register !== 'function') return;
          dshMounted = true;
          dshTabRegistry = tabs;
          disposers.push(
            sctx.effect(
              () =>
                tabs.register({
                  id: DSH_TAB_ID,
                  kind: DSH_TAB_KIND,
                  priority: 'builtin',
                  multiple: false,
                  /* Keep the emulator alive while the tab is not the active one:
                   * the model may be typing into it, and remounting would replay
                   * the whole screen for nothing. */
                  keepMounted: true,
                  title: () => t('panel'),
                  guide: [
                    {
                      id: 'open-live-terminal',
                      order: 21,
                      title: () => t('panel'),
                      description: () => t('tabDesc'),
                      icon: (size) => h(TerminalIcon, { size }),
                    },
                  ],
                }),
              'live-terminal: dsh tab type',
            ),
          );
          const bodyScope = ctx;
          disposers.push(
            bodyScope.effect(
              () =>
                bodyScope.slots.inject('sidebar.right.pane.tab', () =>
                  bodyScope.slots.register(
                    {
                      name: 'sidebar.right.pane.tab',
                      key: DSH_TAB_ID,
                      locale: NS,
                      inject: (sessionId) => ({ sessionId }),
                    },
                    ({ sessionId }) =>
                      h(TerminalPane, { key: sessionId, t, sessionId: sessionId ?? '' }),
                  ),
                ),
              'live-terminal: dsh tab body',
            ),
          );
          disposers.push(
            bodyScope.effect(
              () =>
                bodyScope.slots.inject('sidebar.right.pane.tab.title', () =>
                  bodyScope.slots.register(
                    { name: 'sidebar.right.pane.tab.title', key: DSH_TAB_ID, locale: NS },
                    () => h('span', { className: 'lvt-tabtitle' }, t('panel')),
                  ),
                ),
              'live-terminal: dsh tab title',
            ),
          );
        };

        const unmountDsh = () => {
          dshMounted = false;
          dshTabRegistry = undefined;
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              /* already gone */
            }
          }
        };

        /* The one registration this plugin makes. It follows `sidebarRightTabs`,
         * which DSH provides itself — so the entry is there with or without
         * Better Sidebar, and nothing here depends on a third-party plugin. */
        ctx.inject(['sidebarRightTabs'], (sctx) => {
          mountDsh(sctx);
          return () => unmountDsh();
        });

        ctx.inject(['sidebarRight'], (sctx) => {
          const right = sctx.get('sidebarRight');
          if (right === undefined || typeof right.openTabIn !== 'function') return;
          dshRightController = right;
          return () => {
            dshRightController = undefined;
          };
        });
      },
      inject: ['slots', 'locale'],
    };
  },
});
