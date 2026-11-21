/**
 * Host half of `dsh-live-terminal`.
 *
 * Terminals are per conversation: the key is the session id, so the tab in one
 * conversation's right sidebar never touches another conversation's shell. The
 * page and the model address the same key — the page through `?session=<id>`,
 * the tools through the calling agent's id — so a tool call and the panel the
 * user is looking at are the same PTY.
 *
 * The host keeps the authoritative screen with `@xterm/headless`, the same
 * emulator the page runs, so a tool result is the text a person would read, and
 * a page that connects late receives one serialized screen and lands on the
 * identical view.
 *
 * `@xterm/headless` is resolved from the harness install (it ships inside
 * `app.asar`); if that stops resolving, the plugin degrades to a plain-text
 * transcript rather than failing to load.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

/**
 * The schema library, for the Loader row's Config.
 *
 * `Config` is what the settings page renders (DSH 0.2.2 derives every settings
 * form from a plugin's own Config schema), so the switch this plugin exposes
 * lives here rather than in a store of its own. Resolved through the app's
 * module tree because the profile installs plugins as links with no
 * `node_modules` of their own to inherit from.
 */
const requireFromApp = createRequire(
  typeof process.resourcesPath === 'string'
    ? join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', 'anchor.js')
    : fileURLToPath(new URL('./anchor.js', import.meta.url)),
);
const z = (() => {
  try {
    return requireFromApp('@deepseek-ai/schemastery');
  } catch {
    return undefined;
  }
})();

/** Route for control actions. */
const CONTROL_PATH = '/live-terminal';
/** Route carrying the raw output stream. */
const STREAM_PATH = '/live-terminal/stream';
/** Vendored browser terminal, served by this plugin. */
const VENDOR_PATH = '/live-terminal/vendor';
/** Scrollback kept by the authoritative screen. */
const SCROLLBACK = 5000;
/** Output a tool returns by default; longer results are elided in the middle. */
const DEFAULT_LIMIT = 6_000;
/** Quiet window that ends a `live_terminal_run` wait. */
const IDLE_MS = 1200;
/** Quiet windows tolerated after real output before an interactive program's
 *  transcript is handed back without a prompt. */
const PROMPT_GRACE_WINDOWS = 2;
/** Quiet windows after which a wait gives up even with no recognizable prompt:
 *  the command printed nothing and something is wrong with the anchor. */
const SILENT_GIVE_UP_WINDOWS = 6;
/** Quiet window after the last geometry change before the PTY is really resized. */
const RESIZE_SETTLE_MS = 120;
/** Longest single wait, whatever the caller asks for. */
const MAX_WAIT_MS = 180_000;
/** Longest single input accepted from the page. */
const MAX_INPUT_BYTES = 65_536;
/** Coalescing window for output frames, so `dir /s` cannot flood the page. */
const FLUSH_DELAY_MS = 16;
/** How many conversations may hold a live shell at once before the oldest goes. */
const MAX_TERMINALS = 8;
/** Key used when a caller names no session. */
const DEFAULT_KEY = '';
/** Route carrying the "open the panel" signal from the Host to the page. */
const SIGNAL_PATH = '/live-terminal/signal';

/**
 * The plugin's Loader-row config — the form the settings page renders.
 *
 * DSH 0.2.2 builds every settings form from a plugin's own `Config` schema
 * (`SettingsForms.schema()` reads `entry.fiber.runtime.Config`); there is no
 * third-party `settings.register` any more, so this is the only seam a plugin
 * has for a user-facing switch.
 *
 * `volatile()` is what makes the field APPEAR: `volatileForm()` walks the schema
 * and drops every field whose nearest ancestor is not volatile, and an entry
 * with no live field renders no form at all. It also means an edit applies
 * without remounting this plugin.
 *
 * `schemastery` is resolved lazily: without it the plugin still loads, just
 * with the default behaviour and no switch.
 */
export const Config = z === undefined
  ? undefined
  : z.object({
      /** Open the right sidebar when the model starts a terminal nobody watches. */
      autoOpenPanel: z
        .boolean()
        .default(true)
        .description('模型启动实时终端时，如果右侧栏没有这个页签，自动打开它。关掉就不会再自动弹出。')
        .volatile(),
    });

/** Coerce a value into a bounded integer. */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** Read a JSON body with a hard byte cap instead of trusting `Content-Length`. */
async function readJson(req, limit = 262_144) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Load the emulator the harness itself ships.
 *
 * Resolution is attempted from several plausible roots because the packaged
 * layout is not part of any public contract; the first root that answers wins.
 * @returns `{ Terminal, SerializeAddon }`, or `{ failures }` when none resolve.
 */
function loadEmulator() {
  const roots = [];
  if (typeof process.resourcesPath === 'string') {
    roots.push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', 'anchor.js'));
    roots.push(join(process.resourcesPath, 'app.asar', 'node_modules', 'anchor.js'));
    roots.push(join(process.resourcesPath, 'app', 'node_modules', 'anchor.js'));
  }
  roots.push(join(process.cwd(), 'node_modules', 'anchor.js'));
  roots.push(fileURLToPath(new URL('./anchor.js', import.meta.url)));
  const failures = [];
  for (const root of roots) {
    try {
      const requireFrom = createRequire(root);
      const { Terminal } = requireFrom('@xterm/headless');
      if (typeof Terminal !== 'function') throw new Error('@xterm/headless did not export Terminal');
      let SerializeAddon;
      try {
        ({ SerializeAddon } = requireFrom('@xterm/addon-serialize'));
      } catch {
        /* The addon is only needed to replay a screen into a late page; without
         * it the page starts at the first live byte instead of the current view. */
        SerializeAddon = undefined;
      }
      return { Terminal, SerializeAddon };
    } catch (error) {
      failures.push(`${root}: ${String(error?.message ?? error)}`);
    }
  }
  return { failures };
}

/**
 * The authoritative screen.
 *
 * Wraps a headless terminal so callers see a synchronous-looking object while
 * the parser stays asynchronous underneath: `write` queues, `settled` resolves
 * when the queue has drained, and every reader awaits it first.
 */
class Screen {
  /** @param options - Terminal constructor, dimensions, and scrollback. */
  constructor(options) {
    this.terminal = new options.Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback ?? SCROLLBACK,
      allowProposedApi: true,
    });
    this.serializeAddon = undefined;
    if (options.SerializeAddon !== undefined) {
      try {
        this.serializeAddon = new options.SerializeAddon();
        this.terminal.loadAddon(this.serializeAddon);
      } catch {
        this.serializeAddon = undefined;
      }
    }
    /** Serialized parse chain: headless `write` is asynchronous. */
    this.queue = Promise.resolve();
  }

  /**
   * Feed raw PTY bytes to the emulator.
   * @param data - decoded output.
   */
  write(data) {
    this.queue = this.queue.then(
      () =>
        new Promise((resolve) => {
          try {
            this.terminal.write(data, resolve);
          } catch {
            resolve();
          }
        }),
    );
  }

  /** Resolve when every queued byte has been parsed. */
  get settled() {
    return this.queue;
  }

  /**
   * Whether a typed command would be read by the shell rather than by a
   * full-screen program.
   *
   * `buffer.type === 'alternate'` is the emulator's own record of a program
   * that switched to the alternate screen (vim, htop, less, ssh): a command
   * typed there belongs to that program, and would edit its buffer or be
   * echoed as garbage. Everything else is the shell's own line — measured
   * against a real PTY, a half-typed command stays on the normal buffer and the
   * shell's clear command simply replaces it, which is what "clear" means.
   * @returns the flags the clear path decides with.
   */
  screenState() {
    const buffer = this.terminal.buffer.active;
    const altScreen = buffer.type === 'alternate';
    return { altScreen };
  }

  /** The cursor's absolute row, counting scrollback. */
  get cursorRow() {
    const buffer = this.terminal.buffer.active;
    return buffer.baseY + buffer.cursorY;
  }

  /**
   * Screen text from a line index.
   *
   * Each row is right-trimmed: a terminal pads rows to the full width, and a
   * full-screen program paints those pads as real spaces, which
   * `translateToString(true)` cannot drop because they were written.
   * @param from - line index, 0 being the oldest retained line.
   * @returns the text, without leading or trailing blank lines.
   */
  text(from = 0) {
    const buffer = this.terminal.buffer.active;
    const lines = [];
    const start = Math.max(0, Math.min(from, buffer.length));
    for (let index = start; index < buffer.length; index += 1) {
      lines.push((buffer.getLine(index)?.translateToString(true) ?? '').replace(/\s+$/u, ''));
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    return lines.join('\n');
  }

  /**
   * The last non-blank row of the buffer, right-trimmed.
   *
   * `text()` walks every retained row, which is the right shape for reading a
   * screen and the wrong one for a question that only concerns its bottom line:
   * with a full 5000-row scrollback a single `text()` call costs ~2.3ms, and the
   * wait loop asks on every output chunk — enough to pin the Host's event loop
   * during a chatty build. This walks backwards and stops at the first row with
   * content in it, so it costs the same whether the scrollback is empty or
   * full.
   * @returns the row's text, or `''` when the buffer is blank.
   */
  lastLine() {
    const buffer = this.terminal.buffer.active;
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      const line = buffer.getLine(index);
      if (line === undefined) continue;
      const value = line.translateToString(true).replace(/\s+$/u, '');
      if (value.trim() !== '') return value;
    }
    return '';
  }

  /** Replayable ANSI for a freshly opened page. */
  serialize() {
    if (this.serializeAddon === undefined) return '';
    try {
      return this.serializeAddon.serialize({ scrollback: SCROLLBACK });
    } catch {
      return '';
    }
  }

  /**
   * Resize the screen with the PTY.
   * @param cols - new width.
   * @param rows - new height.
   */
  resize(cols, rows) {
    if (this.terminal.cols === cols && this.terminal.rows === rows) return;
    this.terminal.resize(cols, rows);
  }

  /** Release the emulator. */
  dispose() {
    try {
      this.terminal.dispose();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Text-only fallback used when no emulator resolves.
 *
 * It cannot represent a cursor-addressed screen, so it strips escapes and keeps
 * the tail — enough for a scrolling command, not enough for `vim`.
 */
class PlainScreen {
  /** @param options - dimensions. */
  constructor(options) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.data = '';
    this.lines = 0;
    this.queue = Promise.resolve();
  }

  /** Strip escape sequences and append. */
  write(data) {
    this.data += data
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
      .replace(/\u001b[()][A-Za-z0-9]/gu, '')
      .replace(/\u001b[@-Z\\\]^_=>]/gu, '')
      .replace(/\r\n?/gu, '\n')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, '');
    this.lines = this.data.split('\n').length - 1;
    if (this.data.length > 240_000) {
      const dropped = this.data.slice(0, this.data.length - 200_000);
      this.data = this.data.slice(-200_000);
      this.lines -= dropped.split('\n').length - 1;
    }
  }

  /** Nothing to wait for. */
  get settled() {
    return Promise.resolve();
  }

  /**
   * A text fallback has no screen modes to inspect, so it cannot tell a shell
   * prompt from a full-screen program. Reporting `altScreen: false` means the
   * caller types the shell's clear command, which is the same thing a user
   * would do at a prompt; a program running in such a terminal is exactly the
   * case this fallback was never able to render correctly anyway.
   */
  screenState() {
    return { altScreen: false };
  }

  /** Approximate line count. */
  get lineCount() {
    return Math.max(0, this.lines);
  }

  /** The newest line, standing in for the cursor row. */
  get cursorRow() {
    return this.lineCount;
  }

  /** Screen text from a line index. */
  text(from = 0) {
    const lines = this.data.split('\n');
    const start = Math.max(0, Math.min(from, lines.length));
    const slice = lines.slice(start);
    while (slice.length > 0 && slice[slice.length - 1].trim() === '') slice.pop();
    return slice.join('\n').replace(/\n{3,}/gu, '\n\n');
  }

  /** The last non-blank row, for callers that only need the bottom line. */
  lastLine() {
    const lines = this.data.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const value = lines[index].replace(/\s+$/u, '');
      if (value.trim() !== '') return value;
    }
    return '';
  }

  /** No replay available. */
  serialize() {
    return '';
  }

  /** Track the new size. */
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
  }

  /** Nothing to release. */
  dispose() {}
}

/** One live terminal: the PTY, the screen, and the pages watching it. */
class LiveSession {
  /** @param spec - resolved shell, dimensions, directory, PTY handle, screen, publisher. */
  constructor(spec) {
    this.key = spec.key;
    this.shell = spec.shell;
    this.handle = spec.handle;
    this.pid = typeof spec.handle.pid === 'number' && spec.handle.pid > 0 ? spec.handle.pid : null;
    this.cols = spec.cols;
    this.rows = spec.rows;
    this.cwd = spec.cwd;
    this.screen = spec.screen;
    /** Sends a frame to every page watching this conversation. */
    this.publish = spec.publish;
    this.status = 'running';
    this.exitCode = null;
    /** Bytes received, so a waiter can tell "new output" from "still waiting". */
    this.revision = 0;
    /** Timestamp of the last output, for eviction of idle shells. */
    this.lastActiveAt = Date.now();
    this.waiters = new Set();
    /** Bytes not yet shipped to the pages. */
    this.pending = '';
    this.flushTimer = undefined;
    /** Latest requested geometry not yet applied (see {@link requestResize}). */
    this.pendingSize = undefined;
    this.resizeTimer = undefined;
  }

  /**
   * Queue a geometry change instead of applying it on the spot.
   *
   * A window drag fires dozens of resizes, and every applied one makes ConPTY
   * repaint the screen at the new width — a repaint that lands mid-output is
   * what writes the screen (and the shell's prompt redraw) at stale
   * coordinates. Collapsing a gesture to one resize on its settle removes the
   * storm; `flushResize` lets a command line up afterwards deterministically.
   * @param cols - new width.
   * @param rows - new height.
   */
  requestResize(cols, rows) {
    const unchanged = this.pendingSize === undefined && cols === this.cols && rows === this.rows;
    if (unchanged) return;
    this.pendingSize = { cols, rows };
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.flushResize();
    }, RESIZE_SETTLE_MS);
    this.resizeTimer.unref?.();
  }

  /**
   * Apply the queued geometry now.
   * @returns whether anything was applied.
   */
  flushResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    const pending = this.pendingSize;
    if (pending === undefined) return false;
    this.pendingSize = undefined;
    this.cols = pending.cols;
    this.rows = pending.rows;
    this.screen.resize(this.cols, this.rows);
    void this.handle.resize(this.cols, this.rows);
    return true;
  }

  /** Wake everyone waiting for output. */
  notify() {
    for (const wake of this.waiters) wake();
  }

  /**
   * Resolve on the next output, the deadline, or nothing at all.
   * @param deadline - epoch millisecond bound.
   */
  waitForOutput(deadline) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
      timer.unref?.();
      this.waiters.add(wake);
    });
  }

  /** Send one frame to every watching page. */
  broadcast(frame) {
    this.publish?.(this.key, frame);
  }

  /** Coalesce raw output onto the next frame. */
  scheduleFlush() {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  /** Ship queued bytes as one raw frame. */
  flush() {
    if (this.pending === '') return;
    const data = this.pending;
    this.pending = '';
    this.broadcast({ type: 'output', data });
  }

  /**
   * Clear the screen on BOTH sides, without disturbing a running program.
   *
   * A terminal's "clear" has to mean the same thing here and on the far side:
   * the page shows one emulator and the model reads another, so a local wipe
   * alone would leave them describing different screens. The portable way is
   * the shell's own clear command, entered at its prompt:
   *
   * - `cls` for cmd.exe, `Clear-Host` for PowerShell, `clear` for a POSIX
   *   shell. Those three cover everything `resolveShell` can start. Ctrl-L is
   *   deliberately not used: it is a real key only in a POSIX-line-edited
   *   shell, and Windows PowerShell — which is what this pool starts on
   *   Windows — inserts it into the input line as a literal character.
   * - A full-screen program (vim, htop, less, ssh) owns the screen and the
   *   keyboard, so nothing is typed at all; both screens are wiped directly.
   *
   * @returns what was actually done, for the caller's log line.
   */
  async clearScreen() {
    if (this.status !== 'running') {
      /* Nothing is listening: wipe the authoritative screen so a later page
       * replay starts clean. */
      this.wipeScreen();
      return { mode: 'wipe' };
    }
    const state = await this.screenState();
    if (state.altScreen) {
      this.wipeScreen();
      return { mode: 'wipe', altScreen: true };
    }
    const name = String(this.shell?.name ?? '').toLowerCase();
    const command =
      name === 'cmd.exe' || name === 'cmd'
        ? 'cls'
        : name.startsWith('pwsh') || name.startsWith('powershell')
          ? 'Clear-Host'
          : 'clear';
    this.lastActiveAt = Date.now();
    /* The trailing CR is the Enter the shell needs; the command's own output
     * (the cleared grid) then reaches the page and the Host screen through the
     * ordinary output path, so both halves clear the same way. */
    await this.handle.write(`${command}\r`);
    return { mode: 'command', command };
  }

  /**
   * Empty the authoritative screen and tell the pages to do the same.
   *
   * `\x1b[2J` clears the visible grid and `\x1b[3J` the scrollback; together
   * with a cursor home they leave an empty screen at the top-left, exactly what
   * a fresh terminal looks like. The emulator is fed the sequence rather than
   * having its buffer poked, so every page's replay and the model's next read
   * agree.
   */
  wipeScreen() {
    try {
      this.screen.write('\x1b[2J\x1b[3J\x1b[H');
    } catch {
      /* a disposed emulator: nothing left to clear */
    }
    this.revision += 1;
    this.notify();
  }

  /**
   * Ask the emulator whether a typed command would reach the shell.
   *
   * Parsing is asynchronous, so the queued bytes are drained first: a decision
   * made on a half-parsed screen would read a stale buffer mode.
   */
  async screenState() {
    await this.screen.settled;
    const screen = this.screen;
    if (typeof screen.screenState === 'function') return screen.screenState();
    /* Neither screen implementation lacks this, but a custom one could: treat
     * the shell as available, which types the command a user would have typed
     * themselves. */
    return { altScreen: false };
  }

  /** A JSON snapshot for the page. */
  snapshot() {
    return {
      state: this.status,
      session: this.key,
      shell: this.shell.name,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      pid: this.pid,
      exitCode: this.exitCode,
    };
  }

  /** Release the PTY, the pages, and the screen. */
  async dispose() {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    this.pendingSize = undefined;
    try {
      await this.handle.terminate();
    } catch {
      /* already gone */
    }
    this.screen.dispose();
  }
}

/**
 * The per-conversation PTY pool and its route handlers.
 *
 * Free of Cordis services: `resolveProviders()` supplies `subprocess` and the
 * working directory, so the same class serves a tool call, a page request, and
 * a test.
 */
class LiveTerminals {
  /** @param options - logger, provider resolver, and emulator construction. */
  constructor(options) {
    this.options = options;
    /** sessionKey -> { session, opening }. */
    this.entries = new Map();
    /**
     * sessionKey -> pages watching that conversation.
     *
     * Kept on the pool rather than on a session because a page usually connects
     * BEFORE any terminal exists: the tab opens, subscribes, and only then does
     * the user (or the model) start a shell. A subscriber set owned by the
     * session would be empty at subscribe time and the terminal would come up
     * talking to nobody.
     */
    this.pages = new Map();
  }

  /** Normalize a caller-supplied session key. */
  static key(raw) {
    return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_KEY;
  }

  /**
   * Attach one page to a conversation.
   * @param rawKey - session key.
   * @param res - the SSE response.
   */
  attach(rawKey, res) {
    const key = LiveTerminals.key(rawKey);
    let set = this.pages.get(key);
    if (set === undefined) {
      set = new Set();
      this.pages.set(key, set);
    }
    set.add(res);
  }

  /**
   * Detach one page.
   * @param rawKey - session key.
   * @param res - the SSE response.
   */
  detach(rawKey, res) {
    const key = LiveTerminals.key(rawKey);
    const set = this.pages.get(key);
    if (set === undefined) return;
    set.delete(res);
    if (set.size === 0) this.pages.delete(key);
  }

  /**
   * Send one frame to every page watching a conversation.
   * @param rawKey - session key.
   * @param frame - the SSE payload.
   */
  publish(rawKey, frame) {
    const set = this.pages.get(LiveTerminals.key(rawKey));
    if (set === undefined) return;
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        set.delete(res);
      }
    }
  }

  /** The live session for one key, if any. */
  sessionFor(rawKey) {
    return this.entries.get(LiveTerminals.key(rawKey))?.session;
  }

  /** The live session for one key, or a failure the model can act on. */
  require(rawKey) {
    const session = this.sessionFor(rawKey);
    if (session === undefined) throw new Error('这个会话还没有打开实时终端。先调用 live_terminal_open。');
    return session;
  }

  /** Idle state for a key with no terminal yet. */
  idleSnapshot(rawKey) {
    return { state: 'idle', session: LiveTerminals.key(rawKey), pid: null, cwd: null };
  }

  /** Build a screen for the requested dimensions. */
  makeScreen(cols, rows) {
    const emulator = this.options.emulator;
    if (emulator?.Terminal !== undefined) {
      return new Screen({
        Terminal: emulator.Terminal,
        SerializeAddon: emulator.SerializeAddon,
        cols,
        rows,
        scrollback: SCROLLBACK,
      });
    }
    return new PlainScreen({ cols, rows });
  }

  /**
   * Keep at most {@link MAX_TERMINALS} live shells, dropping the least recently
   * active. A conversation nobody returned to should not hold a shell forever.
   * @param exceptKey - the key about to be opened.
   */
  async evictIfNeeded(exceptKey) {
    const live = [...this.entries.entries()].filter(([key, entry]) => key !== exceptKey && entry.session !== undefined);
    if (live.length < MAX_TERMINALS) return;
    live.sort((a, b) => a[1].session.lastActiveAt - b[1].session.lastActiveAt);
    const [key, entry] = live[0];
    this.entries.delete(key);
    await entry.session.dispose();
    this.options.logger?.info?.(`live-terminal: 回收闲置会话 ${key || '(默认)'} 的终端`);
  }

  /**
   * Start the session for one key when none is running.
   *
   * Concurrent callers share one spawn: two `live_terminal_open` calls in the
   * same step must not leave an orphan PTY behind.
   * @param rawKey - session key.
   * @param options - dimensions, shell override, directory, restart flag.
   */
  async open(rawKey, options = {}) {
    const key = LiveTerminals.key(rawKey);
    const entry = this.entries.get(key);
    if (entry?.session !== undefined && entry.session.status === 'running') {
      /* Already running: still say hello to a closed sidebar. */
      this.poke(key);
      return entry.session;
    }
    if (entry?.opening !== undefined) return entry.opening;
    if (entry?.session !== undefined) {
      if (options.restart !== true) {
        const previous = entry.session;
        throw new Error(
          `上一个实时终端已${previous.status === 'exited' ? `退出（退出码 ${previous.exitCode ?? '未知'}）` : '失败'}；要重开一个，调用时带上 restart: true。`,
        );
      }
      this.entries.delete(key);
      await entry.session.dispose();
    }
    await this.evictIfNeeded(key);
    const pending = { session: undefined, opening: undefined };
    pending.opening = (async () => {
      const { subprocess, cwd } = await this.options.resolveProviders(options.agent);
      const shell = await this.resolveShell(subprocess, options.shell);
      const cols = clampInt(options.cols, 2, 500, 120);
      const rows = clampInt(options.rows, 3, 200, 30);
      const directory = options.cwd ?? cwd;
      const handle = await subprocess.spawnTerminal({
        argv: [shell.path, ...shell.args],
        cwd: directory,
        cols,
        rows,
        terminalType: 'xterm-256color',
        graceMs: 2000,
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
      const session = new LiveSession({
        key,
        shell,
        handle,
        cols,
        rows,
        cwd: directory,
        screen: this.makeScreen(cols, rows),
        publish: (sessionKey, frame) => this.publish(sessionKey, frame),
      });
      pending.session = session;
      handle.output.setEncoding('utf8');
      handle.output.on('data', (chunk) => {
        const data = String(chunk);
        session.screen.write(data);
        session.revision += 1;
        session.lastActiveAt = Date.now();
        session.pending += data;
        session.scheduleFlush();
        session.notify();
      });
      handle.done.then(
        (outcome) => {
          session.status = 'exited';
          session.exitCode = outcome?.exitCode ?? null;
          session.broadcast({ type: 'state', ...session.snapshot() });
          session.broadcast({ type: 'note', at: Date.now(), text: `会话结束，退出码 ${session.exitCode ?? '未知'}` });
        },
        (error) => {
          session.status = 'failed';
          session.broadcast({ type: 'state', ...session.snapshot() });
          session.broadcast({ type: 'note', at: Date.now(), text: `会话异常：${String(error?.message ?? error)}` });
        },
      );
      session.broadcast({ type: 'state', ...session.snapshot() });
      /* Ask the UI to show this terminal when nobody is watching it. The signal
       * is advisory on both ends: the page decides whether the switch allows it,
       * and a closed sidebar simply keeps the screen for when it opens. */
      this.poke(key);
      /* Pages that connected before this terminal existed have been waiting with
       * no screen at all; hand them the current view now that there is one.
       *
       * The pending byte buffer is dropped first: those bytes are already part
       * of the snapshot, and shipping both would draw the opening lines twice. */
      session.pending = '';
      await session.screen.settled;
      const replay = session.screen.serialize();
      if (replay !== '') this.publish(key, { type: 'screen', data: replay });
      return session;
    })();
    this.entries.set(key, pending);
    try {
      return await pending.opening;
    } finally {
      pending.opening = undefined;
    }
  }

  /**
   * Resolve the shell through the session execution provider.
   *
   * On Windows the environment default is `cmd.exe`; the readable shells are
   * tried first. POSIX keeps its own default.
   * @param subprocess - the subprocess provider.
   * @param override - optional shell path.
   */
  async resolveShell(subprocess, override) {
    const environment = await subprocess.terminalEnvironment();
    const windows = environment.platform === 'windows';
    const candidates = [
      override,
      ...(windows
        ? ['pwsh', 'powershell', environment.defaultShell, 'cmd.exe']
        : [environment.defaultShell, process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']),
    ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
    const failures = [];
    for (const candidate of candidates) {
      try {
        const path = await subprocess.resolveExecutable(candidate);
        const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase();
        /* `-NonInteractive` keeps PowerShell's line editor from repainting every
         * keystroke; the emulator would show those repaints as flicker. */
        const args =
          name === 'cmd.exe' || name === 'cmd'
            ? []
            : name.startsWith('pwsh') || name.startsWith('powershell')
              ? ['-NoLogo', '-NoProfile', '-NonInteractive']
              : ['-i'];
        return { path, name, args };
      } catch (error) {
        failures.push(`${candidate}: ${String(error?.message ?? error)}`);
      }
    }
    throw new Error(`找不到可用的 shell（试过 ${failures.join('；')}）`);
  }

  /**
   * Wait until output stops, or the deadline passes.
   *
   * "Output stopped" is not the same as "the command finished": a shell echoes
   * the command line immediately, and a command that thinks, compiles, sleeps
   * or waits on the network says nothing for a while after that echo. Breaking
   * on the first quiet window therefore returned the echo alone and dropped the
   * result that landed a moment later — the reported "results are missing"
   * symptom.
   *
   * A `finished` probe makes quiet mean "keep waiting": the screen is inspected
   * after each quiet window and the wait goes on until the shell is back at its
   * prompt. Two cases must still return early, and `sawOutput` decides them:
   *
   * - nothing beyond the echo has appeared — the command is almost certainly
   *   still working, so keep waiting (this is the bug being fixed);
   * - the command printed something and then went quiet without a prompt — an
   *   interactive program (`ssh`, a REPL), so return what it printed rather
   *   than hanging until the deadline.
   *
   * Callers that pass no probe keep the plain "first quiet window wins"
   * behaviour.
   * @param session - the live session.
   * @param deadline - epoch millisecond bound.
   * @param idle - quiet window that ends the wait.
   * @param probe - optional `{ finished, sawOutput }` callbacks.
   */
  async collect(session, deadline, idle, probe) {
    let quiet = 0;
    while (Date.now() < deadline) {
      const seen = session.revision;
      await session.waitForOutput(Math.min(Date.now() + idle, deadline));
      /* The prompt probe runs on EVERY pass, not only on a quiet one: output
       * arrives in small chunks, so a command that finishes while its last
       * chunk is still landing would otherwise keep the loop waiting for a
       * silence that never comes. */
      if (probe !== undefined) {
        await session.screen.settled;
        if (probe.finished?.() === true) break;
      }
      if (session.revision !== seen) {
        quiet = 0;
        continue;
      }
      if (probe === undefined) break;
      quiet += 1;
      /* A program that talks but never returns a prompt is interactive; give
       * it a few windows to finish speaking, then hand back what it said. */
      if (quiet >= PROMPT_GRACE_WINDOWS && probe.sawOutput?.() === true) break;
      /* The prompt could not be recognized at all (an empty template, or a
       * shell whose prompt does not end in a terminator) and the command has
       * printed nothing. Waiting to the deadline would stall every such call;
       * a long, unbroken silence is the honest end here. */
      if (quiet >= SILENT_GIVE_UP_WINDOWS) break;
    }
  }

  /**
   * Ask the UI to show this terminal when nobody watches it.
   *
   * Every model-driven action goes through here — not just starting a session:
   * typing into an already-running terminal is exactly when a closed sidebar
   * must come back, which is what the auto-open switch promises. Once the tab
   * mounts and subscribes, later calls see the subscriber and stay quiet.
   * @param rawKey - session key.
   */
  poke(rawKey) {
    const key = LiveTerminals.key(rawKey);
    if (this.options.onUnwatched?.(key) === true) this.options.requestOpen?.(key);
  }

  /**
   * Type a line and return what it produced.
   *
   * The boundary is anchored on the CONTENT of the prompt row, not on a row
   * number: a panel resize reflows the buffer and renumbers every row, so a
   * numeric marker silently drifts and hands back stale rows above it. The
   * prompt row survives a reflow untouched (typed text appends after it), which
   * makes it a stable anchor.
   * @param rawKey - session key.
   * @param text - the line, without a trailing newline.
   * @param options - wait budgets.
   */
  async run(rawKey, text, options = {}) {
    const session = this.require(rawKey);
    if (session.status !== 'running') {
      throw new Error(
        `实时终端已${session.status === 'exited' ? '退出' : '失败'}；请调用 live_terminal_open（带 restart: true）重新打开。`,
      );
    }
    this.poke(rawKey);
    /* Settle the geometry first so the echo is captured at the width the
     * command actually ran at, then give the shell's repaint room to land
     * before the marker is taken. */
    const resized = session.flushResize();
    await session.screen.settled;
    if (resized) await session.waitForOutput(Date.now() + 250);
    await session.screen.settled;
    const before = session.screen.text(0);
    const anchor = before.slice(before.lastIndexOf('\n') + 1);
    session.lastActiveAt = Date.now();
    await session.handle.write(`${text}\r`);
    const deadline = Date.now() + clampInt(options.waitMs, 500, MAX_WAIT_MS, 30_000);
    await this.collect(session, deadline, clampInt(options.idleMs, 200, 10_000, IDLE_MS), {
      /* Only the bottom row is consulted, so this costs one row per check
       * instead of a full scrollback walk per output chunk. */
      finished: () => atPrompt(session.screen.lastLine(), anchor, text),
      /* Real output beyond the echo: an interactive program that will never
       * print another prompt is handed back after the grace windows. This one
       * only runs on a quiet pass, so the full scan it needs is affordable —
       * but it still short-circuits on the common case, where the last row is
       * still the echo itself. */
      sawOutput: () => {
        /* Cheap gate first: while the bottom row is still the echo (or a
         * blank), no output has been produced, so the full scrollback walk
         * below is skipped entirely. The expensive scan only runs once the
         * screen has actually moved past the command. */
        if (stillEcho(session.screen.lastLine(), anchor, text)) return false;
        const produced = sliceProduced(session.screen.text(0), anchor, text);
        return produced.split('\n').slice(1).some((line) => line.trim() !== '');
      },
    });
    await session.screen.settled;
    const produced = sliceProduced(session.screen.text(0), anchor, text);
    return bound(produced, clampInt(options.limit, 200, 200_000, DEFAULT_LIMIT));
  }

  /**
   * Close one conversation's terminal.
   * @param rawKey - session key.
   */
  async close(rawKey) {
    const key = LiveTerminals.key(rawKey);
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.entries.delete(key);
    if (entry.session !== undefined) await entry.session.dispose();
    return true;
  }

  /** Close every terminal; called on plugin unload. */
  async dispose() {
    for (const [, set] of this.pages) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
    }
    this.pages.clear();
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.session?.dispose()));
  }
}

/**
 * The "open the panel" signal channel.
 *
 * A page connects once, for the whole life of the tab, and stays connected even
 * when its panels are closed — that is the only channel the Host has to reach a
 * UI it does not own. Frames are tiny and one-way (Host → page), so a plain SSE
 * stream is the whole protocol.
 */
class SignalChannel {
  constructor() {
    /** @type {Set<import('node:http').ServerResponse>} */
    this.clients = new Set();
  }

  /** Attach one page. */
  attach(res) {
    this.clients.add(res);
  }

  /** Detach one page. */
  detach(res) {
    this.clients.delete(res);
  }

  /**
   * Ask every connected page to open the panel for one conversation.
   * @param key - session key.
   */
  requestOpen(key) {
    this.publish({ type: 'open', session: LiveTerminals.key(key), at: Date.now() });
  }

  /**
   * Send one frame to every connected page.
   * @param frame - the payload.
   */
  publish(frame) {
    if (this.clients.size === 0) return;
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** Release every page. */
  dispose() {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    this.clients.clear();
  }
}

/**
 * Build the control route handler.
 * @param pool - the terminal pool.
 * @param ctx - host plugin context; the request names its session when it has one.
 * @param diagnostics - reports what the settings page can see for this entry.
 * @param trace - ring buffer recording page-side self-reports.
 */
function controlHandler(pool, ctx, diagnostics, trace) {
  return async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    /* The page names the conversation it belongs to; a page with no scope (the
     * fallback main panel) addresses the default key, which the tools also use
     * when they cannot name an agent. */
    const requestedKey = url.searchParams.get('session') ?? DEFAULT_KEY;
    try {
      if (req.method === 'GET') {
        /* `?diag=1` reports what the settings page can actually see for this
         * entry: `describe()` only lists an entry whose Config declares at
         * least one volatile field, so an absent namespace is the difference
         * between "the form is empty" and "the form renders but says nothing". */
        if (url.searchParams.get('diag') === '1') {
          send(200, diagnostics?.() ?? { error: 'no diagnostics hook' });
          return;
        }
        const session = pool.sessionFor(requestedKey);
        send(200, session === undefined ? pool.idleSnapshot(requestedKey) : session.snapshot());
        return;
      }
      if (req.method !== 'POST') {
        send(405, { error: 'use GET to read or POST to act' });
        return;
      }
      const body = await readJson(req);
      const action = String(body.action ?? '');
      const key = typeof body.session === 'string' ? body.session : requestedKey;
      if (action === 'trace') {
        /* Page-side self-report, read through ?diag=1. A failing EventSource on
         * the page is otherwise invisible: the server sees no request at all. */
        trace.push({ at: Date.now(), tag: String(body.tag ?? ''), detail: String(body.detail ?? '').slice(0, 1200) });
        if (trace.length > 12) trace.splice(0, trace.length - 12);
        send(200, { ok: true });
        return;
      }
      if (action === 'start') {
        /* The page cannot know the conversation's working directory: it reaches
         * the host through a route, where no agent scope is visible. `cwd` rides
         * the request so a panel-started shell opens where the conversation
         * lives instead of wherever the host process happens to sit. */
        const session = await pool.open(key, {
          cols: body.cols,
          rows: body.rows,
          restart: body.restart === true,
          cwd: typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : undefined,
        });
        send(200, { ...session.snapshot() });
        return;
      }
      if (action === 'input') {
        const text = String(body.data ?? '');
        if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
          send(413, { error: 'input too large' });
          return;
        }
        const session = pool.sessionFor(key);
        if (session === undefined || session.status !== 'running') {
          send(409, { error: 'terminal is not running' });
          return;
        }
        session.lastActiveAt = Date.now();
        /* Raw bytes, unmodified: an arrow key, a Ctrl-C and a bracketed paste
         * all have to arrive exactly as xterm encoded them. */
        await session.handle.write(text);
        send(200, { ok: true });
        return;
      }
      if (action === 'resize') {
        const session = pool.require(key);
        /* Queued, not applied: see LiveSession.requestResize — a drag must
         * reach the PTY as one resize, not one per pixel. */
        session.requestResize(
          clampInt(body.cols, 2, 500, session.cols),
          clampInt(body.rows, 3, 200, session.rows),
        );
        send(200, { ok: true });
        return;
      }
      if (action === 'signal') {
        const session = pool.require(key);
        const name = String(body.signal ?? 'SIGINT').toUpperCase();
        if (!['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'].includes(name)) {
          send(400, { error: `unsupported signal ${name}` });
          return;
        }
        const delivered = await session.handle.signalForeground(name);
        send(200, { ok: true, targetPgid: delivered });
        return;
      }
      if (action === 'clear') {
        const session = pool.require(key);
        const result = await session.clearScreen();
        send(200, { ok: true, ...result });
        return;
      }
      if (action === 'stop') {
        send(200, { ok: await pool.close(key) });
        return;
      }
      send(400, { error: `unknown action ${JSON.stringify(action)}` });
    } catch (error) {
      ctx.logger?.warn?.(`live-terminal: ${req.method} ${url.pathname}：${String(error?.message ?? error)}`);
      send(500, { error: String(error?.message ?? error) });
    }
  };
}

/**
 * Build the raw output stream handler.
 *
 * The page stays subscribed for its whole lifetime, whether or not a terminal
 * exists yet: a tab that opens before the shell is started still receives the
 * first screen when the shell appears.
 * @param pool - the terminal pool.
 */
function streamHandler(pool) {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = url.searchParams.get('session') ?? DEFAULT_KEY;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    pool.attach(key, res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* the close handler cleans up */
      }
    }, 20_000);
    heartbeat.unref?.();
    const leave = () => {
      clearInterval(heartbeat);
      pool.detach(key, res);
    };
    /* `res`, not `req`: a GET request stream is already complete when the
     * handler runs, so `req.close` fires immediately and would detach a live
     * subscriber that then reports "connected" and never receives a byte. */
    res.on('close', leave);
    res.on('error', leave);
    const session = pool.sessionFor(key);
    void (async () => {
      if (session !== undefined) {
        /* Already running: replay the screen so a late or reconnecting page
         * lands on the current view instead of the next live byte. */
        await session.screen.settled;
        const replay = session.screen.serialize();
        try {
          if (replay !== '') res.write(`data: ${JSON.stringify({ type: 'screen', data: replay })}\n\n`);
        } catch {
          leave();
          return;
        }
      }
      try {
        res.write(`data: ${JSON.stringify({ type: 'state', ...(session === undefined ? pool.idleSnapshot(key) : session.snapshot()) })}\n\n`);
      } catch {
        leave();
      }
    })();
  };
}

/**
 * Build the panel-signal stream handler.
 * @param channel - the signal channel.
 */
function signalHandler(channel) {
  return (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    channel.attach(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* the close handler cleans up */
      }
    }, 25_000);
    heartbeat.unref?.();
    const leave = () => {
      clearInterval(heartbeat);
      channel.detach(res);
    };
    /* `res`, not `req`: see streamHandler — a GET request stream is already
     * complete when this runs, so `req.close` would detach immediately. */
    res.on('close', leave);
    res.on('error', leave);
  };
}

/**
 * Serve the vendored browser terminal.
 *
 * The client bundle loader only hands out registered modules, and the package
 * asset route serves images, so the emulator ships as files this plugin reads
 * from its own directory.
 * @param ctx - host plugin context, for the logger.
 */
function vendorHandler(ctx) {
  const files = new Map([
    ['/xterm.js', { path: fileURLToPath(new URL('./vendor/xterm.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
    ['/xterm.css', { path: fileURLToPath(new URL('./vendor/xterm.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
    ['/addon-fit.js', { path: fileURLToPath(new URL('./vendor/addon-fit.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
    ['/addon-webgl.js', { path: fileURLToPath(new URL('./vendor/addon-webgl.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ]);
  return async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const suffix = path.startsWith(VENDOR_PATH) ? path.slice(VENDOR_PATH.length) : '';
    const file = files.get(suffix);
    if (file === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unknown asset');
      return;
    }
    try {
      const body = await readFile(file.path);
      res.writeHead(200, {
        'content-type': file.type,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
    } catch (error) {
      ctx.logger?.warn?.(`live-terminal: 读取 ${file.path} 失败：${String(error?.message ?? error)}`);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('asset unavailable');
    }
  };
}

/** Output shape for a tool that answers with text. */
function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  };
}

/** Decode the small escape vocabulary a model writes into `live_terminal_send`. */
function decodeEscapes(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|r|n|t|e|a)/gu, (token, body) => {
    if (body === 'r') return '\r';
    if (body === 'n') return '\n';
    if (body === 't') return '\t';
    if (body === 'e') return '\u001b';
    if (body === 'a') return '\u0007';
    return String.fromCharCode(Number.parseInt(body.slice(1), 16));
  });
}

/**
 * Slice the text a command produced, anchored on the row it was typed at.
 *
 * Row numbers drift when the panel reflows on a resize; the row's TEXT does
 * not. The anchor is the prompt row before typing — typed characters append
 * after it, so the anchor marks where the new content begins.
 *
 * The anchor matches EVERY prompt row, including the fresh one the command's
 * completion prints at the very end — slicing from that one yields nothing. The
 * wanted occurrence is therefore the last one that is still FOLLOWS by content
 * (the echo, then the output). Falls back to the whole text when no occurrence
 * fits, which is stale but honest.
 * @param text - the full screen text after the command.
 * @param anchor - the prompt row captured before typing.
 */
function sliceAfterAnchor(text, anchor) {
  if (anchor === undefined || anchor.trim() === '') return text;
  let pick = -1;
  for (let at = text.indexOf(anchor); at >= 0; at = text.indexOf(anchor, at + 1)) {
    if (at + anchor.length < text.length) pick = at;
  }
  if (pick < 0) pick = text.lastIndexOf(anchor);
  return pick < 0 ? text : text.slice(pick + anchor.length);
}

/**
 * Slice the text one command produced.
 *
 * The echoed command line is the first choice: it is written by us at
 * execution time and survives a mid-run reflow even when the prompt row it was
 * typed at does not — a resize makes the shell redraw that row at coordinates
 * that can be stale, and the redraw is exactly what destroys the anchor. The
 * match is line-anchored (only whitespace before, nothing after) so a short
 * command like `ls` cannot latch onto ordinary output.
 *
 * A command longer than the pane is echoed ACROSS ROWS, and then it never
 * appears on one line at all. Requiring the whole line is what made this fall
 * through to the prompt anchor — and the anchor sits on the OLD prompt, above
 * the echo, so the slice led with the echoed command and looked like "only the
 * echo came back". The wrap-aware step below matches the command's FIRST
 * segment after the prompt and cuts at the echo's end instead.
 *
 * Falls back to the prompt-row anchor, then to the whole text.
 * @param text - the full screen text after the command.
 * @param anchor - the prompt row captured before typing.
 * @param command - the line that was typed.
 */
function sliceProduced(text, anchor, command) {
  const safe = String(command).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (safe !== '') {
    const pattern = new RegExp(`(^|\\n)[ \\t]*${safe}(?=\\n|$)`, 'gu');
    let pick = -1;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      pick = match.index + match[1].length;
    }
    if (pick >= 0) return text.slice(pick);

    /* Wrapped echo: find the row that begins with the command's first segment
     * right after a prompt, then skip the rows the echo occupies. */
    const wrapped = wrappedEchoEnd(text, command);
    if (wrapped >= 0) return text.slice(wrapped);
  }
  return sliceAfterAnchor(text, anchor);
}

/**
 * End offset of a command echoed across several rows.
 *
 * A wrapped echo prints the command's characters without any newline of its
 * own — the terminal wraps them — so the echo is identified by matching the
 * command's opening characters after a prompt row and then walking forward
 * through the text until the whole command has been consumed. Everything from
 * there on is output.
 *
 * Windows line endings are normalised out first: the emulator separates rows
 * with `\n`, and a `\r` inside a wrapped echo would break the character walk.
 * @param text - the full screen text after the command.
 * @param command - the line that was typed.
 * @returns the offset just past the echo, or -1 when no echo is found.
 */
function wrappedEchoEnd(text, command) {
  const typed = String(command);
  if (typed.trim() === '') return -1;
  /* The first segment is what visibly follows the prompt on the echo row. */
  const head = typed.slice(0, Math.min(24, typed.length)).trimEnd();
  if (head === '') return -1;
  const stray = head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)[^\\n]*?(?:[$#>\u276f\u00bb\u203a] )?([ \\t]*${stray})`, 'gu');
  /* The LAST occurrence, not the first: the scrollback still holds earlier
   * commands, and two commands that open the same way (`Start-Sleep …`) would
   * otherwise anchor this slice on the previous one — which is what returned a
   * stale echo plus its neighbour's tail. The newest echo is the one that
   * belongs to this invocation. */
  let match = null;
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) match = found;
  if (match === null) return -1;
  /* Walk from the start of that segment until every character of the command
   * has been consumed, stepping over the row separators the terminal inserted. */
  let at = match.index + (match[1].length === 0 ? 0 : match[0].length - match[1].length);
  let remaining = typed.length;
  while (at < text.length && remaining > 0) {
    if (text[at] === '\n') {
      at += 1;
      continue;
    }
    at += 1;
    remaining -= 1;
  }
  /* The echo may have been padded with blanks to the row's end; skip them and
   * the row break so the result starts on the first output row. */
  while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at += 1;
  if (text[at] === '\n') at += 1;
  return at;
}

/**
 * Whether the shell is back at its prompt, judged from the LAST non-blank line.
 *
 * Two traps make a naive "last line starts with the prompt" test unusable:
 *
 * - the echoed command line itself starts with the prompt (`PS C:\…> ls`), and
 *   during the silent stretch after the echo that line IS the last line, so it
 *   would read as finished — the exact moment the wait must continue;
 * - a wrapped echo puts the continuation on lines that start with neither.
 *
 * The prompt is therefore what remains once the typed command is stripped: a
 * last line that is the prompt and nothing else. `atPrompt` asks for the row
 * the command was typed at (its stable prefix) and the command text, so the
 * echo can be recognized instead of mistaken for a fresh prompt.
 *
 * A blank template (the terminal was empty when the command was typed) cannot
 * be recognized at all; the caller falls back to its grace windows.
 * @param lastLine - the buffer's last non-blank row (`Screen.lastLine()`, not
 *   the whole screen: the wait loop asks this on every output chunk, and a full
 *   scan per chunk is what pinned the Host's event loop).
 * @param template - the prompt row captured before typing.
 * @param command - the line that was typed.
 */
function atPrompt(lastLine, template, command) {
  const prompt = promptTemplate(template);
  if (prompt === '') return false;
  const line = String(lastLine ?? '').replace(/\s+$/u, '');
  if (line.trim() === '') return false;
  if (!line.startsWith(prompt)) return false;
  const rest = line.slice(prompt.length).trim();
  /* Only the prompt: the shell is idle. */
  if (rest === '') return true;
  /* The prompt followed by this very command is the ECHO, not a new prompt —
   * unless the command has since been echoed a second time, which is what
   * completion looks like (`…> cmd` …output… `…> `). */
  return false;
}

/**
 * Whether the bottom row is still this command's echo — i.e. no real output
 * has appeared yet.
 *
 * Used as a cheap gate in front of the full-scrollback scans: an interactive
 * program keeps the wait loop asking "did it print anything?" on every quiet
 * window, and while the answer is "no, still just the echo" there is no reason
 * to walk 5000 rows to find out. A blank row, a row that does not carry the
 * prompt, or a row that carries only the prompt all count as "no output".
 *
 * The echo test is the same one `atPrompt` relies on: prompt prefix followed
 * by (the beginning of) the typed command. Once the bottom row moves past
 * that, output exists and the caller does the full scan.
 * @param lastLine - the buffer's last non-blank row (`Screen.lastLine()`).
 * @param template - the prompt row captured before typing.
 * @param command - the line that was typed.
 */
function stillEcho(lastLine, template, command) {
  const line = String(lastLine ?? '').replace(/\s+$/u, '');
  if (line.trim() === '') return true;
  const prompt = promptTemplate(template);
  if (prompt === '') return false;
  if (!line.startsWith(prompt)) return false;
  const rest = line.slice(prompt.length).trim();
  /* The bare prompt, or the prompt followed by (a prefix of) the command. */
  return rest === '' || String(command).startsWith(rest);
}

/**
 * Distill a prompt row into the stable prefix a later prompt must repeat.
 *
 * Everything after the visible prompt is dropped: a directory that changes, a
 * branch, or the echoed command itself. The `>`/`$`/`#` that ends a prompt is
 * kept, which is what makes `C:\>` and `PS C:\…>` recognizable while ordinary
 * output lines — with no such terminator — are not.
 * @param template - the prompt row captured before typing.
 */
function promptTemplate(template) {
  const trimmed = String(template ?? '').replace(/\s+$/u, '');
  if (trimmed === '') return '';
  /* Keep up to and including the first prompt terminator; a row without one is
   * not a prompt (an empty first row, a banner) and yields nothing. */
  const at = trimmed.search(/[$#>\u276f\u00bb\u203a]\s*/u);
  if (at < 0) return '';
  return trimmed.slice(0, at + 1);
}

/**
 * Bound a tool result. Under `limit` the text is whole; over it, the head and
 * the tail survive and the omission is marked, so a long listing stays readable
 * without the whole file ever reaching the model.
 * @param text - candidate result.
 * @param limit - maximum characters to return.
 */
function bound(text, limit) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 3);
  const tail = limit - head;
  return `${text.slice(0, head)}\n…[已省略 ${text.length - head - tail} 字符]…\n${text.slice(-tail)}`;
}

/**
 * Register the live terminal: the pool, the routes, and the model-facing tools.
 * @param ctx - host plugin context.
 * @param config - the resolved Loader-row config (the settings form's values).
 */
export function apply(ctx, config) {
  const logger = ctx.logger;
  /** Whether the model may ask the UI to open the panel. On by default: a
   *  feature nobody knows about is a feature nobody uses; the switch lets a
   *  user turn it off once the panel has interrupted them. */
  let autoOpenPanel = config?.autoOpenPanel !== false;
  const signals = new SignalChannel();
  const emulator = loadEmulator();
  if (emulator.Terminal === undefined) {
    logger?.warn?.(
      'live-terminal: 没有找到 @xterm/headless，退回纯文本模式（vim / ssh 这类全屏程序无法正确显示）。' +
        `尝试过的位置：${(emulator.failures ?? []).join('；')}`,
    );
  }

  /**
   * Resolve the execution providers for one caller.
   * @param agent - the calling agent, when the caller is a tool.
   */
  const resolveProviders = async (agent) => {
    const scope = agent?.ctx ?? ctx;
    const subprocess = scope.get?.('subprocess') ?? ctx.get?.('subprocess');
    if (subprocess === undefined) {
      throw new Error('subprocess provider 缺失：这个 profile 没有挂载本地子进程服务。');
    }
    const workingDirectory = scope.get?.('workingDirectory') ?? ctx.get?.('workingDirectory');
    let cwd = workingDirectory?.defaultDirectory ?? process.cwd();
    if (workingDirectory !== undefined && agent !== undefined) {
      try {
        cwd = await workingDirectory.ensure(agent);
      } catch (error) {
        logger?.warn?.(`live-terminal: 取会话工作目录失败，退回默认目录：${String(error?.message ?? error)}`);
      }
    }
    return { subprocess, cwd };
  };

  const pool = new LiveTerminals({
    logger,
    emulator,
    resolveProviders,
    /* "Unwatched" means no page is subscribed to this conversation's stream —
     * either the tab was never opened or the right sidebar is closed. */
    onUnwatched: (key) => autoOpenPanel && (pool.pages.get(LiveTerminals.key(key))?.size ?? 0) === 0,
    requestOpen: (key) => signals.requestOpen(key),
  });

  /** Page-side self-reports, newest last (see the `trace` control action). */
  const trace = [];

  /* Routes first: the panel must find its endpoint even when no session exists,
   * which is exactly how it learns the session is idle. */
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: CONTROL_PATH, handler: controlHandler(pool, ctx, () => ({
    configExported: Config !== undefined,
    configSchema: Config === undefined ? null : Config.toJSON(),
    autoOpenPanel,
    /* Per-conversation page subscribers: a nonzero count means the tab is
     * mounted and watching, which is exactly when an auto-open must NOT fire. */
    pageSubscribers: Object.fromEntries([...pool.pages].map(([key, set]) => [key, set.size])),
    signalClients: signals.clients.size,
    /* What the page reports about its own signal connection. */
    pageTrace: trace,
    settingsNamespaces: (() => {
      try {
        return (ctx.get?.('settings')?.describe?.() ?? []).map((row) => row.ns);
      } catch (error) {
        return `describe() failed: ${String(error?.message ?? error)}`;
      }
    })(),
    entryIds: (() => {
      try {
        return (ctx.configEditor?.entries?.() ?? []).map((entry) => entry.options?.id);
      } catch {
        return 'entries() unavailable';
      }
    })(),
  }), trace) }), 'live-terminal: control route');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: STREAM_PATH, handler: streamHandler(pool) }),
    'live-terminal: stream route');
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: VENDOR_PATH, handler: vendorHandler(ctx) }),
    'live-terminal: vendor route');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: SIGNAL_PATH, handler: signalHandler(signals) }),
    'live-terminal: signal route');

  /* A settings save reaches the running plugin here, so flipping the switch
   * takes effect without a reload. */
  /* A settings save reaches the running plugin here.
   *
   * `settings/document-updated(ns, revision)` carries no value — it only says
   * "this entry's document changed" — so the new value is read from
   * `settings.describe()`, which reports each entry's live `value`. Reading on
   * demand also avoids keeping a second copy of the config that could drift. */
  const settings = ctx.get?.('settings');
  if (settings !== undefined && typeof settings.describe === 'function') {
    ctx.effect(() => {
      const off = ctx.on?.('settings/document-updated', (ns) => {
        let entry;
        try {
          entry = settings.describe().find((row) => row.ns === ns);
        } catch {
          return;
        }
        const next = entry?.value?.autoOpenPanel;
        if (typeof next === 'boolean') autoOpenPanel = next;
      });
      return () => {
        if (typeof off === 'function') off();
      };
    }, 'live-terminal: follow the settings form');
  }
  /** The conversation a tool call belongs to. */
  const keyOf = (agent) => (typeof agent?.id === 'string' ? agent.id : DEFAULT_KEY);

  ctx.tools.register({
    name: 'live_terminal_open',
    description:
      'Open the live terminal for the current conversation — the one the user watches in their right sidebar. Call it before live_terminal_run; calling it while a session is running reports that session instead of starting a second one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cols: { type: 'integer', description: 'Width in columns (default 120).' },
        rows: { type: 'integer', description: 'Height in rows (default 30).' },
        restart: {
          type: 'boolean',
          description: 'Replace a session that has already exited (default false, which reports the exit instead).',
        },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const session = await pool.open(keyOf(exec?.agent), {
        cols: args?.cols,
        rows: args?.rows,
        restart: args?.restart === true,
        agent: exec?.agent,
      });
      session.broadcast({ type: 'note', at: Date.now(), text: `会话就绪：${session.shell.name}（pid ${session.pid ?? '未知'}）` });
      const mode = session.screen instanceof Screen ? 'xterm 模拟器（支持 ssh / vim / tmux）' : '纯文本模式';
      return {
        text:
          `实时终端已就绪。\n` +
          `shell: ${session.shell.name}\n` +
          `cwd: ${session.cwd}\n` +
          `pid: ${session.pid ?? '未知'}\n` +
          `渲染: ${mode}\n` +
          `用户在当前会话的右侧栏里能实时看到输入与输出，也能直接在里面敲。`,
      };
    },
    presentCall: () => ({ card: 'terminal', title: '打开实时终端' }),
  });

  ctx.tools.register({
    name: 'live_terminal_run',
    description:
      'Type one line into the current conversation’s live terminal and return the text this command printed — not the whole screen. It waits until the shell is back at its prompt, so a command that goes quiet for a while before printing still returns its output. Prefer this over the sandboxed shell when the user should watch the command run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'The line to type, normally a shell command.' },
        waitMs: { type: 'integer', description: 'Longest wait for quiet output in milliseconds (default 30000).' },
        limit: {
          type: 'integer',
          description: 'How many characters of output to return (default 6000). Longer output keeps its head and tail and elides the middle; pass more to see more.',
        },
      },
      required: ['command'],
    },
    output: textOutput(),
    async execute(args, exec) {
      const key = keyOf(exec?.agent);
      const session = pool.require(key);
      session.broadcast({ type: 'note', at: Date.now(), text: `▶ ${args.command}` });
      const text = await pool.run(key, String(args.command), { waitMs: args.waitMs, limit: args.limit });
      return { text: text === '' ? '(没有输出)' : text };
    },
    presentCall: (args) => ({ card: 'terminal', title: String(args?.command ?? 'live_terminal_run').slice(0, 200) }),
  });

  ctx.tools.register({
    name: 'live_terminal_send',
    description:
      'Write raw bytes into the live terminal without pressing Enter and without waiting. Use it for a REPL, an interactive prompt, an arrow key, or a control key (\\u0003 for Ctrl-C).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Literal text; \\r, \\n, \\t, \\u0003 and \\x1b escapes are interpreted.' },
        submit: { type: 'boolean', description: 'Append Enter (default false).' },
        waitMs: {
          type: 'integer',
          description: 'How long to collect the reply in milliseconds (default 1000, 0 to answer immediately).',
        },
      },
      required: ['text'],
    },
    output: textOutput(),
    async execute(args, exec) {
      const key = keyOf(exec?.agent);
      const session = pool.require(key);
      pool.poke(key);
      const decoded = decodeEscapes(String(args.text));
      await session.screen.settled;
      /* Content anchor, same reason as `run`: row numbers drift on a reflow. */
      const before = session.screen.text(0);
      const anchor = before.slice(before.lastIndexOf('\n') + 1);
      session.lastActiveAt = Date.now();
      await session.handle.write(args.submit === true ? `${decoded}\r` : decoded);
      session.broadcast({ type: 'note', at: Date.now(), text: `▶ ${JSON.stringify(decoded)}` });
      const wait = clampInt(args.waitMs, 0, 30_000, 1000);
      if (wait > 0) {
        /* Only a submitted line is a shell command whose completion a prompt
         * reports. Raw bytes (a REPL keystroke, a password, an arrow key) leave
         * the screen wherever the program put it, so they keep the plain
         * quiet-window wait. */
        const probe =
          args.submit === true
            ? {
                finished: () => atPrompt(session.screen.lastLine(), anchor, decoded),
                sawOutput: () => {
                  /* Same cheap gate as `run`: don't walk the scrollback while
                   * the bottom row is still the echo. */
                  if (stillEcho(session.screen.lastLine(), anchor, decoded)) return false;
                  const produced = sliceAfterAnchor(session.screen.text(0), anchor);
                  return produced.split('\n').slice(1).some((line) => line.trim() !== '');
                },
              }
            : undefined;
        await pool.collect(session, Date.now() + wait, 600, probe);
      }
      await session.screen.settled;
      if (wait === 0) return { text: '(已发送)' };
      const text = sliceAfterAnchor(session.screen.text(0), anchor);
      return { text: text === '' ? '(没有新输出)' : bound(text, DEFAULT_LIMIT) };
    },
    presentCall: (args) => ({ card: 'terminal', title: `发送 ${JSON.stringify(args?.text ?? '')}`.slice(0, 200) }),
  });

  ctx.tools.register({
    name: 'live_terminal_read',
    description:
      'Read the live terminal screen without sending anything, for output that scrolled past or for what the user typed themselves.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'integer',
          description: 'How many characters of the screen to return (default 6000). Longer screens keep their head and tail and elide the middle; pass more to see more.',
        },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const session = pool.sessionFor(keyOf(exec?.agent));
      if (session === undefined) return { text: '(这个会话还没有打开实时终端)' };
      await session.screen.settled;
      const text = session.screen.text(0);
      const body = bound(text, clampInt(args?.limit, 200, 200_000, DEFAULT_LIMIT));
      return { text: `${body}\n\n[状态 ${session.status}；目录 ${session.cwd}]` };
    },
    presentCall: () => ({ card: 'terminal', title: '读取实时终端' }),
  });

  ctx.tools.register({
    name: 'live_terminal_signal',
    description:
      'Interrupt the live terminal: deliver SIGINT (Ctrl-C), SIGTERM, or SIGTSTP to its foreground process group.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        signal: { type: 'string', description: 'One of SIGINT (default), SIGTERM, SIGKILL, SIGTSTP, SIGHUP.' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const key = keyOf(exec?.agent);
      const session = pool.require(key);
      pool.poke(key);
      const name = String(args?.signal ?? 'SIGINT').toUpperCase();
      const delivered = await session.handle.signalForeground(name);
      session.broadcast({ type: 'note', at: Date.now(), text: `${name} → 前台进程组 ${delivered}` });
      return { text: `${name} 已送达进程组 ${delivered}` };
    },
    presentCall: (args) => ({ card: 'terminal', title: `${String(args?.signal ?? 'SIGINT')}（实时终端）` }),
  });

  ctx.tools.register({
    name: 'live_terminal_close',
    description:
      'Close the current conversation’s live terminal and end its shell. Call it when the session is no longer needed.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput(),
    async execute(_args, exec) {
      return { text: (await pool.close(keyOf(exec?.agent))) ? '实时终端已关闭。' : '当前没有打开实时终端。' };
    },
    presentCall: () => ({ card: 'terminal', title: '关闭实时终端' }),
  });

  /* Unload must not leave live shells or attached pages behind. */
  ctx.effect(() => () => {
    signals.dispose();
    void pool.dispose();
  }, 'live-terminal: teardown');

  logger?.info?.(`live-terminal: ready（${emulator.Terminal === undefined ? '纯文本模式' : 'xterm 模拟器'}，按会话隔离）`);
}

/** Both services are hard dependencies: the row exists only where they do. */
export const inject = ['tools', 'webServer'];
