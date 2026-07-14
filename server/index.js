const express  = require('express');
const fs       = require('fs').promises;
const path     = require('path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const http     = require('http');
const WebSocket = require('ws');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const { exec } = require('child_process');
const os       = require('os');

const app  = express();
const PORT = 3000;

// ─── Directory constants ──────────────────────────────────────────────────────
const USER_DATA_ROOT = path.join(__dirname, '../rospad_user_data');
const USERS_FILE     = path.join(USER_DATA_ROOT, '.users.json');

if (!existsSync(USER_DATA_ROOT)) mkdirSync(USER_DATA_ROOT, { recursive: true });

// ─── User credential helpers ──────────────────────────────────────────────────
// Format: { username: { password: hash, role: 'admin'|'teacher'|'student' } }
// Teachers: 'admin' and 'nirav' have elevated roles; all else register as 'student'.
const TEACHER_USERNAMES = new Set(['nirav']);

function loadUsers() {
  try {
    const raw = JSON.parse(readFileSync(USERS_FILE, 'utf8'));
    // Migrate old format (plain hash strings → object)
    let migrated = false;
    for (const [u, v] of Object.entries(raw)) {
      if (typeof v === 'string') {
        raw[u] = { password: v, role: _defaultRole(u) };
        migrated = true;
      }
    }
    if (migrated) writeFileSync(USERS_FILE, JSON.stringify(raw, null, 2));
    return raw;
  } catch { return {}; }
}
function saveUsers(users) {
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function _defaultRole(username) {
  if (username === 'admin') return 'admin';
  if (TEACHER_USERNAMES.has(username)) return 'teacher';
  return 'student';
}
function getRole(users, username) {
  return users[username]?.role || _defaultRole(username);
}

// ─── Per-user workspace helper ────────────────────────────────────────────────
function getUserWorkspace(req) {
  const ws = path.join(USER_DATA_ROOT, req.session.username, 'workspace');
  if (!existsSync(ws)) mkdirSync(path.join(ws, 'src'), { recursive: true });
  return ws;
}

// ─── Required headers for SharedArrayBuffer + Pyodide ────────────────────────
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));
// Also serve ros2_ws at /ros2/packages for backwards compat with any old links
app.use('/ros2/packages', express.static(ROS2_WS_SRC, { dotfiles: 'ignore' }));

// ─── ROS2 system workspace (shared packages: ur5_description, etc.) ──────────
// Resolves package:// URLs → GET /ros2/packages/:pkg/...
// e.g. package://ur5_description/meshes/visual/base.glb
//    → /ros2/packages/ur5_description/meshes/visual/base.glb
//    → /home/user/rospad/ros2_ws/src/ur5_description/meshes/visual/base.glb
const ROS2_WS_SRC = path.join(__dirname, '../ros2_ws/src');
app.use('/ros2/packages', express.static(ROS2_WS_SRC, { dotfiles: 'ignore' }));

// ─── Session middleware ───────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'rospad-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }  // 7 days
}));

// ─── Auth routes (public — no login required) ─────────────────────────────────

app.get('/api/me', (req, res) => {
  if (req.session.username) {
    const users = loadUsers();
    const role  = getRole(users, req.session.username);
    res.json({ username: req.session.username, role });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, underscore.' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });

  const users = loadUsers();
  if (users[username])
    return res.status(409).json({ error: 'Username already taken.' });

  const role = _defaultRole(username);   // student (or teacher if username is in TEACHER_USERNAMES)
  users[username] = { password: await bcrypt.hash(password, 10), role };
  saveUsers(users);

  // Create workspace directory
  mkdirSync(path.join(USER_DATA_ROOT, username, 'workspace', 'src'), { recursive: true });

  req.session.username = username;
  res.json({ ok: true, username, role });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  if (!users[username])
    return res.status(401).json({ error: 'Invalid username or password.' });
  const hash = typeof users[username] === 'string' ? users[username] : users[username].password;
  const ok   = await bcrypt.compare(password, hash);
  if (!ok)
    return res.status(401).json({ error: 'Invalid username or password.' });

  req.session.username = username;

  // Ensure workspace exists
  const wsrc = path.join(USER_DATA_ROOT, username, 'workspace', 'src');
  if (!existsSync(wsrc)) mkdirSync(wsrc, { recursive: true });

  const role = getRole(users, username);
  res.json({ ok: true, username, role });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── Auth guard for all remaining /api/* routes ───────────────────────────────
app.use('/api/', (req, res, next) => {
  if (!req.session.username)
    return res.status(401).json({ error: 'Not authenticated' });
  next();
});

// ─── Role-based middleware ────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const users = loadUsers();
  if (getRole(users, req.session.username) !== 'admin')
    return res.status(403).json({ error: 'Admin only.' });
  next();
}
function requireTeacher(req, res, next) {
  const users = loadUsers();
  const role  = getRole(users, req.session.username);
  if (role !== 'admin' && role !== 'teacher')
    return res.status(403).json({ error: 'Teacher or admin only.' });
  next();
}

// List all users with workspace info
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = loadUsers();
  const list  = Object.keys(users).map(username => ({
    username,
    role:         getRole(users, username),
    hasWorkspace: existsSync(path.join(USER_DATA_ROOT, username, 'workspace')),
  }));
  res.json(list);
});

// Reset a user's password
app.post('/api/admin/reset-password', requireAdmin, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!username || !newPassword)
    return res.status(400).json({ error: 'Username and new password required.' });
  if (newPassword.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  const users = loadUsers();
  if (!users[username])
    return res.status(404).json({ error: 'User not found.' });
  users[username].password = await bcrypt.hash(newPassword, 10);
  saveUsers(users);
  res.json({ ok: true });
});

// Change a user's role (admin only)
app.post('/api/admin/set-role', requireAdmin, (req, res) => {
  const { username, role } = req.body;
  if (!username || !['student', 'teacher'].includes(role))
    return res.status(400).json({ error: 'username and role (student|teacher) required.' });
  if (username === 'admin')
    return res.status(400).json({ error: 'Cannot change admin role.' });
  const users = loadUsers();
  if (!users[username])
    return res.status(404).json({ error: 'User not found.' });
  users[username].role = role;
  saveUsers(users);
  res.json({ ok: true });
});

// Register a teacher account (admin or teacher can do this)
app.post('/api/admin/register-teacher', requireAdmin, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username: 3–20 chars, letters/numbers/underscore.' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  const users = loadUsers();
  if (users[username])
    return res.status(409).json({ error: 'Username already taken.' });
  users[username] = { password: await bcrypt.hash(password, 10), role: 'teacher' };
  saveUsers(users);
  mkdirSync(path.join(USER_DATA_ROOT, username, 'workspace', 'src'), { recursive: true });
  res.json({ ok: true, username, role: 'teacher' });
});

// Delete a user (workspace preserved on disk)
app.delete('/api/admin/user/:username', requireAdmin, (req, res) => {
  const { username } = req.params;
  if (username === 'admin')
    return res.status(400).json({ error: 'Cannot delete the admin account.' });
  const users = loadUsers();
  if (!users[username])
    return res.status(404).json({ error: 'User not found.' });
  delete users[username];
  saveUsers(users);
  res.json({ ok: true });
});

// ─── FILE API ─────────────────────────────────────────────────────────────────

// List directory
app.get('/api/files', async (req, res) => {
  const rel = req.query.path || '';
  const abs = path.join(getUserWorkspace(req), rel);
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const result = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      path: path.join(rel, e.name).replace(/\\/g, '/')
    }));
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Read file
app.get('/api/file', async (req, res) => {
  const abs = path.join(getUserWorkspace(req), req.query.path);
  try {
    const content = await fs.readFile(abs, 'utf8');
    res.json({ content });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Write file
app.put('/api/file', async (req, res) => {
  try {
    const abs = path.join(getUserWorkspace(req), req.body.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, req.body.content ?? '', 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create directory
app.post('/api/mkdir', async (req, res) => {
  try {
    const abs = path.join(getUserWorkspace(req), req.body.path);
    await fs.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete file or directory
app.delete('/api/file', async (req, res) => {
  try {
    const abs = path.join(getUserWorkspace(req), req.query.path);
    await fs.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rename file or directory (in-place — same parent directory)
app.post('/api/rename', async (req, res) => {
  try {
    const ws      = getUserWorkspace(req);
    const oldAbs  = path.join(ws, req.body.path);
    const newName = path.basename(req.body.newName || '');  // basename prevents path traversal
    if (!newName) return res.status(400).json({ error: 'newName required' });
    const newAbs  = path.join(path.dirname(oldAbs), newName);
    await fs.rename(oldAbs, newAbs);
    const newPath = path.join(path.dirname(req.body.path), newName).replace(/\\/g, '/');
    res.json({ ok: true, newPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download a single file
app.get('/api/download', (req, res) => {
  const abs = path.join(getUserWorkspace(req), req.query.path || '');
  res.download(abs, err => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File not found' });
  });
});

// Download a directory (or file) as a zip
app.get('/api/zip', async (req, res) => {
  try {
    const rel  = req.query.path;
    if (!rel) return res.status(400).json({ error: 'path required' });
    const abs  = path.join(getUserWorkspace(req), rel);
    const name = path.basename(abs);
    const tmp  = path.join(os.tmpdir(), `rospad_${Date.now()}_${name}.zip`);
    await new Promise((resolve, reject) => {
      exec(`zip -r "${tmp}" "${name}"`, { cwd: path.dirname(abs) }, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });
    res.download(tmp, `${name}.zip`, () => require('fs').unlink(tmp, () => {}));
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ─── ROS2 system workspace file browser (read-only) ──────────────────────────
// Lists / reads files under ros2_ws/src/ for the sidebar System Packages tree.

app.get('/api/ros2/files', async (req, res) => {
  const rel = req.query.path || '';
  const abs = path.resolve(ROS2_WS_SRC, rel);
  if (!abs.startsWith(ROS2_WS_SRC)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const result = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: path.join(rel, e.name).replace(/\\/g, '/')
      }));
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/api/ros2/file', async (req, res) => {
  const abs = path.resolve(ROS2_WS_SRC, req.query.path || '');
  if (!abs.startsWith(ROS2_WS_SRC)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const content = await fs.readFile(abs, 'utf8');
    res.json({ content });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Create ROS2 package scaffold
app.post('/api/create-package', async (req, res) => {
  const { name } = req.body;
  const ws       = getUserWorkspace(req);
  const pkgDir   = path.join(ws, 'src', name);
  const innerDir = path.join(pkgDir, name);

  await fs.mkdir(innerDir, { recursive: true });
  await fs.mkdir(path.join(pkgDir, 'launch'), { recursive: true });

  await fs.writeFile(path.join(pkgDir, 'package.xml'), packageXml(name));
  await fs.writeFile(path.join(pkgDir, 'setup.py'),    setupPy(name));
  await fs.writeFile(path.join(innerDir, '__init__.py'), '');

  res.json({ ok: true, path: `src/${name}` });
});

// ─── Restricted shell for file/directory commands ────────────────────────────
// Only a whitelist of safe FS-inspection/manipulation commands is allowed.
// Execution of scripts or binaries is blocked server-side.
const SHELL_ALLOWED = new Set([
  'ls','ll','la','dir',
  'pwd','echo','cat','head','tail','wc','stat','file',
  'grep','egrep','fgrep','find',
  'mkdir','touch','cp','mv','rm','rmdir','chmod','chown',
  'sort','uniq','cut','awk','sed','tr','diff','comm',
  'du','df','env','printenv','date','uname',
]);
// Shell metacharacters, script execution, and home-dir expansion are all blocked.
const SHELL_BLOCKED_RE = /[;&|`$(){}[\]<>\\~!]|(\bsudo\b|\bsu\b|\bchroot\b|\bexec\b|\beval\b|\bsource\b|\b\.\s|\bpython\b|\bpython3\b|\bnode\b|\bbash\b|\bsh\b|\bzsh\b|\bfish\b|\bperl\b|\bruby\b|\bjava\b|\bgcc\b|\bg\+\+\b|\bmake\b|\bcolcon\b|\bsystemctl\b|\bservice\b|\bcrontab\b|\bat\b|\bnohup\b|\bdaemon\b)/;

app.post('/api/shell', async (req, res) => {
  try {
    const ws  = getUserWorkspace(req);
    const cwd = path.join(ws, 'src');
    const cmd = (req.body.cmd || '').trim();
    if (!cmd) return res.json({ output: '' });

    const tokens = cmd.split(/\s+/);
    const base   = tokens[0].replace(/^.*\//, ''); // strip any path prefix from command itself

    if (!SHELL_ALLOWED.has(base)) {
      return res.json({ output: `\x1b[31mCommand not available: ${base}\x1b[0m\r\nOnly file/directory commands are supported in this terminal.\r\n` });
    }
    if (SHELL_BLOCKED_RE.test(cmd)) {
      return res.json({ output: `\x1b[31mShell operators and script execution are not permitted.\x1b[0m\r\n` });
    }

    // Verify all non-flag arguments resolve within the user's workspace.
    // This blocks both absolute paths (/etc/passwd) and parent traversal (../../).
    for (const tok of tokens.slice(1)) {
      if (!tok || tok.startsWith('-')) continue;  // skip flags like -l, -name, --all
      const resolved = path.resolve(cwd, tok);
      // Allow ws itself and anything inside it; block everything else.
      if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
        return res.json({ output: `\x1b[31mAccess denied: paths outside your workspace are not permitted.\x1b[0m\r\n` });
      }
    }

    await new Promise((resolve) => {
      exec(cmd, { cwd, timeout: 5000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        const out = (stdout || '') + (stderr || '');
        res.json({ output: out || (err ? err.message : '') });
        resolve();
      });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WebSocket for terminal output streaming ──────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  });
});

function broadcast(data) {
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data));
  });
}

server.listen(PORT, () => {
  console.log(`ROSpad server running on http://localhost:${PORT}`);
  console.log(`User data: ${USER_DATA_ROOT}`);
});

// ─── Template strings ─────────────────────────────────────────────────────────
function packageXml(name) {
  return `<?xml version="1.0"?>
<package format="3">
  <name>${name}</name>
  <version>0.0.1</version>
  <description>ROS2 package: ${name}</description>
  <maintainer email="student@iitm.ac.in">Student</maintainer>
  <license>Apache-2.0</license>
  <depend>rclpy</depend>
  <depend>std_msgs</depend>
  <depend>geometry_msgs</depend>
  <depend>sensor_msgs</depend>
  <export>
    <build_type>ament_python</build_type>
  </export>
</package>`;
}

function setupPy(name) {
  return `from setuptools import setup

package_name = '${name}'

setup(
    name=package_name,
    version='0.0.1',
    packages=[package_name],
    install_requires=['setuptools'],
    entry_points={
        'console_scripts': [
            # e.g. 'my_node = ${name}.my_node:main',
        ],
    },
)`;
}

function defaultNode(name) {
  return `import rclpy
from rclpy.node import Node
from std_msgs.msg import String


class MyNode(Node):
    def __init__(self):
        super().__init__('my_node')
        self.publisher_ = self.create_publisher(String, '/chatter', 10)
        self.timer = self.create_timer(1.0, self.timer_callback)
        self.get_logger().info('MyNode started!')

    def timer_callback(self):
        msg = String()
        msg.data = f'Hello from ${name}!'
        self.publisher_.publish(msg)
        self.get_logger().info(f'Publishing: {msg.data}')


def main(args=None):
    rclpy.init(args=args)
    node = MyNode()
    rclpy.spin(node)
    rclpy.shutdown()
`;
}

function defaultLaunch(name) {
  return `from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        Node(
            package='${name}',
            executable='my_node',
            name='my_node',
            output='screen',
        ),
    ])
`;
}
