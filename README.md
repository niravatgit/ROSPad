# ROSpad — ROS2 IDE in the Browser

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![ROS2](https://img.shields.io/badge/ROS2-Humble%20%7C%20Iron-blue)](https://docs.ros.org/en/humble/)
[![Platform](https://img.shields.io/badge/platform-browser-lightgrey)](https://github.com/)

ROSpad is a zero-install, browser-based IDE for learning and teaching ROS2. Students open a URL, get a full Python editor, ROS2 terminal, live 3D simulator, topic monitor, and computation graph — no local installation required.

> Developed at IIT Madras for undergraduate robotics education.

---

## Features

| Feature | Description |
|---|---|
| **Monaco Editor** | Syntax highlighting, IntelliSense, multi-tab for `.py` and `.launch.py` files |
| **Python / ROS2 runtime** | Pyodide Web Worker executes `rclpy`-compatible Python nodes in the browser |
| **WebROS Bus** | BroadcastChannel-based pub/sub bus that emulates ROS2 DDS; full topic/node lifecycle |
| **3D Simulator** | Three.js scene with URDF robot loading, differential-drive kinematics, lidar scan, odometry |
| **Topic Monitor** | Live Hz readout, message inspector with formatted JSON payload |
| **Computation Graph** | Cytoscape.js bipartite graph — ros-nodes on the left, topics on the right, pub/sub edges |
| **Integrated Terminal** | xterm.js terminal running `ros2 run`, `ros2 topic echo/list/pub`, `colcon build` |
| **Multi-user** | Session-based auth; each user gets an isolated workspace directory |
| **Light / Dark Theme** | Toggle in the top bar; preference persisted to localStorage |

---

## Architecture

```
Browser
├── public/
│   ├── index.html          — Single-page app shell, topbar, panels
│   ├── rosbus.js           — WebROS pub/sub bus (BroadcastChannel + tracking maps)
│   ├── js/
│   │   ├── editor.js       — Monaco editor, file ops, tab management
│   │   ├── terminal.js     — xterm.js multi-tab terminal manager
│   │   ├── sim.js          — Three.js 3D simulator + URDF loader
│   │   ├── topics.js       — Topic Hz monitor + message inspector
│   │   ├── graph.js        — Cytoscape.js computation graph
│   │   ├── ui.js           — Panel resizing, tab switching, sidebar
│   │   └── app.js          — Top-level orchestration (auth, run/stop)
│   ├── ros2cli/
│   │   ├── ros2cli.js      — `ros2` CLI command dispatcher
│   │   └── node_manager.js — Worker lifecycle + publisher/subscriber tracking
│   └── rclpy/
│       ├── node.py         — rclpy.Node shim (Python, runs in Pyodide)
│       ├── publisher.py    — Publisher shim
│       └── subscriber.py   — Subscription shim
│
Server (Node.js / Express)
├── server/index.js         — HTTP server, session auth, file API, WebSocket
└── rospad_user_data/       — Per-user workspace directories (gitignored)
```

**Key design decisions:**

- **No server-side ROS2.** All pub/sub runs in the browser via `BroadcastChannel`. The server is a thin file/auth layer only.
- **Pyodide Web Workers.** Each `ros2 run` spawns a Worker running Pyodide; the `rclpy` shim translates Python node calls to `rosBus` messages.
- **Bipartite layout.** The computation graph uses a deterministic layout (no force simulation) — ros-nodes left column sorted alphabetically, topics right column sorted by weighted-average y-position of connected nodes, minimising edge crossings.

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- A modern browser (Chrome 90+, Firefox 88+, Edge 90+)
- No ROS2 installation required for students

### Installation

```bash
git clone https://github.com/<your-org>/rospad.git
cd rospad
npm install
```

### Configuration

Copy the example environment file and set a strong session secret:

```bash
cp .env.example .env
# Edit .env — set SESSION_SECRET to a long random string
```

### Running

```bash
npm start          # production
npm run dev        # development (auto-reload via nodemon)
```

Open `http://localhost:3000` in your browser.

### First Login

On first visit you will see a login screen. Create an account — the first account automatically gets instructor privileges. Additional accounts are student accounts.

---

## Usage

### Writing and running a ROS2 node

1. Click **+ File** and create `my_node.py`
2. Write an `rclpy`-compatible Python node (see examples below)
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
        msg.data = f'Hello from ROSpad'
        self.pub.publish(msg)

def main():
    rclpy.init()
    rclpy.spin(Talker())

main()
```

### Launching the 3D Simulator

The simulator starts automatically when a URDF is published to `/robot_description`. Use the provided `diffbot_description` package:

```bash
ros2 run rospad sim          # explicit start
ros2 launch diffbot_description diffbot.launch.py
```

Drive the robot:

```python
# publish Twist to /cmd_vel to move the simulated robot
```

### Terminal commands

| Command | Description |
|---|---|
| `ros2 run <pkg> <node>` | Run a Python node |
| `ros2 launch <pkg> <launch_file>` | Run a launch file |
| `ros2 topic list` | List active topics |
| `ros2 topic echo <topic>` | Stream messages |
| `ros2 topic hz <topic>` | Measure publish rate |
| `ros2 topic pub <topic> <type> <yaml>` | One-shot publish |
| `colcon build` | Build workspace packages |

---

## Deployment

ROSpad is a standard Node.js application and can be deployed on any Linux server or cloud VM.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | *(required in prod)* | Express session signing secret |
| `PORT` | `3000` | HTTP port |

### Example: systemd service

```ini
[Unit]
Description=ROSpad ROS2 IDE
After=network.target

[Service]
WorkingDirectory=/opt/rospad
ExecStart=/usr/bin/node server/index.js
Restart=always
EnvironmentFile=/opt/rospad/.env
User=rospad

[Install]
WantedBy=multi-user.target
```

### Reverse proxy (nginx)

```nginx
location / {
    proxy_pass         http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host $host;
}
```

---

## Adding ROS2 Packages

Place packages under `ros2_ws/src/`. Package meshes and URDF files are served at `/ros2/packages/<pkg>/...` and resolved from `package://` URLs automatically.

```
ros2_ws/src/
└── my_robot_description/
    ├── urdf/my_robot.urdf.xacro
    └── meshes/
        └── base.glb
```

---

## Supported rclpy API

The browser shim implements the most commonly used rclpy surface:

- `Node.__init__`, `Node.get_logger()`, `Node.get_clock()`
- `Node.create_publisher`, `Publisher.publish`
- `Node.create_subscription`
- `Node.create_timer`, `Node.destroy_timer`
- `Node.create_service`, `Node.create_client`
- `rclpy.init`, `rclpy.spin`, `rclpy.spin_once`, `rclpy.shutdown`

Message types: `std_msgs`, `geometry_msgs`, `sensor_msgs`, `nav_msgs`, `tf2_msgs` (common fields).

---

## Contributing

Pull requests are welcome. For major changes please open an issue first.

```bash
# Run linting
npm run lint   # (if configured)

# File structure convention
public/js/     — browser-side feature modules
server/        — Node.js/Express backend only
public/rclpy/  — Python shim files (Pyodide)
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
