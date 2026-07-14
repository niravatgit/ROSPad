/**
 * node_manager.js
 * Spawns and manages Pyodide Web Workers — one per ROS2 node
 */

class NodeManager {
  constructor(bus, terminal) {
    this.bus = bus;
    this.term = terminal;
    this.workers = new Map();      // workerKey → Worker
    this.packages = new Map();     // pkg_name  → {path, executables}
    this._workerNodes = new Map(); // workerKey → Set of registered node names
    this.onWorkersChange = null;   // callback(size) — called on any worker start/stop
  }

  _notifyChange() {
    try { this.onWorkersChange?.(this.workers.size); } catch(e) {}
  }

  // ── Index workspace packages ───────────────────────────────────────────────

  async indexWorkspace() {
    try {
      const pkgs = await githubAPI.listDir('src');
      for (const pkg of pkgs.filter(e => e.type === 'dir')) {
        await this._indexPackage(pkg.name, pkg.path);
      }
    } catch (e) {
      console.warn('[NodeManager] Could not index workspace:', e);
    }
  }

  async _indexPackage(name, pkgPath) {
    try {
      const content = await githubAPI.readFile(`${pkgPath}/setup.py`);

      // Parse entry_points from setup.py
      const matches = [...content.matchAll(/['"](\w+)\s*=\s*([\w.]+):(\w+)['"]/g)];
      const executables = matches.map(m => ({
        executable: m[1],
        module: m[2],
        fn: m[3]
      }));

      this.packages.set(name, { path: pkgPath, executables });
    } catch (e) {
      // package might not have setup.py yet
    }
  }

  // ── ros2 run <pkg> <executable> ───────────────────────────────────────────

  // prefix: optional ANSI-coloured label prepended to every stdout/stderr line.
  // Used by launchFile() so output from different nodes is distinguishable in a
  // shared terminal. Leave empty (default) for standalone ros2 run.
  async runNode(pkg, executable, prefix = '') {
    // Built-in: rospad/sim controls the 3D simulation directly
    if (pkg === 'rospad' && executable === 'sim') {
      if (typeof window.startSim === 'function') {
        window.startSim();
        this.term.writeln('\x1b[32m[rospad/sim] Simulation started\x1b[0m');
        // Register a fake worker so stopNode/stopAll can stop the sim
        const fakeWorker = { terminate: () => { window.stopSim?.(); } };
        this.workers.set('rospad/sim', fakeWorker);
      }
      return;
    }

    if (!this.packages.has(pkg)) {
      await this._indexPackage(pkg, `src/${pkg}`);
    }

    const pkgInfo = this.packages.get(pkg);
    if (!pkgInfo) {
      this.term.writeln(`\x1b[31mPackage '${pkg}' not found. Did you run 'colcon build'?\x1b[0m`);
      return;
    }

    const entry = pkgInfo.executables?.find(e => e.executable === executable);
    if (!entry) {
      this.term.writeln(`\x1b[31mExecutable '${executable}' not found in ${pkg}\x1b[0m`);
      return;
    }

    // Read the Python source file
    const modulePath = entry.module.replace(/\./g, '/');
    const srcPath = `${pkgInfo.path}/${modulePath}.py`;

    let content;
    try { content = await githubAPI.readFile(srcPath); }
    catch { this.term.writeln(`\x1b[31mCould not read ${srcPath}\x1b[0m`); return; }

    // Append entrypoint call — ROS2 convention defines main() but doesn't call it
    const runCode = content + `\n\n${entry.fn}()\n`;

    // Also read any sibling modules in the package
    const pkgModules = await this._readPackageModules(pkg, pkgInfo.path);

    // Make workerKey unique within this NodeManager — handles the edge case where
    // a launch file declares two instances of the same executable.
    let workerKey = `${pkg}/${executable}`;
    if (this.workers.has(workerKey)) {
      let n = 2;
      while (this.workers.has(`${workerKey}:${n}`)) n++;
      workerKey = `${workerKey}:${n}`;
    }
    this._spawnWorker(workerKey, runCode, pkgModules, pkg, prefix);
  }

  // ── Launch file support ───────────────────────────────────────────────────

  async launchFile(pkg, launchFileName) {
    // Try user workspace first, then system packages
    const userPath   = `src/${pkg}/launch/${launchFileName}`;
    const sysApiPath = `${pkg}/launch/${launchFileName}`;

    let content = null;
    let pkgBase = `src/${pkg}`;  // for URDF resolution
    let isSys   = false;

    try {
      content = await githubAPI.readFile(userPath);
    } catch {
      try {
        content = await githubAPI.readRosFile(sysApiPath);
        isSys   = true;
        pkgBase = pkg;
      } catch {
        this.term.writeln(`\x1b[31mLaunch file not found: ${launchFileName} in package ${pkg}\x1b[0m`);
        return;
      }
    }

    // ── Handle robot_state_publisher → publish /robot_description to sim ────
    let urdfPublished = false;
    if (/robot_state_publisher/.test(content)) {
      urdfPublished = await this._publishRobotDescription(pkg, content, isSys);
    }

    // Parse launch file — extract each Node(...) block and read its arguments.
    const nodeMatches = [];
    for (const block of content.matchAll(/Node\s*\(([\s\S]*?)\)/g)) {
      const argsText = block[1];
      const pkgMatch = argsText.match(/package\s*=\s*['"]([\w.]+)['"]/);
      const exeMatch = argsText.match(/executable\s*=\s*['"]([\w.]+)['"]/);
      if (pkgMatch && exeMatch) {
        nodeMatches.push([pkgMatch[1], exeMatch[1]]);
      }
    }

    // Filter to user-space packages only (skip system ROS2 binaries)
    const userNodes = nodeMatches.filter(([p]) => {
      const systemPkgs = ['robot_state_publisher','joint_state_publisher',
                          'joint_state_publisher_gui','rviz2','rviz','tf2_ros',
                          'tf','rosbridge_server','map_server','nav2_bringup'];
      return !systemPkgs.includes(p);
    });

    if (userNodes.length === 0) {
      if (!urdfPublished) {
        this.term.writeln(`\x1b[33m[launch] No user nodes found in launch file (system nodes skipped)\x1b[0m`);
      }
      return;
    }

    this.term.writeln(`\x1b[33m[launch] Starting ${userNodes.length} node(s) in this terminal...\x1b[0m`);
    // Each node gets a distinct colour so its stdout/stderr is easy to identify
    // in the shared launch terminal. Same palette docker-compose uses.
    const NODE_COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[34m', '\x1b[32m'];
    for (let i = 0; i < userNodes.length; i++) {
      const [p, exe] = userNodes[i];
      const col    = NODE_COLORS[i % NODE_COLORS.length];
      const prefix = `${col}[${exe}]\x1b[0m `;
      this.term.writeln(`\x1b[2m  ${col}●\x1b[0m ${exe} (${p})\x1b[0m`);
      await this.runNode(p, exe, prefix);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Reads the URDF referenced by a launch file and publishes it to /robot_description.
  // Returns true if URDF was found and published.
  async _publishRobotDescription(pkg, launchContent, isSys) {
    let urdfXml = null;

    // Pattern 1: collect all quoted .urdf filenames from the launch content
    const namedUrdfs = [...launchContent.matchAll(/['"]([^'"]*\.urdf(?:\.xacro)?)['"]/g)]
      .map(m => m[1].replace(/^.*share\/[\w_]+\//, '').replace(/^\//, ''));

    // Build candidate paths: if extracted path has no '/', it's a bare filename
    // and conventionally lives in urdf/<filename>.
    const candidates = [];
    for (const rel of namedUrdfs) {
      if (rel.includes('/')) {
        candidates.push(rel);          // already has a dir component
      } else {
        candidates.push(`urdf/${rel}`); // bare filename → try urdf/ subdir
      }
    }
    // Standard fallbacks
    const base = pkg.replace(/_description$/, '');
    candidates.push(
      `urdf/${pkg}.urdf`,
      `urdf/${base}.urdf`,
      'urdf/robot.urdf',
    );

    // Try each candidate
    for (const rel of candidates) {
      const relPath = `${pkg}/${rel}`;
      try {
        urdfXml = isSys
          ? await githubAPI.readRosFile(relPath)
          : await githubAPI.readFile(`src/${relPath}`);
        break;
      } catch { /* try next candidate */ }
    }

    if (urdfXml) {
      // Auto-start sim_bridge so graph shows it (idempotent — startSim guards against double-call)
      if (!window.simRunning && typeof window.startSim === 'function') {
        window.startSim();
        // Register a fake worker so the STOP button can stop the sim
        if (!this.workers.has('rospad/sim')) {
          this.workers.set('rospad/sim', { terminate: () => window.stopSim?.() });
        }
      }
      window.rosBus?.registerNode('robot_state_publisher');
      window.rosBus?.publish('/robot_description', 'std_msgs/String', { data: urdfXml });
      window.rosBus?.trackPublisher('/robot_description', 'robot_state_publisher');
      this.term.writeln(`\x1b[32m[launch] Published /robot_description (${urdfXml.length} bytes)\x1b[0m`);
      return true;
    } else {
      this.term.writeln(`\x1b[33m[launch] Could not find URDF for ${pkg} — check urdf/ directory\x1b[0m`);
      return false;
    }
  }

  // ── Run code directly (from editor "Run" button) ──────────────────────────

  async runCode(code, nodeKey = 'editor_node') {
    this.stopNode(nodeKey);
    // If the file defines main() (ROS2 convention), call it automatically
    const runCode = /^\s*def\s+main\s*\(/m.test(code) ? code + '\n\nmain()\n' : code;

    // Load sibling modules if file is inside a known package (src/<pkg>/<pkg>/file.py)
    let pkgModules = {};
    const m = nodeKey.match(/^src\/([^/]+)\/\1\//);
    if (m) {
      const pkg = m[1];
      pkgModules = await this._readPackageModules(pkg, `src/${pkg}`);
    }
    this._spawnWorker(nodeKey, runCode, pkgModules, 'editor');
  }

  // ── Stop a node ───────────────────────────────────────────────────────────

  stopNode(key) {
    const w = this.workers.get(key);
    if (w) {
      w.terminate();
      this.workers.delete(key);
      (this._workerNodes.get(key) || new Set()).forEach(n => window.rosBus.unregisterNode(n));
      this._workerNodes.delete(key);
      this.term.writeln(`\x1b[33m[${key}] stopped\x1b[0m`);
      this._notifyChange();
    }
  }

  stopAll() {
    for (const [key, w] of this.workers) {
      w.terminate();
      (this._workerNodes.get(key) || new Set()).forEach(n => window.rosBus.unregisterNode(n));
    }
    this.workers.clear();
    this._workerNodes.clear();
    // Reset all graph/topic tracking to clean state
    window.rosBus?.resetTracking();
    window.dispatchEvent(new CustomEvent('rospad:stop'));
    this.term.writeln('\x1b[33mAll nodes stopped\x1b[0m');
    this._notifyChange();
  }

  // ── Internal: spawn Pyodide worker ────────────────────────────────────────

  _spawnWorker(key, code, pkgModules, pkgName, prefix = '') {
    const term = this.term;
    if (this.workers.size === 0) {
      term.writeln('\x1b[2m[pyodide] Initializing Python runtime — first run takes 10–30 s…\x1b[0m');
    }
    const workerCode = this._buildWorkerCode(code, pkgModules, pkgName, prefix);
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    worker.onmessage = (e) => {
      const { type, data } = e.data;
      switch (type) {
        case 'log':
          term.writeln(data.text);
          break;
        case 'ready':
          term.writeln(`\x1b[32m[${key}] Node running\x1b[0m`);
          break;
        case 'error':
          term.writeln(`\x1b[31m[${key}] Error: ${data.message}\x1b[0m`);
          if (data.traceback) {
            data.traceback.split('\n').forEach(l =>
              term.writeln(`\x1b[31m  ${l}\x1b[0m`));
          }
          break;
        case 'publish':
          window.rosBus.publish(data.topic, data.msgType, data.data);
          (this._workerNodes.get(key) || new Set()).forEach(n =>
            window.rosBus.trackPublisher(data.topic, n));
          break;
        case 'subscribe_notify':
          window.rosBus.trackSubscriber(data.topic, data.nodeName);
          break;
        case 'pub_declare':
          window.rosBus.trackPublisher(data.topic, data.nodeName, data.msgType);
          break;
        case 'node_register':
          if (!this._workerNodes.has(key)) this._workerNodes.set(key, new Set());
          this._workerNodes.get(key).add(data.name);
          window.rosBus.registerNode(data.name);
          break;
        case 'node_unregister':
          this._workerNodes.get(key)?.delete(data.name);
          window.rosBus.unregisterNode(data.name);
          break;
        case 'stopped':
          term.writeln(`\x1b[33m[${key}] Node exited\x1b[0m`);
          (this._workerNodes.get(key) || new Set()).forEach(n => window.rosBus.unregisterNode(n));
          this._workerNodes.delete(key);
          this.workers.delete(key);
          this._notifyChange();
          break;
      }
    };

    worker.onerror = (e) => {
      term.writeln(`\x1b[31m[${key}] Worker error: ${e.message}\x1b[0m`);
    };

    this.workers.set(key, worker);
    this._notifyChange();
    URL.revokeObjectURL(url);
  }

  _buildWorkerCode(userCode, pkgModules, pkgName, prefix = '') {
    const modulesJson = JSON.stringify(pkgModules);
    // Include pathname base so this works on GitHub Pages (/ROSPad/) and localhost (/)
    const baseUrl = window.location.origin + window.location.pathname.split('/').slice(0, -1).join('/');
    const pfxJson = JSON.stringify(prefix); // safe to embed in JS string literal
    return `
const _BASE = ${JSON.stringify(baseUrl)};
importScripts('https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.js');

const _PFX = ${pfxJson};
const postLog   = (text) => postMessage({ type: 'log', data: { text: _PFX + text } });
const postError = (msg, tb) => postMessage({ type: 'error', data: { message: msg, traceback: tb } });

// Worker-side rosbus: bridges Python <-> main thread via postMessage + BroadcastChannel
const _bc = new BroadcastChannel('rosbus');
const _subs = new Map();
const _topicReg = {};
let _registeredNodeName = null;

function _deepPlain(v) {
  if (v instanceof Map) {
    const o = {};
    v.forEach((val, k) => { o[String(k)] = _deepPlain(val); });
    return o;
  }
  if (Array.isArray(v)) return v.map(_deepPlain);
  return v;
}

self.rosBus = {
  publish(topic, msgType, data) {
    const d = _deepPlain(data);
    _topicReg[topic] = msgType;
    postMessage({ type: 'publish', data: { topic, msgType, data: d } });
    (_subs.get(topic) || []).forEach(s => { try { s.cb(d); } catch(_) {} });
  },
  subscribe(topic, msgType, cb) {
    if (!_subs.has(topic)) _subs.set(topic, []);
    const id = Math.random();
    _subs.get(topic).push({ id, cb });
    if (_registeredNodeName)
      postMessage({ type: 'subscribe_notify', data: { topic, msgType, nodeName: _registeredNodeName } });
    return id;
  },
  unsubscribe(topic, subId) {
    if (!_subs.has(topic)) return;
    _subs.set(topic, (_subs.get(topic)).filter(s => s.id !== subId));
  },
  registerNode(name) {
    _registeredNodeName = name;
    postMessage({ type: 'node_register', data: { name } });
  },
  unregisterNode(name) {
    postMessage({ type: 'node_unregister', data: { name } });
  },
  trackPublisher(topic, nodeName, msgType) {
    postMessage({ type: 'pub_declare', data: { topic, nodeName, msgType: msgType || '' } });
  },
  getNodes() { return []; },
  getTopics() {
    return Object.entries(_topicReg).map(([topic, msgType]) => ({ topic, msgType }));
  },
  advertiseService(name, handler) {},
  callService(name, request) { return Promise.resolve({}); }
};

_bc.onmessage = (e) => {
  const env = e.data;
  if (env && env._type === 'topic') {
    (_subs.get(env.topic) || []).forEach(s => { try { s.cb(env.data); } catch(e) {} });
  }
};

async function main() {
  try {
    const pyodide = await loadPyodide({
      stdout: (text) => postLog('\\x1b[0m' + text),
      stderr: (text) => postLog('\\x1b[31m' + text + '\\x1b[0m'),
    });

    await pyodide.loadPackage(['numpy']);

    // Pre-register rclpy package tree in sys.modules so imports resolve
    await pyodide.runPythonAsync(\`
import sys, types
for _n in ['rclpy', 'rclpy.node', 'rclpy.qos', 'rclpy.logging']:
    if _n not in sys.modules:
        sys.modules[_n] = types.ModuleType(_n)
\`);

    // msgs
    await pyodide.runPythonAsync(await (await fetch(_BASE + '/msgs/__init__.py')).text());

    // rclpy.qos
    const qosCode = await (await fetch(_BASE + '/rclpy/qos.py')).text();
    await pyodide.runPythonAsync(qosCode);
    await pyodide.runPythonAsync(\`
import sys; _g = globals(); _m = sys.modules['rclpy.qos']
for _k in ['QoSProfile','ReliabilityPolicy','DurabilityPolicy','HistoryPolicy',
           'qos_profile_sensor_data','qos_profile_system_default','qos_profile_services_default']:
    if _k in _g: setattr(_m, _k, _g[_k])
sys.modules['rclpy'].qos = _m
\`);

    // rclpy.logging
    const logCode = await (await fetch(_BASE + '/rclpy/logging.py')).text();
    await pyodide.runPythonAsync(logCode);
    await pyodide.runPythonAsync(\`
import sys; _g = globals(); _m = sys.modules['rclpy.logging']
for _k in ['LoggingSeverity','get_logger','set_logger_level']:
    if _k in _g: setattr(_m, _k, _g[_k])
sys.modules['rclpy'].logging = _m
\`);

    // rclpy.node
    const nodeCode = await (await fetch(_BASE + '/rclpy/node.py')).text();
    await pyodide.runPythonAsync(nodeCode);
    await pyodide.runPythonAsync(\`
import sys; _g = globals(); _m = sys.modules['rclpy.node']
for _k in ['Node','Publisher','Subscription','Timer','Service','ServiceClient',
           'Logger','Clock','Time','Parameter']:
    if _k in _g: setattr(_m, _k, _g[_k])
sys.modules['rclpy'].node = _m
\`);

    // rclpy/__init__.py (loaded last so from rclpy import node/qos/logging resolves)
    await pyodide.runPythonAsync(await (await fetch(_BASE + '/rclpy/__init__.py')).text());
    await pyodide.runPythonAsync(\`
import sys; _g = globals(); _m = sys.modules['rclpy']
for _k in ['init','shutdown','ok','spin','spin_once','spin_until_future_complete','create_node','_ROSpadSpin']:
    if _k in _g: setattr(_m, _k, _g[_k])
\`);

    // Extra package modules
    const pkgModules = ${modulesJson};
    for (const [modName, code] of Object.entries(pkgModules)) {
      await pyodide.runPythonAsync(code);
    }

    postMessage({ type: 'ready' });
    try {
      await pyodide.runPythonAsync(${JSON.stringify(userCode)});
      postMessage({ type: 'stopped' });
    } catch(runErr) {
      // Pyodide wraps Python exceptions as PythonError; check all string representations
      const _errStr = [
        String(runErr),
        runErr?.message,
        runErr?.type,
        runErr?.name,
      ].filter(Boolean).join(' ');
      if (_errStr.includes('_ROSpadSpin')) {
        // spin() raised its sentinel — node is alive via JS timers, do NOT stop
      } else {
        postError(runErr.message || String(runErr), runErr.stack || '');
        postMessage({ type: 'stopped' });
      }
    }

  } catch(e) {
    postError(e.message, e.stack);
  }
}

main();
`;
  }

  async _readPackageModules(pkg, pkgPath) {
    const modules = {};
    try {
      const files = await githubAPI.listDir(`${pkgPath}/${pkg}`);
      for (const f of files.filter(f => f.name.endsWith('.py') && f.name !== '__init__.py')) {
        modules[f.name.replace('.py', '')] = await githubAPI.readFile(f.path);
      }
    } catch(e) {}
    return modules;
  }
}

window.NodeManager = NodeManager;
