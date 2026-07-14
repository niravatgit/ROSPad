/**
 * editor.js — Monaco editor, tab management, file operations, run/stop
 */

window.editor      = null;
window.monacoReady = false;
window.openTabs    = new Map(); // path → { content, model, dirty }
window.activeTab   = null;

// ── Monaco init ───────────────────────────────────────────────────────────────
require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
require(['vs/editor/editor.main'], () => {
  window.monacoReady = true;

  monaco.editor.defineTheme('rospad', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment',  foreground: '6e7681' },
      { token: 'keyword',  foreground: 'ff7b72' },
      { token: 'string',   foreground: 'a5d6ff' },
      { token: 'number',   foreground: '79c0ff' },
    ],
    colors: {
      'editor.background':            '#0d1117',
      'editor.foreground':            '#e6edf3',
      'editorLineNumber.foreground':  '#3d444d',
      'editorCursor.foreground':      '#58a6ff',
      'editor.selectionBackground':   '#264f78',
      'editorIndentGuide.background': '#21262d',
    },
  });

  const _initialTheme = localStorage.getItem('rospad-theme') === 'light' ? 'vs' : 'rospad';
  window.editor = monaco.editor.create(document.getElementById('editor-container'), {
    theme: _initialTheme,
    language: 'python',
    fontSize: 13,
    lineHeight: 20,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    minimap:            { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout:    true,
    tabSize:            4,
    insertSpaces:       true,
    wordWrap:           'off',
    renderWhitespace:   'selection',
    smoothScrolling:    true,
    cursorBlinking:     'smooth',
    bracketPairColorization: { enabled: true },
  });

  document.getElementById('welcome').style.display = 'none';

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (activeTab && openTabs.get(activeTab) && !openTabs.get(activeTab).readOnly) {
      saveFile(activeTab, editor.getValue());
    }
  });

  editor.onDidChangeModelContent(() => {
    if (activeTab) {
      const tab = openTabs.get(activeTab);
      if (tab && !tab.readOnly) {
        tab.dirty = true;
        updateTabLabel(activeTab, true);
        debounce(() => saveFile(activeTab, editor.getValue()), 1500)();
      }
    }
  });

  // Sync button state once editor is ready (activeTab may already be set)
  _updateRunState();
});

// ── File tree ─────────────────────────────────────────────────────────────────
// Whitelist sets: dirs are collapsed by default; clicking adds to the set.
const expandedDirs    = new Set();
const expandedRosDirs = new Set();

// Currently "active" directory in the workspace tree — drives new-file placement.
// Updated whenever the user clicks a folder row or opens a file.
let selectedTreeDir = 'src';

const INDENT_CLASSES = ['', 'indented', 'indented2', 'indented3'];

function _indentClass(n) { return INDENT_CLASSES[Math.min(n, 3)]; }

let _treeGen = 0;
async function refreshTree() {
  // Increment generation; after debounce, only the latest call proceeds.
  const gen = ++_treeGen;
  await new Promise(r => setTimeout(r, 30));
  if (gen !== _treeGen) return;

  // Build entirely into a DocumentFragment — never touch the live tree until
  // all fetches are complete, so concurrent calls can never interleave DOM nodes.
  const frag = document.createDocumentFragment();

  // ── Section 1: User workspace ────────────────────────────────────────────
  frag.appendChild(_sectionLabel('Workspace'));

  async function renderDir(dirPath, indent = 0) {
    const entries = await githubAPI.listDir(dirPath).catch(() => null);
    if (gen !== _treeGen) return; // superseded — abort
    if (!entries) return;

    for (const e of entries) {
      const item = document.createElement('div');
      item.className = `tree-item ${e.type === 'dir' ? 'dir' : ''} ${_indentClass(indent)}`;

      const iconEl = document.createElement('span');
      iconEl.className = 'tree-icon';
      iconEl.textContent = e.type === 'dir' ? '📁' : getFileIcon(e.name);
      item.appendChild(iconEl);

      const nameEl = document.createElement('span');
      nameEl.textContent = e.name;
      item.appendChild(nameEl);

      const acts = document.createElement('span');
      acts.className = 'tree-actions';

      const dlBtn = document.createElement('span');
      dlBtn.className = 'tree-act-btn';
      dlBtn.title = e.type === 'dir' ? 'Download as .zip' : 'Download file';
      dlBtn.textContent = '⬇';
      dlBtn.onclick = ev => { ev.stopPropagation(); _treeDownload(e); };
      acts.appendChild(dlBtn);

      const renBtn = document.createElement('span');
      renBtn.className = 'tree-act-btn';
      renBtn.title = 'Rename';
      renBtn.textContent = '✏';
      renBtn.onclick = ev => { ev.stopPropagation(); _treeRename(e, nameEl); };
      acts.appendChild(renBtn);

      const delBtn = document.createElement('span');
      delBtn.className = 'tree-act-btn danger';
      delBtn.title = 'Delete';
      delBtn.textContent = '🗑';
      delBtn.onclick = ev => { ev.stopPropagation(); _treeDelete(e); };
      acts.appendChild(delBtn);

      if (e.type === 'dir' && indent === 0) {
        const lb = document.createElement('span');
        lb.className = 'tree-act-btn';
        lb.title = 'Pick & launch a launch file';
        lb.textContent = '⚡';
        lb.onclick = async ev => { ev.stopPropagation(); await _showPkgLaunchPicker(e.name, false, lb); };
        acts.appendChild(lb);
      }
      item.appendChild(acts);

      if (e.type === 'file') {
        item.onclick = () => {
          selectedTreeDir = e.path.split('/').slice(0, -1).join('/') || 'src';
          openFile(e.path);
        };
      } else {
        item.onclick = () => { selectedTreeDir = e.path; toggleDir(e.path); };
        item._path = e.path;
      }
      frag.appendChild(item);

      if (e.type === 'dir' && expandedDirs.has(e.path)) {
        await renderDir(e.path, indent + 1);
        if (gen !== _treeGen) return;
      }
    }
  }

  await renderDir('src');
  if (gen !== _treeGen) return;

  // ── Section 2: System packages (ros2_ws/src) — read-only ────────────────
  frag.appendChild(_sectionLabel('System Packages', true));

  async function renderRosDir(rosPath, indent = 0) {
    const entries = await githubAPI.listRosDir(rosPath).catch(() => null);
    if (gen !== _treeGen) return;
    if (!entries) return;

    const BINARY_EXT = /\.(glb|dae|stl|obj|png|jpg|jpeg|bin|svg)$/i;

    for (const e of entries) {
      const item = document.createElement('div');
      item.className = `tree-item ros2-sys ${e.type === 'dir' ? 'dir' : ''} ${_indentClass(indent)}`;
      const icon = e.type === 'dir' ? '📁' : getFileIcon(e.name);
      item.innerHTML = `<span class="tree-icon">${icon}</span>${e.name}`;

      if (e.type === 'file') {
        if (BINARY_EXT.test(e.name)) {
          item.classList.add('ros2-binary');
          item.title = 'Binary file — cannot display in editor';
        } else {
          item.onclick = () => openRos2File(e.path);
        }
      } else {
        item.onclick = () => toggleRosDir(e.path);
        item._path = e.path;
        if (indent === 0) {
          const lb = document.createElement('span');
          lb.className = 'tree-launch-icon';
          lb.title = 'Pick & launch a launch file';
          lb.textContent = '⚡';
          lb.onclick = async ev => { ev.stopPropagation(); await _showPkgLaunchPicker(e.name, true, lb); };
          item.appendChild(lb);
        }
      }
      frag.appendChild(item);

      if (e.type === 'dir' && expandedRosDirs.has(e.path)) {
        await renderRosDir(e.path, indent + 1);
        if (gen !== _treeGen) return;
      }
    }
  }

  await renderRosDir('');
  if (gen !== _treeGen) return;

  // All data collected — swap the live tree atomically in one synchronous step
  const tree = document.getElementById('file-tree');
  tree.innerHTML = '';
  tree.appendChild(frag);

  await nodeManager.indexWorkspace();
}

function _sectionLabel(text, dimmed = false) {
  const el = document.createElement('div');
  el.className = 'tree-section' + (dimmed ? ' tree-section-sys' : '');
  el.textContent = text;
  return el;
}

function toggleDir(path) {
  if (expandedDirs.has(path)) expandedDirs.delete(path);
  else expandedDirs.add(path);
  refreshTree();
}

function toggleRosDir(path) {
  if (expandedRosDirs.has(path)) expandedRosDirs.delete(path);
  else expandedRosDirs.add(path);
  refreshTree();
}

function getFileIcon(name) {
  if (name.endsWith('.launch.py'))                       return '🚀';
  if (name.endsWith('.urdf') || name.endsWith('.xacro')) return '🤖';
  if (name === 'package.xml')                            return '📦';
  if (name.endsWith('.py'))                              return '🐍';
  if (name.endsWith('.xml'))                             return '📄';
  if (name.endsWith('.yaml') || name.endsWith('.yml'))   return '⚙';
  if (/\.(glb|dae|stl|obj)$/i.test(name))               return '🗿';
  if (/\.(png|jpg|jpeg|svg)$/i.test(name))               return '🖼';
  return '📝';
}

function isReadOnly(path) {
  const name = path.split('/').pop();
  return name.endsWith('.urdf') || name.endsWith('.xacro') || name === 'package.xml';
}

function _detectLang(filePath) {
  if (filePath.endsWith('.py'))                                return 'python';
  if (filePath.endsWith('.urdf') || filePath.endsWith('.xacro')) return 'xml';
  if (filePath.endsWith('.xml'))                               return 'xml';
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'yaml';
  if (filePath.endsWith('.json'))                              return 'json';
  return 'plaintext';
}

async function openFile(path) {
  if (!monacoReady) { alert('Editor still loading...'); return; }
  if (openTabs.has(path)) { switchTab(path); return; }

  let content;
  try { content = await githubAPI.readFile(path); }
  catch { term.writeln(`\x1b[31mCannot open ${path}\x1b[0m`); return; }

  const readOnly = isReadOnly(path);
  const model = monaco.editor.createModel(content, _detectLang(path));
  openTabs.set(path, { content, model, dirty: false, readOnly });
  addTab(path, readOnly);
  switchTab(path);
  document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));
}

async function openRos2File(rosPath) {
  if (!monacoReady) { alert('Editor still loading...'); return; }
  const key = 'ros2:' + rosPath;
  if (openTabs.has(key)) { switchTab(key); return; }

  let content;
  try { content = await githubAPI.readRosFile(rosPath); }
  catch { term.writeln(`\x1b[31mCannot open system file ${rosPath}\x1b[0m`); return; }

  const model = monaco.editor.createModel(content, _detectLang(rosPath));
  openTabs.set(key, { content, model, dirty: false, readOnly: true });
  addTab(key, true);
  switchTab(key);
  document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));
}

function addTab(path, readOnly = false) {
  const tabs = document.getElementById('tabs');
  const name = path.split('/').pop();
  const tab  = document.createElement('div');
  tab.className = 'tab';
  tab.id = `tab-${btoa(path)}`;
  const badge = readOnly ? '<span class="tab-readonly" title="Read-only">RO</span>' : '';
  tab.innerHTML = `${badge}${name}<span class="tab-close" onclick="closeTab('${path}',event)">✕</span>`;
  tab.onclick = () => switchTab(path);
  tabs.appendChild(tab);
}

function switchTab(path) {
  window.activeTab = path;
  // Track directory context for new-file placement (skip ros2: system paths)
  if (path && !path.startsWith('ros2:')) {
    const parts = path.split('/');
    selectedTreeDir = parts.slice(0, -1).join('/') || 'src';
  }
  // Always update button state when active tab changes, even before editor is ready
  _updateRunState();

  const tab = openTabs.get(path);
  if (!tab || !editor) return;

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${btoa(path)}`)?.classList.add('active');

  editor.setModel(tab.model);
  editor.updateOptions({ readOnly: !!tab.readOnly });
  document.getElementById('welcome').style.display = 'none';
}

function closeTab(path, e) {
  e?.stopPropagation();
  const tab = openTabs.get(path);
  if (tab) tab.model.dispose();
  openTabs.delete(path);
  document.getElementById(`tab-${btoa(path)}`)?.remove();

  if (activeTab === path) {
    window.activeTab = openTabs.size > 0 ? [...openTabs.keys()].pop() : null;
    if (activeTab) switchTab(activeTab);
    else document.getElementById('welcome').style.display = 'flex';
  }
}

function updateTabLabel(path, dirty) {
  const tabEl = document.getElementById(`tab-${btoa(path)}`);
  if (tabEl) {
    const name = path.split('/').pop();
    tabEl.innerHTML = `${dirty ? '● ' : ''}${name}<span class="tab-close" onclick="closeTab('${path}',event)">✕</span>`;
  }
}

async function saveFile(path, content) {
  await githubAPI.writeFile(path, content);
  const tab = openTabs.get(path);
  if (tab) { tab.dirty = false; updateTabLabel(path, false); }
}

// ── File-tree actions: download and delete ────────────────────────────────────

async function _treeDownload(e) {
  if (e.type === 'dir') {
    window.term?.writeln('\x1b[33m[ROSpad] Directory download not supported in GitHub Pages mode\x1b[0m');
    return;
  }
  try {
    const content = await githubAPI.readFile(e.path);
    const blob = new Blob([content], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = e.name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch { window.term?.writeln(`\x1b[31m[ROSpad] Download failed: ${e.path}\x1b[0m`); }
}

async function _treeDelete(e) {
  const what = e.type === 'dir'
    ? `folder "${e.name}" and all its contents`
    : `file "${e.name}"`;
  if (!window.confirm(`Delete ${what}?\n\nThis cannot be undone.`)) return;

  try {
    await githubAPI.deleteEntry(e.path);
  } catch (err) {
    window.term?.writeln(`\x1b[31m[ROSpad] Delete failed: ${err.message}\x1b[0m`);
    return;
  }

  window.term?.writeln(`\x1b[33m[ROSpad] Deleted ${e.path}\x1b[0m`);

  // Close any open editor tabs that lived inside the deleted path
  const prefix = e.type === 'dir' ? e.path + '/' : null;
  for (const [p] of openTabs) {
    if (p === e.path || (prefix && p.startsWith(prefix))) closeTab(p);
  }

  await refreshTree();
}

async function _treeRename(e, nameEl) {
  const inp = document.createElement('input');
  inp.value = e.name;
  inp.className = 'tree-rename-input';
  inp.onclick = ev => ev.stopPropagation();

  const orig = e.name;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();

  let committed = false;

  async function commit() {
    if (committed) return;
    committed = true;
    const newName = inp.value.trim();
    inp.replaceWith(nameEl);
    if (!newName || newName === orig) return;

    let newPath;
    try {
      newPath = await githubAPI.rename(e.path, newName);
    } catch (err) {
      window.term?.writeln(`\x1b[31m[ROSpad] Rename failed: ${err.message}\x1b[0m`);
      return;
    }
    window.term?.writeln(`\x1b[33m[ROSpad] Renamed ${orig} → ${newName}\x1b[0m`);

    // Update open tabs: close old paths, reopen file at new path
    const oldPrefix = e.type === 'dir' ? e.path + '/' : null;
    const wasOpen   = openTabs.has(e.path);
    for (const [p] of openTabs) {
      if (p === e.path || (oldPrefix && p.startsWith(oldPrefix))) closeTab(p);
    }
    if (e.type === 'file' && wasOpen) openFile(newPath);

    await refreshTree();
  }

  inp.onkeydown = async ev => {
    if (ev.key === 'Enter')  { ev.preventDefault(); await commit(); }
    if (ev.key === 'Escape') { committed = true; inp.replaceWith(nameEl); }
  };
  inp.onblur = () => commit();
}

// Custom dialog for new-file/folder — avoids window.prompt which is
// overridden by terminal.js to show a terminal input shim instead.
// ── New file / folder dialog ──────────────────────────────────────────────────

async function newFile() {
  document.getElementById('_nf-overlay')?.remove();

  const ov = document.createElement('div');
  ov.id = '_nf-overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center';

  ov.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:20px;width:460px;max-width:92vw">
      <div style="font-size:13px;font-weight:600;margin-bottom:12px;color:var(--text)">Create in workspace</div>
      <div style="display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:4px;overflow:hidden">
        <span style="padding:7px 8px 7px 10px;color:var(--text2);font-size:12px;white-space:nowrap;border-right:1px solid var(--border)">src/</span>
        <input id="_nf-input" placeholder="my_pkg/my_pkg/node.py"
          style="flex:1;background:transparent;border:none;padding:7px 10px;color:var(--text);font-family:inherit;font-size:12px;outline:none">
      </div>
      <div id="_nf-err" style="display:none;margin-top:8px;font-size:11px;color:var(--red)"></div>
      <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
        <button id="_nf-cancel" class="topbtn">Cancel</button>
        <button id="_nf-dir"    class="topbtn" style="border-color:#555">📁 Folder</button>
        <button id="_nf-file"   class="topbtn run">📝 File</button>
      </div>
    </div>`;

  document.body.appendChild(ov);

  const inp    = ov.querySelector('#_nf-input');
  const errEl  = ov.querySelector('#_nf-err');
  const canBtn = ov.querySelector('#_nf-cancel');
  const dirBtn = ov.querySelector('#_nf-dir');
  const fileBtn= ov.querySelector('#_nf-file');

  // Pre-fill with the current directory context (strip leading 'src/')
  const prefill = (selectedTreeDir && selectedTreeDir !== 'src')
    ? selectedTreeDir.replace(/^src\//, '') + '/'
    : '';
  inp.value = prefill;
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);

  function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }

  function getPath() {
    const raw = inp.value.trim();
    if (!raw) return null;
    return 'src/' + raw.replace(/^src\//, '').replace(/\/$/, '');
  }

  async function createDir() {
    const p = getPath();
    if (!p) { showErr('Please enter a folder path.'); return; }
    dirBtn.disabled = true; dirBtn.textContent = 'Creating…';
    try {
      await githubAPI.mkdir(p);
    } catch (e) { showErr(e.message); dirBtn.disabled = false; dirBtn.textContent = '📁 Folder'; return; }
    window.term?.writeln(`\x1b[32m[ROSpad] Created folder ${p}\x1b[0m`);
    _expandPath(p, true);
    ov.remove();
    await refreshTree();
  }

  async function createFile() {
    const p = getPath();
    if (!p) { showErr('Please enter a file path.'); return; }
    fileBtn.disabled = true; fileBtn.textContent = 'Creating…';
    try {
      await githubAPI.writeFile(p, defaultPyContent(p));
    } catch (e) { showErr(e.message); fileBtn.disabled = false; fileBtn.textContent = '📝 File'; return; }
    window.term?.writeln(`\x1b[32m[ROSpad] Created ${p}\x1b[0m`);
    _expandPath(p, false);
    ov.remove();
    await refreshTree();
    openFile(p);
  }

  dirBtn.onclick  = createDir;
  fileBtn.onclick = createFile;
  canBtn.onclick  = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  inp.addEventListener('keydown', e => { if (e.key === 'Escape') ov.remove(); });
}

// Add all path segments up to (and including if isDir) the target to expandedDirs.
function _expandPath(p, isDir) {
  const parts = p.split('/');
  const limit = isDir ? parts.length : parts.length - 1;
  let cur = '';
  for (let i = 0; i < limit; i++) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i];
    expandedDirs.add(cur);
  }
}

// ── Per-package launch file picker ────────────────────────────────────────────
async function _showPkgLaunchPicker(pkgName, isSys, anchor) {
  let launchFiles;
  try {
    const files = isSys
      ? await githubAPI.listRosDir(`${pkgName}/launch`)
      : await githubAPI.listDir(`src/${pkgName}/launch`);
    launchFiles = files.filter(f => f.name.endsWith('.launch.py'));
  } catch (_) { return; }
  if (!launchFiles.length) return;

  if (launchFiles.length === 1) {
    doLaunch(pkgName, launchFiles[0].name);
    return;
  }

  // Multiple launch files — show a positioned dropdown
  document.getElementById('_pkg-launch-picker')?.remove();
  const picker = document.createElement('div');
  picker.id = '_pkg-launch-picker';
  picker.className = 'pkg-launch-picker';

  const hdr = document.createElement('div');
  hdr.className = 'launch-menu-header';
  hdr.textContent = pkgName;
  picker.appendChild(hdr);

  for (const f of launchFiles) {
    const row = document.createElement('div');
    row.className = 'launch-item';
    row.innerHTML = `<span style="color:var(--ros);font-size:12px">⚡</span><span class="launch-item-file">${f.name}</span>`;
    row.onclick = () => { picker.remove(); doLaunch(pkgName, f.name); };
    picker.appendChild(row);
  }

  const rect = anchor.getBoundingClientRect();
  picker.style.cssText = `position:fixed;left:${Math.min(rect.right + 4, window.innerWidth - 240)}px;top:${rect.top}px;`;
  document.body.appendChild(picker);

  setTimeout(() => {
    document.addEventListener('click', function _close(ev) {
      if (!picker.contains(ev.target)) { picker.remove(); document.removeEventListener('click', _close); }
    });
  }, 0);
}

function defaultPyContent(path) {
  if (path.endsWith('.py') && path.includes('/') && !path.endsWith('__init__.py')) {
    return `import rclpy\nfrom rclpy.node import Node\n\n\nclass MyNode(Node):\n    def __init__(self):\n        super().__init__('my_node')\n        self.get_logger().info('Node started!')\n\n\ndef main(args=None):\n    rclpy.init(args=args)\n    node = MyNode()\n    rclpy.spin(node)\n    rclpy.shutdown()\n`;
  }
  return '';
}

// ── Run / Stop ────────────────────────────────────────────────────────────────
async function runCurrentFile() {
  const t = window.term;
  if (!editor || !activeTab) {
    t?.writeln('\x1b[31mNo file open. Open a Python file first.\x1b[0m');
    return;
  }
  const code = editor.getValue();
  if (!activeTab.startsWith('ros2:')) await saveFile(activeTab, code);

  if (activeTab.endsWith('.launch.py')) {
    const tabPath  = activeTab.startsWith('ros2:') ? activeTab.slice(5) : activeTab;
    const parts    = tabPath.split('/');
    const pkgIndex = parts.indexOf('launch') - 1;
    const pkg      = pkgIndex >= 0 ? parts[pkgIndex] : null;
    const launchFile = parts[parts.length - 1];
    if (!pkg) {
      t?.writeln('\x1b[31mCould not infer package for launch file.\x1b[0m');
      return;
    }
    t?.writeln(`\n\x1b[33m[ROSpad] Launching ${pkg}/${launchFile}...\x1b[0m`);
    await window.ros2cli?.execute(`ros2 launch ${pkg} ${launchFile}`);
    return;
  }

  const fileName = activeTab.split('/').pop().replace(/\.py$/, '');
  t?.writeln(`\n\x1b[33m[ROSpad] Running ${fileName} — opening new terminal tab...\x1b[0m`);
  const _runSession = window.termManager.addNodeSession(fileName);
  _runSession.xterm.writeln(`\x1b[2m▶  ${activeTab.split('/').pop()}\x1b[0m`);
  await _runSession.nodeManager.runCode(code, activeTab);
}

function stopAll() {
  // Stop workers across ALL terminal sessions, not just the active one
  termManager.sessions.forEach(s => s.nodeManager.stopAll());
}

// Global registry: numeric slot → worker key, rebuilt each render.
// Using a number in onclick="..." avoids all HTML attribute quoting issues.
window._nodeBarRegistry = [];

function _updateNodeBar() {
  const bar = document.getElementById('running-nodes-bar');
  if (!bar) return;
  // Registry stores {session, key} so ✕ only stops that specific session's worker.
  window._nodeBarRegistry = [];
  let html = '';
  try {
    termManager?.sessions?.forEach(s => {
      s.nodeManager?.workers?.forEach((_, key) => {
        const idx = window._nodeBarRegistry.length;
        window._nodeBarRegistry.push({ session: s, key });
        const label = key.split('/').pop().replace(/\.py$/, '');
        html +=
          `<div class="node-pill" title="${key}">` +
          `<span class="node-pill-dot">●</span>` +
          `<span>${label}</span>` +
          `<span class="node-pill-stop" onclick="_stopNodeByIdx(${idx})">✕</span>` +
          `</div>`;
      });
    });
  } catch (_) {}
  bar.innerHTML = html;
  bar.style.display = html ? 'flex' : 'none';
}

// Called by the pill ✕ buttons via onclick="_stopNodeByIdx(n)".
function _stopNodeByIdx(idx) {
  const entry = window._nodeBarRegistry[idx];
  if (!entry) return;
  const { session, key } = entry;
  session.xterm?.writeln(`\x1b[33m[ROSpad] Stopping ${key.split('/').pop()}…\x1b[0m`);
  session.nodeManager?.stopNode(key);
}

function _updateRunState() {
  let anyRunning = false;
  try {
    anyRunning = termManager?.sessions?.some(s => s.nodeManager?.workers?.size > 0) ?? false;
  } catch (_) {}
  const tab      = activeTab || '';
  const isLaunch = tab.endsWith('.launch.py');
  const isPy     = tab.endsWith('.py') && !isLaunch;

  const stopBtn   = document.getElementById('btn-stop');
  const runBtn    = document.getElementById('btn-run');
  const launchBtn = document.getElementById('btn-launch');

  // Stop enabled only when something is running.
  // Run/Launch always enabled based on file type so multiple nodes can run simultaneously.
  if (stopBtn)   stopBtn.disabled   = !anyRunning;
  if (runBtn)    runBtn.disabled    = !isPy;
  if (launchBtn) launchBtn.disabled = !isLaunch;

  _updateNodeBar();
}
window._updateRunState = _updateRunState;

async function colconBuild() {
  term.writeln('\n');
  await ros2cli.colconBuild();
}

// ── Launch menu ───────────────────────────────────────────────────────────────

async function toggleLaunchMenu() {
  const menu = document.getElementById('launch-menu');
  if (menu.classList.contains('open')) { _closeLaunchMenu(); return; }

  menu.innerHTML = '<div class="launch-menu-empty">Loading…</div>';
  menu.classList.add('open');

  // Walk src/ packages and find all *.launch.py files
  const items = [];
  try {
    const pkgs = await githubAPI.listDir('src');
    for (const pkg of pkgs.filter(e => e.type === 'dir')) {
      try {
        const files = await githubAPI.listDir(`${pkg.path}/launch`);
        for (const f of files.filter(f => f.name.endsWith('.launch.py'))) {
          items.push({ pkg: pkg.name, file: f.name });
        }
      } catch (_) {}
    }
  } catch (_) {}

  if (items.length === 0) {
    menu.innerHTML = '<div class="launch-menu-empty">No launch files found in workspace</div>';
    return;
  }

  menu.innerHTML = '<div class="launch-menu-header">Select launch file</div>' +
    items.map(({ pkg, file }) =>
      `<div class="launch-item" onclick="doLaunch('${pkg}','${file}')">` +
      `<span class="launch-item-pkg">${pkg}</span>` +
      `<span class="launch-item-file">/ ${file}</span></div>`
    ).join('');
}

function _closeLaunchMenu() {
  document.getElementById('launch-menu')?.classList.remove('open');
}

async function doLaunch(pkg, file) {
  _closeLaunchMenu();
  term.writeln(`\n\x1b[33m[ROSpad] Launching ${pkg}/${file}...\x1b[0m`);
  await ros2cli.execute(`ros2 launch ${pkg} ${file}`);
}

// Close menu when clicking outside
document.addEventListener('click', (e) => {
  if (!document.getElementById('launch-btn-wrap')?.contains(e.target)) {
    _closeLaunchMenu();
  }
});

// ── Debounce util (used by auto-save) ────────────────────────────────────────
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
