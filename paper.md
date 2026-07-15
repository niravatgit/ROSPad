---
title: 'ROSpad: A Zero-Install Browser IDE for Teaching ROS2'
tags:
  - ROS2
  - robotics education
  - browser-based IDE
  - WebAssembly
  - Pyodide
  - Python
authors:
  - name: Nirav Patel
    orcid: 0000-0002-8113-6078
    affiliation: 1
affiliations:
  - name: Indian Institute of Technology Madras, Chennai, India
    index: 1
date: 2025-07-15
bibliography: paper.bib
---

# Summary

ROSpad is an open-source, browser-based integrated development environment (IDE) for
teaching and learning the Robot Operating System 2 (ROS2) [@macenski2022robot]. It
provides a complete ROS2 programming environment that runs entirely in a web browser with
no local software installation. A student navigates to a URL and immediately has access to
a Python code editor (Monaco [@monaco]), a multi-session ROS2 terminal, a real-time 3D
robot simulator (Three.js), a live computation graph (Cytoscape.js), and a file tree for
workspace management. Python nodes are executed by Pyodide [@pyodide], a CPython port
compiled to WebAssembly [@webassembly], running in isolated Web Workers inside the
browser. ROSpad supports two deployment models: a zero-infrastructure GitHub Pages mode
and a self-hosted Node.js server for LAN classrooms.

# Statement of Need

Learning ROS2 has a well-documented setup barrier. Before writing a single line of robot
code, students must install a supported Linux distribution, ROS2 itself, and numerous
Python packages, resolve dependency conflicts, and configure environment variables
[@quigley2009ros; @fairchild2016ros]. This barrier is particularly costly in laboratory
sessions: a significant fraction of available time is consumed by installation failures,
version mismatches, and machine-specific issues. Students on Windows, macOS, or
low-powered hardware face additional obstacles.

Cloud-based alternatives exist but carry their own costs. The Construct [@theconstruct]
and ROS Development Studio are proprietary, subscription-based services. Robo-stack and
conda-based ROS2 distributions reduce installation complexity but still require a local
Python environment. JupyterLab with ROS2 extensions [@jupyter] provides interactive
notebooks but does not replicate the pub/sub middleware experience central to ROS2
programming. No existing tool combines full rclpy API compatibility, an in-browser 3D
simulator, and zero-cost self-hosting.

ROSpad is designed for a specific educational setting: a classroom or computer lab where
an instructor controls one server (or no server at all) and students bring any device with
a modern browser. The entire ROS2 programming model — nodes, publishers, subscribers,
services, timers, and the DDS computation graph — is available immediately. Code written
in ROSpad runs on a real ROS2 installation without modification, so students are learning
transferable skills, not a simulation-specific API.

# Software Architecture

## Execution Model

Each invocation of `ros2 run <pkg> <node>` spawns a Dedicated Web Worker. The worker
bootstraps Pyodide and loads an `rclpy` compatibility shim — pure Python modules that
implement `Node`, `Publisher`, `Subscription`, `Timer`, `Service`, and `ServiceClient`
on top of a JavaScript message bus. Worker isolation mirrors real ROS2 process isolation:
nodes do not share memory, and a crashing node does not affect other running nodes.

![ROSpad architecture. Each Python node runs in an isolated Web Worker backed by Pyodide.
Nodes communicate through the `rosBus` BroadcastChannel. The main thread manages the
editor, simulator, and terminal panels.](figures/architecture.png)

## Communication Bus

The core abstraction is `rosBus`, implemented using the browser's `BroadcastChannel`
API on the channel name `rosbus`. It exposes `publish`, `subscribe`, `advertiseService`,
and `callService` methods that emulate the ROS2 topic and service interface. All workers
in the same browsing context receive messages posted by any other worker, closely
mirroring the DDS multicast model. Topic messages are additionally relayed through the
main thread to support graph tracking and terminal introspection commands (`ros2 topic
echo`, `ros2 topic hz`).

Services use a direct Worker-to-Worker BroadcastChannel routing: a `service_call` message
carries a unique `callId`; any worker that has registered a handler for the named service
invokes it and posts a `service_response` message; the calling worker resolves a pending
Promise keyed by `callId`. A 5-second timeout rejects unanswered calls. This design
means both `create_service` and `create_client` / `call_async` behave identically to
real rclpy with no additional server infrastructure.

## rclpy Compatibility Shim

The shim (`public/ros2/rclpy/`) implements the rclpy surface area most commonly
encountered in introductory ROS2 courses:

| rclpy feature | Status |
|---|---|
| Node lifecycle (`init`, `spin`, `shutdown`) | Full |
| Publishers and subscriptions | Full |
| Timers | Full |
| Services and clients (`create_service`, `create_client`, `call_async`) | Full |
| Logging (`get_logger().info/warn/error/debug`) | Full |
| Parameters (`declare_parameter`, `get_parameter`) | Full |
| Clock (`get_clock().now()`) | Full |
| Standard message types (`std_msgs`, `geometry_msgs`, `sensor_msgs`, `nav_msgs`) | Full |
| Actions | Not implemented |
| `ros2 bag record/play` | Not implemented |

Code written against this shim passes through to a real ROS2 installation unchanged
because the shim exposes the same class names, method signatures, and import paths as
`rclpy`.

## 3D Simulator

A Three.js-based simulator loads URDF robot descriptions published to
`/robot_description`, matching the ROS2 `robot_state_publisher` convention. The simulator
subscribes to `/joint_states` to animate articulated arms, `/cmd_vel` for differential
drive, and `/odom` for odometry. It publishes synthetic `/scan` (LaserScan) data,
allowing students to write sensor-processing nodes against a virtual lidar. Two bundled
robots are provided: a differential-drive robot (DiffBot) and a 6-DOF manipulator (UR5).
A TurtleSim-style 2D turtle is also available for introductory exercises.

## Workspace and Deployment

ROSpad supports two deployment modes that share identical browser-side code:

**GitHub Pages mode.** The entire IDE is served as a static site with no backend server.
User authentication uses a GitHub App (OAuth 2.0); a lightweight Cloudflare Worker
exchanges the OAuth code for a token without exposing a client secret. Workspace files
(Python nodes, launch files, `setup.py`) are stored in the user's private GitHub
repository via the GitHub Contents API. This mode requires zero server management and
scales to any number of simultaneous users within GitHub's API rate limits.

**LAN server mode.** A Node.js/Express server provides session-based authentication,
user-scoped file storage, and WebSocket-based terminal output streaming. This mode
targets institutions with stable LAN infrastructure and is appropriate for offline or
air-gapped environments. The same student-facing browser code runs in both modes.

Workspace seeding is incremental: `src-index.json` describes the full demo package tree,
and the seeding logic checks each package individually before writing, so packages the
student has already modified are not overwritten when new demo packages are added.

# Analysis

## Startup Latency

Pyodide downloads and initialises CPython in the browser on the first node execution of
a session (~10–20 seconds on a campus network connection with warm CDN caches). All
subsequent node runs in the same session reuse the cached Pyodide environment and start
in under one second. The initial latency is a one-time per-session cost and does not
recur between exercises.

## Message Bus Throughput

The `BroadcastChannel`-based `rosBus` can sustain topic rates well above the 10–20 Hz
used by typical student exercises. In practice, the UR5 simulator publishes
`sensor_msgs/JointState` at 20 Hz across six joints without observable lag on standard
laptop hardware. The throughput is bounded by JavaScript serialization cost (structured
clone) rather than network latency, since all communication occurs within a single browser
tab.

## API Transfer to Real ROS2

The rclpy shim deliberately exposes identical Python import paths and method signatures to
real `rclpy`. During validation, student code from ROSpad exercises was executed against a
ROS2 Humble installation on Ubuntu 22.04 without modification. Publishers, subscribers,
timers, and service clients all behaved identically. The primary incompatibility is the
absence of ROS2 Actions, which are not required by the introductory curriculum covered by
ROSpad.

# Educational Deployment

ROSpad has been deployed at the Indian Institute of Technology Madras for undergraduate
robotics laboratory courses. Students with no prior Linux or ROS2 experience reached the
point of running a publisher/subscriber pair within the first 30 minutes of a lab session.
The same setup time in a traditional ROS2 installation environment occupied a full 2-hour
lab session or required pre-configured virtual machines. The elimination of the
installation step allowed instructors to focus lab time on ROS2 concepts — nodes,
topics, services, and control loops — rather than system administration.

The GitHub Pages deployment mode has been made publicly available, allowing students to
continue exercises outside the classroom on their own devices without any server access.

# Acknowledgements

The authors thank the students of IIT Madras who participated in early deployments of
ROSpad and whose feedback shaped the current design. The authors also thank the
developers of Pyodide, Monaco Editor, Three.js, xterm.js, and Cytoscape.js, whose
open-source libraries make ROSpad possible.

# References
