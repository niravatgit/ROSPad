/**
 * terminal.js — Multi-session xterm.js terminal with bash-like line editing
 *
 * Bug fix: xterm onKey `key` param includes '\r', '\x7f', etc. — we must
 * check charCode >= 32 && !== 127 before treating a key as printable text.
 */

// ── Shared xterm theme / options ──────────────────────────────────────────────
const _xtermThemeDark = {
  background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff',
  black: '#0d1117',    brightBlack: '#3d444d',
  red: '#f85149',      brightRed: '#ff7b72',
  green: '#3fb950',    brightGreen: '#56d364',
  yellow: '#d29922',   brightYellow: '#e3b341',
  blue: '#1f6feb',     brightBlue: '#58a6ff',
  magenta: '#8957e5',  brightMagenta: '#bc8cff',
  cyan: '#39c5cf',     brightCyan: '#56d4dd',
  white: '#8b949e',    brightWhite: '#e6edf3',
};
const _xtermThemeLight = {
  background: '#f6f8fa', foreground: '#24292f', cursor: '#0969da',
  black: '#24292f',    brightBlack: '#57606a',
  red: '#cf222e',      brightRed: '#a40e26',
  green: '#1a7f37',    brightGreen: '#116329',
  yellow: '#9a6700',   brightYellow: '#7d4e00',
  blue: '#0969da',     brightBlue: '#0550ae',
  magenta: '#8250df',  brightMagenta: '#6639ba',
  cyan: '#0969da',     brightCyan: '#0550ae',
  white: '#57606a',    brightWhite: '#24292f',
};
const XTERM_OPTIONS = {
  theme: localStorage.getItem('rospad-theme') === 'light' ? _xtermThemeLight : _xtermThemeDark,
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: 12,
  lineHeight: 1.4,
  cursorBlink: true,
  allowTransparency: true,
  scrollback: 2000,
  convertEol: true,
};

const CWD            = '/rospad-workspace';
const PROMPT_ANSI    = `\x1b[32mstudent@rospad\x1b[0m:\x1b[34m~/ws\x1b[0m$ `;
const PROMPT_PLAIN   = `student@rospad:~/ws$ `;

// Resolve a cd argument relative to cwd, clamped to 'src' as the workspace root.
function _resolveCwd(base, arg) {
  if (!arg || arg === '~') return 'src';
  const segs = arg.startsWith('/')
    ? arg.slice(1).split('/')
    : [...base.split('/'), ...arg.split('/')];
  const out = [];
  for (const s of segs) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  if (!out.length || out[0] !== 'src') out.unshift('src');
  return out.join('/') || 'src';
}

// ── Message templates for ros2 topic pub ─────────────────────────────────────
const MSG_TEMPLATES = {
  'geometry_msgs/Twist':        '{"linear":{"x":0.5,"y":0.0,"z":0.0},"angular":{"x":0.0,"y":0.0,"z":0.0}}',
  'geometry_msgs/PoseStamped':  '{"header":{"frame_id":"map"},"pose":{"position":{"x":1.0,"y":0.0,"z":0.0},"orientation":{"x":0.0,"y":0.0,"z":0.0,"w":1.0}}}',
  'geometry_msgs/Vector3':      '{"x":0.0,"y":0.0,"z":0.0}',
  'geometry_msgs/Point':        '{"x":0.0,"y":0.0,"z":0.0}',
  'std_msgs/String':            '{"data":"hello"}',
  'std_msgs/Bool':              '{"data":true}',
  'std_msgs/Float32':           '{"data":0.0}',
  'std_msgs/Float64':           '{"data":0.0}',
  'std_msgs/Int32':             '{"data":0}',
  'sensor_msgs/JointState':     '{"name":["joint1"],"position":[0.0],"velocity":[0.0],"effort":[0.0]}',
  'sensor_msgs/LaserScan':      '{"angle_min":0.0,"angle_max":6.28,"angle_increment":0.01745,"range_min":0.1,"range_max":5.0,"ranges":[],"intensities":[]}',
  'nav_msgs/Odometry':          '{"pose":{"position":{"x":0.0,"y":0.0,"z":0.0},"orientation":{"x":0.0,"y":0.0,"z":0.0,"w":1.0}},"twist":{"linear":{"x":0.0},"angular":{"z":0.0}}}',
};

function _msgTemplate(type) {
  if (!type) return '{}';
  // Exact match first
  if (MSG_TEMPLATES[type]) return MSG_TEMPLATES[type];
  // Strip /msg/ variant: geometry_msgs/msg/Twist → geometry_msgs/Twist
  const norm = type.replace('/msg/', '/');
  if (MSG_TEMPLATES[norm]) return MSG_TEMPLATES[norm];
  // Short name fallback: 'Twist' → find first key ending in '/Twist'
  const shortKey = Object.keys(MSG_TEMPLATES).find(k => k.endsWith('/' + type));
  if (shortKey) return MSG_TEMPLATES[shortKey];
  return '{}';
}

// ── TerminalSession ───────────────────────────────────────────────────────────
class TerminalSession {
  constructor(id, label = null) {
    this.id          = id;
    this.label       = label ?? `Terminal ${id}`;
    this.xterm       = null;
    this.fitAddon    = null;
    this.pane        = null;   // DOM div
    this.nodeManager = null;
    this.ros2cli     = null;

    // Line editor state
    this._buf     = '';
    this._cur     = 0;
    this._history = [];
    this._histIdx = -1;

    // Current working directory within the user's workspace (relative, rooted at 'src')
    this._cwd     = 'src';
  }

  // Dynamic prompt — updates when _cwd changes
  get _prompt() {
    return `\x1b[32mstudent@rospad\x1b[0m:\x1b[34m~/ws${this._cwd.slice(3)}\x1b[0m$ `;
  }

  // ── Mount into the viewport ──────────────────────────────────────────────

  mount() {
    // Create pane div
    this.pane = document.createElement('div');
    this.pane.className = 'term-pane';
    this.pane.id = `term-pane-${this.id}`;
    document.getElementById('terminal-viewport').appendChild(this.pane);

    // Create xterm
    this.xterm = new Terminal(XTERM_OPTIONS);
    this.fitAddon = new FitAddon.FitAddon();
    this.xterm.loadAddon(this.fitAddon);
    this.xterm.open(this.pane);

    // Patch write / writeln to always scroll to bottom
    const origWrite   = this.xterm.write.bind(this.xterm);
    const origWriteln = this.xterm.writeln.bind(this.xterm);
    this.xterm.write   = (t) => { origWrite(t);   this.xterm.scrollToBottom(); };
    this.xterm.writeln = (t) => { origWriteln(t); this.xterm.scrollToBottom(); };

    // NodeManager + ROS2CLI bound to this session's xterm
    this.nodeManager = new NodeManager(rosBus, this.xterm);
    this.nodeManager.onWorkersChange = () => { window._updateRunState?.(); };
    this.ros2cli     = new ROS2CLI(rosBus, this.xterm, this.nodeManager);

    this._initKeys();
    this._fit();

    // Auto-fit on pane resize
    new ResizeObserver(() => this._fit()).observe(this.pane);
  }

  _fit() {
    if (!this.pane.classList.contains('active')) return;
    // Debounce: collapse rapid calls (window resize fires continuously)
    clearTimeout(this._fitTimer);
    this._fitTimer = setTimeout(() => {
      // Guard: fitAddon throws if the container has 0 dimensions (e.g. during
      // Chrome snap/restore). A throw corrupts xterm's internal state and
      // silently breaks keyboard input — catch it and skip.
      const h = this.pane.clientHeight;
      const w = this.pane.clientWidth;
      if (h < 10 || w < 10) return;
      try {
        this.fitAddon.fit();
        this.xterm.scrollToBottom();
      } catch (_) {}
    }, 30);
  }

  activate() {
    this.pane.classList.add('active');
    const h = this.pane.clientHeight;
    const w = this.pane.clientWidth;
    if (h >= 10 && w >= 10) {
      try { this.fitAddon.fit(); } catch (_) {}
    }
    this.xterm.scrollToBottom();
    this.xterm.focus();
  }

  deactivate() {
    this.pane.classList.remove('active');
  }

  showPrompt() {
    this.xterm.write(this._prompt);
    setTimeout(() => this.xterm.scrollToBottom(), 0);
  }

  // ── Multi-line cursor helper ─────────────────────────────────────────────
  // Moves the terminal cursor from logical buffer offset `from` to `to`,
  // handling row wrapping when commands span more than one terminal line.
  _moveCursorFromTo(from, to) {
    if (from === to) return;
    const cols = this.xterm.cols || 80;
    const pLen = `student@rospad:~/ws${this._cwd.slice(3)}$ `.length;
    const fromRow = Math.floor((pLen + from) / cols);
    const toRow   = Math.floor((pLen + to)   / cols);
    const toCol   = (pLen + to) % cols;
    let seq = '';
    const rowDiff = toRow - fromRow;
    if (rowDiff < 0) seq += `\x1b[${-rowDiff}A`;
    if (rowDiff > 0) seq += `\x1b[${rowDiff}B`;
    seq += `\x1b[${toCol + 1}G`;  // absolute column (1-indexed)
    this.xterm.write(seq);
  }

  // ── Low-level line editing ────────────────────────────────────────────────

  _insert(ch) {
    const tail = this._buf.slice(this._cur);
    this._buf = this._buf.slice(0, this._cur) + ch + tail;
    const from = this._cur;
    this._cur++;
    if (tail.length > 0) {
      // Erase to end of screen, rewrite ch + tail, reposition cursor
      this.xterm.write('\x1b[J' + ch + tail);
      this._moveCursorFromTo(from + 1 + tail.length, from + 1);
    } else {
      this.xterm.write(ch);
    }
  }

  _backspace() {
    if (this._cur === 0) return;
    const tail = this._buf.slice(this._cur);
    this._buf = this._buf.slice(0, this._cur - 1) + tail;
    const from = this._cur;
    this._cur--;
    this._moveCursorFromTo(from, this._cur);
    this.xterm.write('\x1b[J' + tail);
    this._moveCursorFromTo(this._cur + tail.length, this._cur);
  }

  _deleteForward() {
    if (this._cur === this._buf.length) return;
    const tail = this._buf.slice(this._cur + 1);
    this._buf = this._buf.slice(0, this._cur) + tail;
    this.xterm.write('\x1b[J' + tail);
    this._moveCursorFromTo(this._cur + tail.length, this._cur);
  }

  _moveLeft(n = 1) {
    const s = Math.min(n, this._cur);
    if (!s) return;
    const from = this._cur;
    this._cur -= s;
    this._moveCursorFromTo(from, this._cur);
  }

  _moveRight(n = 1) {
    const s = Math.min(n, this._buf.length - this._cur);
    if (!s) return;
    const from = this._cur;
    this._cur += s;
    this._moveCursorFromTo(from, this._cur);
  }

  _moveToStart()    { this._moveLeft(this._cur); }
  _moveToEnd()      { this._moveRight(this._buf.length - this._cur); }

  _moveWordLeft() {
    let i = this._cur;
    while (i > 0 && this._buf[i-1] === ' ') i--;
    while (i > 0 && this._buf[i-1] !== ' ') i--;
    this._moveLeft(this._cur - i);
  }

  _moveWordRight() {
    let i = this._cur;
    while (i < this._buf.length && this._buf[i] === ' ') i++;
    while (i < this._buf.length && this._buf[i] !== ' ') i++;
    this._moveRight(i - this._cur);
  }

  _killToEnd() {
    if (this._cur === this._buf.length) return;
    this._buf = this._buf.slice(0, this._cur);
    this.xterm.write('\x1b[J');
  }

  _killToStart() {
    if (this._cur === 0) return;
    const tail = this._buf.slice(this._cur);
    this._moveCursorFromTo(this._cur, 0);
    this.xterm.write('\x1b[J' + tail);
    this._moveCursorFromTo(tail.length, 0);
    this._buf = tail;
    this._cur = 0;
  }

  _killWordLeft() {
    let i = this._cur;
    while (i > 0 && this._buf[i-1] === ' ') i--;
    while (i > 0 && this._buf[i-1] !== ' ') i--;
    const n = this._cur - i;
    if (!n) return;
    const tail = this._buf.slice(this._cur);
    this._buf = this._buf.slice(0, i) + tail;
    this._moveCursorFromTo(this._cur, i);
    this.xterm.write('\x1b[J' + tail);
    this._moveCursorFromTo(i + tail.length, i);
    this._cur = i;
  }

  _setLine(text) {
    this._moveCursorFromTo(this._cur, 0);
    this.xterm.write('\x1b[J');
    this.xterm.write(text);
    this._buf = text;
    this._cur = text.length;
  }

  // ── Tab completion ────────────────────────────────────────────────────────

  _tab() {
    const input  = this._buf;
    const parts  = input.trimStart().split(/\s+/);

    // cd completion — lists subdirectories of current path
    if (parts[0] === 'cd') {
      void this._cdComplete(parts[1] || '');
      return;
    }
    const topics = () => rosBus.getTopics().map(t => t.topic);
    const msgType = (topic) => rosBus.getTopics().find(t => t.topic === topic)?.msgType;

    // ros2 topic pub — single Tab fills topic → type → template in one shot
    if (parts[0]==='ros2' && parts[1]==='topic' && parts[2]==='pub') {
      // Helper: set full pub line and place cursor on the first editable value
      const _fillPub = (topic) => {
        const type = msgType(topic) || 'std_msgs/String';
        const tmpl = _msgTemplate(type);
        const line = `ros2 topic pub ${topic} ${type} '${tmpl}'`;
        this._setLine(line);
        // Move cursor to the first numeric/string value inside the JSON
        const jsonStart = line.indexOf("'") + 2; // after '{'
        const valMatch  = tmpl.match(/:\s*([^,}]+)/);
        if (valMatch) {
          const valIdx = tmpl.indexOf(valMatch[1]);
          this._moveCursorFromTo(line.length, jsonStart + valIdx);
          this._cur = jsonStart + valIdx;
        }
      };

      // Stage A: no topic yet, or partial topic typed — Tab completes + fills type+template
      if (!parts[3] || (parts.length === 4 && !input.endsWith(' '))) {
        const partial = parts[3] || '';
        const hits    = topics().filter(t => t.startsWith(partial));
        if (hits.length === 1) {
          _fillPub(hits[0]);
        } else if (hits.length > 1) {
          this.xterm.write('\r\n');
          hits.forEach(t => this.xterm.write(`  \x1b[36m${t}\x1b[0m\r\n`));
          this.xterm.write(this._prompt + input);
        } else if (!partial) {
          this.xterm.write('\r\n\x1b[33m(no topics active — start a node first)\x1b[0m\r\n');
          this.xterm.write(this._prompt + input);
        } else {
          this.xterm.write('\r\n\x1b[33m(topic type unknown — is the sim running?)\x1b[0m\r\n');
          this.xterm.write(this._prompt + input);
        }
        return;
      }
      return; // already have topic+type+json — Tab does nothing more
    }

    // ros2 topic echo|hz|info
    if (parts[0]==='ros2' && parts[1]==='topic' && ['echo','hz','info'].includes(parts[2])) {
      const partial = parts[3] || '';
      const hits    = topics().filter(t => t.startsWith(partial));
      if (hits.length === 1) {
        this._setLine(`ros2 topic ${parts[2]} ${hits[0]}`);
      } else if (hits.length > 1) {
        this.xterm.write('\r\n');
        hits.forEach(t => this.xterm.write(`  \x1b[36m${t}\x1b[0m\r\n`));
        this.xterm.write(this._prompt + input);
      }
      return;
    }

    // ros2 run
    if (parts[0]==='ros2' && parts[1]==='run') {
      const pkgs = [...this.nodeManager.packages.keys()];
      if (!parts[2] || (parts.length === 3 && !input.endsWith(' '))) {
        const partial = parts[2] || '';
        const hits    = pkgs.filter(p => p.startsWith(partial));
        if (hits.length === 1)       this._setLine(`ros2 run ${hits[0]} `);
        else if (hits.length > 1)    { this.xterm.write('\r\n'); hits.forEach(p => this.xterm.write(`  ${p}\r\n`)); this.xterm.write(this._prompt + input); }
      } else {
        const pkg  = parts[2];
        const exes = this.nodeManager.packages.get(pkg)?.executables?.map(e=>e.executable) || [];
        const partial = parts[3] || '';
        const hits    = exes.filter(e => e.startsWith(partial));
        if (hits.length === 1)       this._setLine(`ros2 run ${pkg} ${hits[0]}`);
        else if (hits.length > 1)    { this.xterm.write('\r\n'); hits.forEach(e => this.xterm.write(`  ${e}\r\n`)); this.xterm.write(this._prompt + input); }
      }
      return;
    }

    // ros2 launch
    if (parts[0]==='ros2' && parts[1]==='launch') {
      const pkgs    = [...this.nodeManager.packages.keys()];
      const partial = parts[2] || '';
      const hits    = pkgs.filter(p => p.startsWith(partial));
      if (hits.length === 1)  this._setLine(`ros2 launch ${hits[0]} `);
      else if (hits.length>1) { this.xterm.write('\r\n'); hits.forEach(p => this.xterm.write(`  ${p}\r\n`)); this.xterm.write(this._prompt + input); }
      return;
    }

    // Generic command prefix
    const allCmds = [
      'ros2 topic pub ','ros2 topic list','ros2 topic echo ','ros2 topic hz ','ros2 topic info ',
      'ros2 node list','ros2 node info ','ros2 run ','ros2 launch ','ros2 pkg create ',
      'colcon build','clear','ls','cat ','touch ','cd ','cd ..','pwd','help',
    ];
    const hits = allCmds.filter(c => c.startsWith(input));
    if (hits.length === 1) {
      this._setLine(hits[0]);
    } else if (hits.length > 1) {
      // longest common prefix
      let prefix = hits[0];
      for (const h of hits) { let i=0; while(i<prefix.length && prefix[i]===h[i]) i++; prefix=prefix.slice(0,i); }
      if (prefix.length > input.length) this._setLine(prefix);
      else { this.xterm.write('\r\n'); hits.forEach(h => this.xterm.write(`  ${h.trim()}\r\n`)); this.xterm.write(this._prompt + input); }
    }
  }

  // Async cd completion — fetches child directories and completes or lists them
  async _cdComplete(arg) {
    // Split arg into parent dir (to list) and the prefix being typed
    const slashIdx = arg.lastIndexOf('/');
    const parentArg = slashIdx >= 0 ? arg.slice(0, slashIdx) : '';
    const prefix    = slashIdx >= 0 ? arg.slice(slashIdx + 1) : arg;
    const listDir   = parentArg ? _resolveCwd(this._cwd, parentArg) : this._cwd;

    let entries = [];
    try { entries = await githubAPI.listDir(listDir); } catch { return; }

    const dirs = entries.filter(e => e.type === 'dir').map(e => e.name);
    const hits = dirs.filter(d => d.startsWith(prefix));
    if (!hits.length) return;

    const base = parentArg ? `${parentArg}/` : '';
    if (hits.length === 1) {
      this._setLine(`cd ${base}${hits[0]}/`);
    } else {
      // Find longest common prefix among hits
      let lcp = hits[0];
      for (const h of hits) { let i = 0; while (i < lcp.length && lcp[i] === h[i]) i++; lcp = lcp.slice(0, i); }
      if (lcp.length > prefix.length) {
        this._setLine(`cd ${base}${lcp}`);
      } else {
        this.xterm.write('\r\n');
        hits.forEach(d => this.xterm.write(`  \x1b[34m${d}/\x1b[0m\r\n`));
        this.xterm.write(this._prompt + this._buf);
      }
    }
  }

  // ── Key handler ──────────────────────────────────────────────────────────

  _initKeys() {
    // Right-click paste fires a DOM paste event on xterm's textarea.
    // Intercept it in the capture phase before xterm's internal handler.
    // onData is intentionally NOT used — it fires for every keystroke (not
    // just paste), causing each character to be inserted twice.
    const ta = this.xterm.textarea;
    if (ta) {
      ta.addEventListener('paste', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const text = e.clipboardData?.getData('text/plain') || '';
        if (!text) return;
        for (const ch of text) {
          const code = ch.codePointAt(0);
          if (ch === '\n' || ch === '\r') this._insert(' ');
          else if (code >= 32 && code !== 127) this._insert(ch);
        }
      }, true); // capture phase: fires before xterm's listener
    }

    // Auto-copy on selection (copyOnSelect was removed in xterm v5).
    this.xterm.onSelectionChange(() => {
      const sel = this.xterm.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    });

    // attachCustomKeyEventHandler fires BEFORE xterm processes the key.
    // Return false → we own this key (xterm calls e.preventDefault and skips it).
    // Return true → xterm handles it normally.
    this.xterm.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // Ctrl+Shift+V: paste via clipboard API (same as Ctrl+V)
      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        navigator.clipboard.readText().then(text => {
          if (!text) return;
          for (const ch of text) {
            const code = ch.codePointAt(0);
            if (ch === '\n' || ch === '\r') this._insert(' ');
            else if (code >= 32 && code !== 127) this._insert(ch);
          }
        }).catch(() => {});
        return false;
      }
      // Other Ctrl+Shift combos (e.g. Ctrl+Shift+C copy): let xterm handle
      if (e.ctrlKey && e.shiftKey) return true;
      this._handleKey(e);
      return false; // prevent xterm from echoing or sending to PTY
    });
  }

  _handleKey(e) {
    // ── Navigation & editing ────────────────────────────────────────────────
    switch (e.key) {
      case 'Enter': {
        this.xterm.write('\r\n');
        const cmd = this._buf.trim();
        this._buf = ''; this._cur = 0; this._histIdx = -1;
        if (cmd) {
          this._history.unshift(cmd);
          this._run(cmd).then(() => this.showPrompt());
        } else {
          this.showPrompt();
        }
        return;
      }
      case 'Backspace':   this._backspace();      return;
      case 'Delete':      this._deleteForward();  return;
      case 'ArrowLeft':   e.altKey ? this._moveWordLeft()  : this._moveLeft();  return;
      case 'ArrowRight':  e.altKey ? this._moveWordRight() : this._moveRight(); return;
      case 'Home':        this._moveToStart(); return;
      case 'End':         this._moveToEnd();   return;
      case 'Tab':         this._tab();         return;

      case 'ArrowUp':
        if (this._histIdx < this._history.length - 1) {
          this._histIdx++;
          this._setLine(this._history[this._histIdx]);
        }
        return;

      case 'ArrowDown':
        if (this._histIdx > 0)     { this._histIdx--; this._setLine(this._history[this._histIdx]); }
        else if (this._histIdx===0){ this._histIdx=-1; this._setLine(''); }
        return;
    }

    // ── Ctrl shortcuts ──────────────────────────────────────────────────────
    if (e.ctrlKey && !e.altKey) {
      switch (e.key) {
        case 'a': this._moveToStart();  return;
        case 'e': this._moveToEnd();    return;
        case 'k': this._killToEnd();    return;
        case 'u': this._killToStart();  return;
        case 'w': this._killWordLeft(); return;
        case 'd': this._deleteForward();return;
        case 'l':
          this.xterm.clear();
          this.xterm.write(this._prompt + this._buf);
          return;
        case 'c':
          this.xterm.write('^C\r\n');
          this._buf = ''; this._cur = 0;
          this.ros2cli._echoSubs?.forEach((_, t) => this.ros2cli.stopEcho(t));
          this.xterm.write(this._prompt);
          return;
        case 'v':
          navigator.clipboard.readText().then(text => {
            if (!text) return;
            for (const ch of text) {
              const code = ch.codePointAt(0);
              if (ch === '\n' || ch === '\r') { this._insert(' '); }
              else if (code >= 32 && code !== 127) this._insert(ch);
            }
          }).catch(() => {});
          return;
      }
      return; // swallow all other Ctrl combos
    }

    // ── Printable character ─────────────────────────────────────────────────
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      const code = e.key.codePointAt(0);
      if (code >= 32 && code !== 127) this._insert(e.key);
    }
  }

  // ── Command dispatch ─────────────────────────────────────────────────────

  async _run(cmd) {
    const firstWord = cmd.trim().split(/\s+/)[0];

    // cd — navigate workspace directories
    if (firstWord === 'cd') {
      const arg  = cmd.trim().slice(2).trim();
      const next = _resolveCwd(this._cwd, arg);
      if (next !== this._cwd) {
        try {
          await githubAPI.listDir(next);
          this._cwd = next;
        } catch {
          this.xterm.writeln(`\x1b[31mcd: ${arg || '~'}: No such directory\x1b[0m`);
        }
      }
      return;
    }

    if (cmd.startsWith('ros2')) {
      const isPkgCreate = /^ros2\s+pkg\s+create/.test(cmd);
      const overlay = isPkgCreate ? this._showBusyOverlay('Creating package…', 'Writing files to GitHub — please wait') : null;
      try { await this.ros2cli.execute(cmd); }
      finally { overlay?.remove(); }
      return;
    }
    if (cmd.startsWith('colcon build')) { await this.ros2cli.colconBuild(); return; }
    if (cmd === 'clear')                { this.xterm.clear(); return; }
    if (cmd === 'help')                 { this.ros2cli._help(); return; }

    // Route file/directory commands to the browser-side GitHub API shell.
    const output = await githubAPI.shell(cmd, this._cwd);
    if (output) {
      this.xterm.write(output);
      if (!output.endsWith('\n') && !output.endsWith('\r\n')) this.xterm.write('\r\n');
    }
  }

  // Busy overlay — shown during GitHub API write operations so users know to wait
  _showBusyOverlay(title, status) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:9000;backdrop-filter:blur(4px);';
    el.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px 36px;text-align:center;min-width:300px;max-width:440px;">
      <div class="reset-spinner" style="margin:0 auto 16px;"></div>
      <div style="font-weight:600;font-size:15px;color:var(--text);margin-bottom:8px;">${title}</div>
      <div style="font-size:13px;color:var(--muted);">${status}</div>
    </div>`;
    document.body.appendChild(el);
    return el;
  }
}

// ── TerminalManager ───────────────────────────────────────────────────────────
class TerminalManager {
  constructor() {
    this.sessions    = [];
    this.activeIdx   = -1;
    this._nextId     = 1;
  }

  addSession(activate = true) {
    const s = new TerminalSession(this._nextId++);
    s.mount();
    this.sessions.push(s);
    this._renderTabs();
    if (activate) this.switchTo(this.sessions.length - 1);
    return s;
  }

  // Create a named terminal for a node/launch — no banner, no initial prompt.
  addNodeSession(label) {
    const s = new TerminalSession(this._nextId++, label);
    s.mount();
    this.sessions.push(s);
    this._renderTabs();
    this.switchTo(this.sessions.length - 1);
    return s;
  }

  closeSession(idx) {
    if (this.sessions.length <= 1) return; // keep at least one
    const s = this.sessions[idx];
    s.nodeManager.stopAll();
    s.pane.remove();
    this.sessions.splice(idx, 1);
    const newIdx = Math.min(idx, this.sessions.length - 1);
    this._renderTabs();
    this.switchTo(newIdx);
  }

  switchTo(idx) {
    if (this.activeIdx >= 0 && this.sessions[this.activeIdx]) {
      this.sessions[this.activeIdx].deactivate();
    }
    this.activeIdx = idx;
    const s = this.sessions[idx];
    s.activate();

    // Expose active session as window.term / window.nodeManager / window.ros2cli
    window.term        = s.xterm;
    window.nodeManager = s.nodeManager;
    window.ros2cli     = s.ros2cli;

    this._renderTabs();
  }

  get active() {
    return this.sessions[this.activeIdx];
  }

  _renderTabs() {
    const bar = document.getElementById('term-session-tabs');
    bar.innerHTML = '';
    this.sessions.forEach((s, i) => {
      const tab = document.createElement('div');
      tab.className = 'term-stab' + (i === this.activeIdx ? ' active' : '');
      tab.innerHTML = `<span>${s.label}</span>` +
        (this.sessions.length > 1
          ? `<span class="term-stab-close" onclick="event.stopPropagation();termManager.closeSession(${i})">✕</span>`
          : '');
      tab.addEventListener('click', () => this.switchTo(i));
      bar.appendChild(tab);
    });
  }
}

// ── Theme helper (called by index.html toggleTheme) ───────────────────────────
window.applyTerminalTheme = function(mode) {
  const t = mode === 'light' ? _xtermThemeLight : _xtermThemeDark;
  XTERM_OPTIONS.theme = t;
  if (window.termManager) {
    window.termManager.sessions.forEach(s => {
      if (s.xterm) s.xterm.options.theme = t;
    });
  }
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
window.termManager = new TerminalManager();

// Create the first session immediately (before DOMContentLoaded so app.js can use term)
// We need the DOM to be ready, so we wait for it
function _initFirstTerminal() {
  const s = termManager.addSession(true);

  // Write the startup banner
  s.xterm.writeln('\x1b[1m\x1b[32m  ██████╗  ██████╗ ███████╗██████╗  █████╗ ██████╗ \x1b[0m');
  s.xterm.writeln('\x1b[32m  ██╔══██╗██╔═══██╗██╔════╝██╔══██╗██╔══██╗██╔══██╗\x1b[0m');
  s.xterm.writeln('\x1b[32m  ██████╔╝██║   ██║███████╗██████╔╝███████║██║  ██║\x1b[0m');
  s.xterm.writeln('\x1b[32m  ██╔══██╗██║   ██║╚════██║██╔═══╝ ██╔══██║██║  ██║\x1b[0m');
  s.xterm.writeln('\x1b[32m  ██║  ██║╚██████╔╝███████║██║     ██║  ██║██████╔╝\x1b[0m');
  s.xterm.writeln('\x1b[32m  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝     ╚═╝  ╚═╝╚═════╝ \x1b[0m');
  s.xterm.writeln('');
  s.xterm.writeln('  \x1b[1mROS2 IDE in your browser\x1b[0m  |  type \x1b[33mhelp\x1b[0m for commands');
  s.xterm.writeln('  \x1b[34mTab\x1b[0m autocompletes topics & inserts message templates');
  s.xterm.writeln('  \x1b[34mWASD\x1b[0m teleop after clicking the sim canvas');
  s.xterm.writeln('');
  s.showPrompt();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initFirstTerminal);
} else {
  _initFirstTerminal();
}

// ── Legacy shims (editor.js calls these) ─────────────────────────────────────
function prompt()             { termManager.active?.showPrompt(); }
function replaceInput(text)   { termManager.active?._setLine(text); }
function switchTermTab()      {}  // no-op, kept for compat

// Note: window resize is handled in app.js to avoid double-fitting

// Trap Tab key: when focus is inside the terminal viewport, prevent it from
// leaving to another UI element — xterm's own key handler takes care of it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const vp = document.getElementById('terminal-viewport');
  if (vp && vp.contains(document.activeElement)) {
    e.preventDefault();  // stop browser focus cycling — event still propagates to xterm
  }
}, true);  // capture phase
