---
title: 'ROSpad: A Browser-Based IDE for ROS2 Education'
tags:
  - ROS2
  - robotics education
  - browser-based IDE
  - Python
  - WebAssembly
authors:
  - name: Nirav Patel
    orcid: 0000-0002-8113-6078
    affiliation: 1
affiliations:
  - name: Indian Institute of Technology Madras, Chennai, India
    index: 1
date: 2024-01-01
bibliography: paper.bib
---

# Summary

ROSpad is an open-source, browser-based integrated development environment (IDE) designed
for teaching and learning the Robot Operating System 2 (ROS2). It provides a complete
ROS2 programming environment that runs entirely in a web browser, requiring no local
software installation. Students open a URL and immediately have access to a Python editor,
a ROS2 terminal, a real-time 3D robot simulator, a live topic monitor, and an interactive
computation graph. ROSpad is built on Node.js, Pyodide WebAssembly, xterm.js, Monaco
Editor, Three.js, and Cytoscape.js.

# Statement of Need

Learning ROS2 traditionally demands a significant upfront investment in system
configuration: students must install Ubuntu, ROS2, and numerous Python packages, resolve
dependency conflicts, and configure environment variables — often before writing a single
line of robot code [@quigley2009ros]. This installation barrier disproportionately
affects students with limited hardware, those working on shared lab machines, and
introductory courses that cannot allocate multiple class sessions to setup [@fairchild2016ros].

Cloud-based robotics environments such as The Construct [@theconstruct] and ROS
Development Studio (RDS) exist but are either proprietary, subscription-based, or require
persistent cloud VMs. Tools like Jupyter for robotics [@jupyter] address interactive
notebooks but do not provide the full pub/sub middleware experience central to ROS2.

ROSpad addresses this gap by running the entire ROS2 programming model — nodes,
publishers, subscribers, services, and the DDS communication graph — in the browser. An
instructor deploys a single Node.js server; students join using any modern browser.
The architecture decouples the ROS2 learning experience from operating system and hardware
constraints, enabling it to be used in computer lab settings, on Chromebooks, or through
any remote access setup.

# Software Description

## Architecture

ROSpad consists of a thin Node.js/Express server and a rich browser-side application.

**WebROS Bus.** The core abstraction is `rosBus`, a singleton implemented with the
browser's `BroadcastChannel` API. It provides `publish`, `subscribe`, `advertiseService`,
and `callService` methods that emulate the ROS2 topic and service API. Nodes running in
separate Web Workers communicate via this shared channel, closely mirroring the DDS
pub/sub model.

**Python execution.** When a student runs `ros2 run <pkg> <node>`, a Dedicated Web Worker
is spawned and bootstraps Pyodide [@pyodide], a CPython port compiled to WebAssembly.
The worker loads an `rclpy` shim — pure Python files that implement `Node`,
`Publisher`, `Subscription`, `Timer`, and service classes on top of `rosBus`. Standard
`rclpy` code written for a real ROS2 installation runs unchanged inside ROSpad.

**3D Simulator.** ROSpad includes a Three.js-based differential-drive simulator
(`sim_bridge`) with URDF robot loading via a custom URDFLoader, lidar scan generation,
odometry integration, and tf frame broadcasting. The simulator starts automatically when
a URDF is published to `/robot_description`, matching the ROS2 convention used by
`robot_state_publisher`.

**Computation Graph.** A Cytoscape.js panel renders the live ROS2 computation graph.
Nodes appear in a left column, topics in a right column, with directed edges for
publishers (green) and subscribers (blue). The layout is deterministic and bipartite,
avoiding the instability of force-directed layouts when the graph changes during a
running session.

**Terminal.** An xterm.js multi-tab terminal dispatches a subset of the `ros2` CLI
(`run`, `launch`, `topic list/echo/hz/pub`) and `colcon build` by interpreting commands
client-side without a server-side ROS2 installation.

## Supported rclpy API

The browser shim covers the rclpy surface area most commonly encountered in ROS2
introductory courses:

- Node lifecycle (`init`, `spin`, `spin_once`, `shutdown`)
- Publishers and subscriptions with QoS profiles
- Timers and callbacks
- Services and clients
- Logging (`get_logger().info/warn/error`)
- Clock (`get_clock().now()`)
- Standard message types: `std_msgs`, `geometry_msgs`, `sensor_msgs`,
  `nav_msgs`, `tf2_msgs`

# Comparison with Existing Tools

| Tool | Browser-based | ROS2 pub/sub | 3D sim | Free & self-hosted |
|---|:---:|:---:|:---:|:---:|
| ROSpad | ✓ | ✓ | ✓ | ✓ |
| The Construct | ✓ | ✓ | ✓ | ✗ (paid) |
| ROS Dev Studio | ✓ | ✓ | partial | ✗ (paid) |
| JupyterLab + ROS | partial | ✓ | ✗ | ✓ |
| VS Code + ROS ext. | ✗ | ✓ | ✗ | ✓ |

# Usage in Education

ROSpad has been used at IIT Madras in undergraduate robotics lab courses. Students
execute publisher/subscriber examples, TurtleBot-style drive programs, and sensor
processing pipelines on the shared ROSpad server without any local configuration.
The instant-start environment significantly reduces lab session time lost to setup and
eliminates the "it works on my machine" class of problems.

# Acknowledgements

We thank the students of IIT Madras who provided feedback during the development of
ROSpad.

# References
