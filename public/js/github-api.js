/**
 * github-api.js — drop-in replacement for the Express server API
 *
 * User workspace  → private GitHub repo "rospad-workspace" in the user's account
 * System packages → public ROSpad repo at ros2_ws/src/ (read-only, no auth needed)
 *
 * Configure before use:
 *   ROSPAD_CONFIG.oauthProxyUrl  — Cloudflare Worker URL for code→token exchange
 *   ROSPAD_CONFIG.githubClientId — GitHub App client_id
 *   ROSPAD_CONFIG.rospadRepo     — "owner/repo" of the ROSpad source repo
 */

// ── Config (set these to your own values after forking) ──────────────────────
window.ROSPAD_CONFIG = window.ROSPAD_CONFIG || {};
const CFG = window.ROSPAD_CONFIG;
CFG.oauthProxyUrl  = CFG.oauthProxyUrl  || 'https://rospad-oauth-proxy.nirav-robotics.workers.dev';
CFG.githubClientId = CFG.githubClientId || 'Iv23livCT8rM3eALvX0N';
CFG.githubAppSlug  = CFG.githubAppSlug  || 'rospad-ws';
CFG.workspaceRepo  = CFG.workspaceRepo  || 'rospad-workspace';

// ── GitHubAPI ─────────────────────────────────────────────────────────────────

class GitHubAPI {
  constructor() {
    this.token    = null;
    this.username = null;
  }

  init(token, username) {
    this.token    = token;
    this.username = username;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  _gh(path, opts = {}) {
    const headers = {
      'Accept':               'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return fetch(`https://api.github.com${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
  }

  async _get(path) {
    const r = await this._gh(path);
    if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}`), { status: r.status });
    return r.json();
  }

  // Base URL for static assets served by GitHub Pages (same origin as this page)
  _pagesBase() {
    return window.location.pathname.split('/').slice(0, -1).join('/');
  }

  async _put(path, body) {
    const r = await this._gh(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`GitHub PUT ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async _del(path, body) {
    const r = await this._gh(path, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok && r.status !== 404) throw new Error(`GitHub DELETE ${r.status}`);
  }

  // ── OAuth ──────────────────────────────────────────────────────────────────

  startOAuth() {
    const redirectUri = window.location.href.split('?')[0];
    if (localStorage.getItem('gh_app_installed')) {
      // Already installed — re-authorize only (no repo picker needed)
      const params = new URLSearchParams({ client_id: CFG.githubClientId, redirect_uri: redirectUri });
      window.location.href = `https://github.com/login/oauth/authorize?${params}`;
    } else {
      // First time — installation flow shows the repo picker.
      // "Request user authorization during installation" must be ON in GitHub App settings
      // so that GitHub issues an OAuth code after installation.
      window.location.href = `https://github.com/apps/${CFG.githubAppSlug}/installations/new`;
    }
  }

  async exchangeCode(code) {
    const r = await fetch(CFG.oauthProxyUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code }),
    });
    const data = await r.json();
    if (!data.access_token) throw new Error(data.error_description || 'OAuth failed');
    return data.access_token;
  }

  async fetchUser(token) {
    const r = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });
    if (!r.ok) throw new Error('Failed to fetch GitHub user');
    return r.json();
  }

  // ── Workspace repo bootstrap ───────────────────────────────────────────────

  async ensureWorkspaceRepo() {
    try {
      await this._get(`/repos/${this.username}/${CFG.workspaceRepo}`);
    } catch (e) {
      if (e.status === 404) {
        throw new Error(
          `Repo "${CFG.workspaceRepo}" not found in your account. ` +
          `Create it on GitHub (public or private), then re-authorize and grant ROSpad access to it.`
        );
      }
      if (e.status === 403) {
        throw new Error(
          `ROSpad doesn't have access to "${CFG.workspaceRepo}". ` +
          `Re-authorize and make sure you select that repo when GitHub asks.`
        );
      }
      throw e;
    }
    // Ensure src/ exists for user's own packages
    try {
      await this._get(`/repos/${this.username}/${CFG.workspaceRepo}/contents/src`);
    } catch {
      await this.mkdir('src');
    }

    // Seed demos/ once for every new user
    let demosExist = true;
    try {
      await this._get(`/repos/${this.username}/${CFG.workspaceRepo}/contents/demos`);
    } catch {
      demosExist = false;
    }
    if (!demosExist) await this._seedDemos();
  }

  async _seedDemos() {
    const base = this._pagesBase();
    const r = await fetch(`${base}/workspace-demos/index.json`);
    if (!r.ok) return;
    const tree = await r.json();

    const writeAll = async (nodes) => {
      for (const node of nodes) {
        const dest = `demos/${node.path}`;
        if (node.type === 'file') {
          const fr = await fetch(`${base}/workspace-demos/${node.path}`);
          if (fr.ok) await this.writeFile(dest, await fr.text());
        } else if (node.children?.length) {
          await writeAll(node.children);
        } else {
          await this.mkdir(dest);
        }
      }
    };
    await writeAll(tree);
  }

  // ── User workspace (paths relative to repo root, e.g. "src/my_pkg/node.py") ─

  async listDir(relPath) {
    const apiPath = relPath || '';
    try {
      const entries = await this._get(
        `/repos/${this.username}/${CFG.workspaceRepo}/contents/${apiPath}`
      );
      return entries
        .filter(e => e.name !== '.gitkeep')
        .map(e => ({
          name: e.name,
          type: e.type === 'dir' ? 'dir' : 'file',
          path: apiPath ? `${apiPath}/${e.name}` : e.name,
        }));
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  async readFile(relPath) {
    const data = await this._get(
      `/repos/${this.username}/${CFG.workspaceRepo}/contents/${relPath}`
    );
    return _b64decode(data.content);
  }

  async writeFile(relPath, content) {
    let sha;
    try {
      const existing = await this._get(
        `/repos/${this.username}/${CFG.workspaceRepo}/contents/${relPath}`
      );
      sha = existing.sha;
    } catch { /* new file */ }

    await this._put(
      `/repos/${this.username}/${CFG.workspaceRepo}/contents/${relPath}`,
      { message: `Update ${relPath}`, content: _b64encode(content), ...(sha ? { sha } : {}) }
    );
  }

  async deleteEntry(relPath) {
    // Works for files; for dirs recursively deletes all contents
    let data;
    try { data = await this._get(`/repos/${this.username}/${CFG.workspaceRepo}/contents/${relPath}`); }
    catch { return; }

    if (Array.isArray(data)) {
      for (const e of data) {
        if (e.type === 'dir') await this.deleteEntry(e.path);
        else await this._del(
          `/repos/${this.username}/${CFG.workspaceRepo}/contents/${e.path}`,
          { message: `Delete ${e.path}`, sha: e.sha }
        );
      }
    } else {
      await this._del(
        `/repos/${this.username}/${CFG.workspaceRepo}/contents/${relPath}`,
        { message: `Delete ${relPath}`, sha: data.sha }
      );
    }
  }

  async mkdir(relPath) {
    await this.writeFile(`${relPath}/.gitkeep`, '');
  }

  async rename(oldPath, newName) {
    const parent  = oldPath.split('/').slice(0, -1).join('/');
    const newPath = parent ? `${parent}/${newName}` : newName;
    let data;
    try { data = await this._get(`/repos/${this.username}/${CFG.workspaceRepo}/contents/${oldPath}`); }
    catch { return newPath; }

    if (Array.isArray(data)) {
      await _copyDir(this, oldPath, newPath);
      await this.deleteEntry(oldPath);
    } else {
      await this.writeFile(newPath, _b64decode(data.content));
      await this._del(
        `/repos/${this.username}/${CFG.workspaceRepo}/contents/${oldPath}`,
        { message: `Delete ${oldPath}`, sha: data.sha }
      );
    }
    return newPath;
  }

  // ── System packages — ROSpad's ros2_ws/src/ (read via static Pages URLs) ──

  async listRosDir(relPath) {
    // Load the static index once and cache it
    if (!this._pkgIndex) {
      const r = await fetch(`${this._pagesBase()}/ros2_ws/packages-index.json`);
      if (!r.ok) throw new Error(`Failed to load package index: ${r.status}`);
      this._pkgIndex = await r.json();
    }
    // Walk the cached tree to find the requested path
    const find = (nodes, parts) => {
      if (!parts.length) return nodes;
      const node = nodes.find(n => n.name === parts[0]);
      if (!node || !node.children) return [];
      return find(node.children, parts.slice(1));
    };
    const parts = relPath ? relPath.split('/') : [];
    return find(this._pkgIndex, parts);
  }

  async readRosFile(relPath) {
    const r = await fetch(`${this._pagesBase()}/ros2_ws/src/${relPath}`);
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return r.text();
  }

  // ── Package scaffolding ────────────────────────────────────────────────────

  async createPackage(name) {
    await Promise.all([
      this.writeFile(`src/${name}/package.xml`,    _packageXml(name)),
      this.writeFile(`src/${name}/setup.py`,        _setupPy(name)),
      this.writeFile(`src/${name}/${name}/__init__.py`, ''),
      this.writeFile(`src/${name}/launch/.gitkeep`, ''),
    ]);
    return `src/${name}`;
  }

  // ── Browser-side "shell" (ls / cat / pwd) for terminal.js ─────────────────

  async shell(cmd, cwd = 'src') {
    const parts = cmd.trim().split(/\s+/);
    const base  = parts[0];
    const arg   = parts[1] || '';

    if (base === 'pwd')  return `/${cwd}\r\n`;
    if (base === 'echo') return `${parts.slice(1).join(' ')}\r\n`;
    if (base === 'clear') return '\x1bc';

    if (base === 'ls' || base === 'll' || base === 'la') {
      const dir = arg ? `${cwd}/${arg}`.replace(/^\//, '') : cwd;
      const entries = await this.listDir(dir);
      if (!entries.length) return '(empty)\r\n';
      return entries.map(e => (e.type === 'dir' ? `\x1b[34m${e.name}/\x1b[0m` : e.name)).join('  ') + '\r\n';
    }

    if (base === 'cat') {
      if (!arg) return 'cat: missing file argument\r\n';
      const path = arg.startsWith('/') ? arg.slice(1) : `${cwd}/${arg}`;
      try { return (await this.readFile(path)) + '\r\n'; }
      catch { return `\x1b[31mcat: ${arg}: No such file\x1b[0m\r\n`; }
    }

    return `\x1b[31m${base}: command not available in browser environment\x1b[0m\r\n`;
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function _b64decode(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
}

async function _copyDir(api, srcPath, dstPath) {
  const entries = await api._get(
    `/repos/${api.username}/${CFG.workspaceRepo}/contents/${srcPath}`
  );
  for (const e of entries) {
    if (e.type === 'dir') {
      await _copyDir(api, e.path, `${dstPath}/${e.name}`);
    } else {
      const file    = await api._get(e.url.replace('https://api.github.com', ''));
      const content = _b64decode(file.content);
      await api.writeFile(`${dstPath}/${e.name}`, content);
    }
  }
}

function _packageXml(name) {
  return `<?xml version="1.0"?>
<package format="3">
  <name>${name}</name>
  <version>0.0.1</version>
  <description>ROS2 package: ${name}</description>
  <maintainer email="student@github.com">Student</maintainer>
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

function _setupPy(name) {
  return `from setuptools import setup

package_name = '${name}'

setup(
    name=package_name,
    version='0.0.1',
    packages=[package_name],
    install_requires=['setuptools'],
    entry_points={
        'console_scripts': [],
    },
)`;
}

// ── Singleton ─────────────────────────────────────────────────────────────────
window.githubAPI = new GitHubAPI();
