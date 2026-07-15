# ROSpad — Browser-Based ROS2 IDE

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![ROS2](https://img.shields.io/badge/ROS2-Humble%20%7C%20Iron-blue)](https://docs.ros.org/en/humble/)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-brightgreen)](https://niravatgit.github.io/ROSPad/)

ROSpad is a zero-install, browser-based IDE for learning and teaching ROS2. Students open a URL, write Python nodes, run them in a simulated ROS2 environment, visualise topics, and see a live 3D robot — no local installation required.

> Developed at IIT Madras for undergraduate robotics education.

---

## Two Ways to Use ROSpad

### Option A — GitHub Pages (online, no server needed)

**Best for:** individual learners, anyone with a GitHub account, workshops where everyone has internet access.

1. Visit **[https://niravatgit.github.io/ROSPad/](https://niravatgit.github.io/ROSPad/)**
2. Click **Login with GitHub**
3. Create a public or private repo named `rospad-workspace` in your account and grant ROSpad access to it
4. Start writing and running ROS2 nodes

Your workspace is stored in your own `rospad-workspace` GitHub repo. Demo packages (`talker_listener`, `demo_robot`, `turtlesim_demo`) and system packages (`ur5_description`, `diffbot_description`) are seeded automatically on first login.

> **Authentication** uses a GitHub App scoped to your `rospad-workspace` repo only — no access to your other repos. An OAuth proxy on Cloudflare Workers handles the token exchange; your credentials never leave GitHub.

---

### Option B — Self-Hosted Server (offline / LAN)

**Best for:** university classrooms without reliable internet, schools that want full data control, large cohorts on a local network.

Run ROSpad as a Node.js server on any Linux machine. Students connect over LAN — no internet needed, no GitHub account required.

```bash
git clone https://github.com/niravatgit/ROSPad.git
cd ROSPad
npm install
cp .env.example .env   # set SESSION_SECRET to a long random string
npm start              # http://localhost:3000
```

See **[DEPLOY.md](DEPLOY.md)** for the full nginx + systemd production setup guide.

---

## Features

| Feature | Description |
|---|---|
| **Monaco Editor** | Syntax highlighting, IntelliSense, multi-tab editing for `.py` and `.launch.py` files |
| **Python / ROS2 runtime** | Pyodide Web Worker executes `rclpy`-compatible Python nodes entirely in the browser |
| **WebROS Bus** | `BroadcastChannel`-based pub/sub bus that emulates ROS2 DDS — full topic/node lifecycle |
| **3D Simulator** | Three.js scene with URDF robot loading, differential-drive kinematics, lidar scan, odometry |
| **Topic Monitor** | Live Hz readout, message inspector with formatted JSON payload |
| **Computation Graph** | Cytoscape.js bipartite graph — ROS nodes on the left, topics on the right |
| **Integrated Terminal** | xterm.js terminal with `ros2 run`, `ros2 launch`, `ros2 topic echo/list/hz/pub`, `colcon build` |
| **File Tree** | Create, rename, delete, and download packages; workspace seeded with demo packages |
| **Light / Dark Theme** | Toggle in the top bar; persists to `localStorage` |

---

## Architecture

```
Browser
└── public/
    ├── index.html                    — Single-page app shell
    ├── coi-serviceworker.js          — Enables SharedArrayBuffer (needed by Pyodide)
    ├── ros2/
    │   ├── js/
    │   │   ├── editor.js             — Monaco editor, file ops, tab management
    │   │   ├── terminal.js           — xterm.js multi-tab terminal
    │   │   ├── sim.js                — Three.js 3D simulator + URDF loader
    │   │   ├── topics.js             — Topic Hz monitor + message inspector
    │   │   ├── graph.js              — Cytoscape.js computation graph
    │   │   ├── ui.js                 — Panel resizing, tab switching, sidebar
    │   │   ├── app.js                — Top-level orchestration (auth, run/stop)
    │   │   ├── ros2cli.js            — ros2 CLI command dispatcher
    │   │   ├── node_manager.js       — Worker lifecycle + pub/sub tracking
    │   │   ├── rosbus.js             — WebROS pub/sub bus (BroadcastChannel)
    │   │   └── github-api.js         — GitHub API abstraction (GitHub Pages mode)
    │   ├── rclpy/                    — Python shims (run inside Pyodide)
    │   └── msgs/                     — Message type stubs
    └── rospad-workspace/             — System packages + demo seeds (served statically)
        ├── src/
        │   ├── sys_packages/         — ur5_description, diffbot_description
        │   └── demos/                — talker_listener, demo_robot, turtlesim_demo
        ├── packages-index.json       — Package tree index
        └── src-index.json            — Full source tree for first-login seeding

Server (Node.js / Express) — self-hosted mode only
├── server/index.js                   — HTTP server, session auth, file API, WebSocket
└── rospad_user_data/                 — Per-user workspace directories (gitignored)

Cloudflare Worker — GitHub Pages mode only
└── cloudflare-worker/oauth-proxy.js  — GitHub OAuth code→token exchange proxy
```

**Key design decisions:**

- **No server-side ROS2.** All pub/sub runs in the browser via `BroadcastChannel`. The server is a thin file/auth layer only.
- **Pyodide Web Workers.** Each `ros2 run` spawns a Worker running Pyodide; the `rclpy` shim translates Python node calls to `rosBus` messages.
- **Static package index.** `packages-index.json` avoids GitHub API rate limits — system package structure is pre-indexed at build time.
- **Background seeding.** First-login workspace setup runs after auth completes so the IDE is usable immediately.

---

## Writing and Running a ROS2 Node

1. Open a file from the workspace tree, or click **+ File** to create one
2. Write an `rclpy`-compatible Python node
3. Click **▶ Run** — the node starts in a new terminal tab
4. Watch the **Topics** panel for live Hz readings
5. Click the **Graph** tab to see the computation graph

```python
import rclpy
from rclpy.node import Node
from std_msgs.msg import String

class Talker(Node):
    def __init__(self):
        super().__init__('talker')
        self.pub = self.create_publisher(String, '/chatter', 10)
        self.create_timer(1.0, self.cb)

    def cb(self):
        msg = String()
        msg.data = 'Hello from ROSpad'
        self.pub.publish(msg)

def main():
    rclpy.init()
    rclpy.spin(Talker())

main()
```

## Terminal Commands

| Command | Description |
|---|---|
| `ros2 run <pkg> <node>` | Run a Python node |
| `ros2 launch <pkg> <file>` | Run a launch file |
| `ros2 topic list` | List active topics |
| `ros2 topic echo <topic>` | Stream messages |
| `ros2 topic hz <topic>` | Measure publish rate |
| `ros2 topic pub <topic> <type> <yaml>` | One-shot publish |
| `colcon build` | Build workspace packages |

## 3D Simulator

The simulator activates when a URDF is published to `/robot_description`. Launch the included robots:

```bash
ros2 launch diffbot_description diffbot_bringup.launch.py
ros2 launch ur5_description ur5_bringup.launch.py
```

---

## Supported rclpy API

| Category | Methods |
|---|---|
| **Node lifecycle** | `Node.__init__`, `get_logger()`, `get_clock()`, `destroy_node()` |
| **Publishers** | `create_publisher()`, `Publisher.publish()` |
| **Subscriptions** | `create_subscription()` |
| **Timers** | `create_timer()`, `destroy_timer()` |
| **Services** | `create_service()`, `create_client()` |
| **Spin** | `rclpy.init()`, `rclpy.spin()`, `rclpy.spin_once()`, `rclpy.shutdown()` |

Message packages: `std_msgs`, `geometry_msgs`, `sensor_msgs`, `nav_msgs`, `tf2_msgs` (common fields).

---

## Forking / Running Your Own GitHub Pages Instance

1. Fork this repo on GitHub
2. Create a [GitHub App](https://github.com/settings/apps) with:
   - Callback URL: `https://<your-username>.github.io/<repo-name>/`
   - "Request user authorization during installation" → ON
   - Repository permissions: **Contents** — read/write
3. Deploy `cloudflare-worker/oauth-proxy.js` via [Wrangler](https://developers.cloudflare.com/workers/wrangler/) with secrets `GH_CLIENT_ID` and `GH_CLIENT_SECRET`
4. In `public/ros2/js/github-api.js` update `CFG.githubClientId`, `CFG.githubAppSlug`, and `CFG.oauthProxyUrl`
5. Enable GitHub Pages: Settings → Pages → Source: `deploy/github-pages` branch, `/public` folder

---

## Contributing

Pull requests are welcome. For major changes, open an issue first.

```
public/ros2/js/       — browser-side feature modules
server/               — Node.js/Express backend (self-hosted mode only)
public/ros2/rclpy/    — Python shim files (run inside Pyodide)
cloudflare-worker/    — OAuth proxy (GitHub Pages mode only)
```

Please do not commit `rospad_user_data/`, `node_modules/`, or `.env`.

---

## Citation

If you use ROSpad in academic work, please cite:

```bibtex
@article{rospad2024,
  title   = {ROSpad: A Browser-Based IDE for ROS2 Education},
  author  = {Patel, Nirav and others},
  journal = {Journal of Open Source Software},
  year    = {2024},
  doi     = {10.21105/joss.XXXXX}
}
```

---

## License

MIT — see [LICENSE](LICENSE).
