/**
 * ros2cli.js — Browser implementation of ros2 CLI commands
 * Intercepts terminal commands and routes to WebROS bus
 */

class ROS2CLI {
  constructor(bus, terminal, nodeManager) {
    this.bus = bus;
    this.term = terminal;
    this.nodeManager = nodeManager;
    this._echoSubs = new Map();
    this._hzTrackers = new Map();
  }

  // Main entry point — parse and dispatch
  async execute(cmdStr) {
    const args = cmdStr.trim().split(/\s+/);
    if (args[0] !== 'ros2') return false;

    const sub = args[1];
    const cmd = args[2];

    try {
      switch (sub) {
        case 'topic':   await this._topic(cmd, args.slice(3)); break;
        case 'node':    await this._node(cmd, args.slice(3)); break;
        case 'run':     await this._run(args[2], args[3], args.slice(4)); break;
        case 'launch':  await this._launch(args[2], args[3], args.slice(4)); break;
        case 'pkg':     await this._pkg(cmd, args.slice(3)); break;
        case 'param':   await this._param(cmd, args.slice(3)); break;
        case 'bag':     await this._bag(cmd, args.slice(3)); break;
        case 'service': await this._service(cmd, args.slice(3)); break;
        case '--help':
        case 'help':    this._help(); break;
        default:
          this.term.writeln(`\x1b[31mUnknown ros2 subcommand: ${sub}\x1b[0m`);
      }
    } catch (e) {
      this.term.writeln(`\x1b[31m[ERROR] ${e.message}\x1b[0m`);
    }
    return true;
  }

  // ── ros2 topic ─────────────────────────────────────────────────────────────

  async _topic(cmd, args) {
    switch (cmd) {
      case 'list': {
        const topics = this.bus.getTopics();
        if (topics.length === 0) {
          this.term.writeln('(no topics active)');
        } else {
          topics.forEach(t => this.term.writeln(`\x1b[36m${t.topic}\x1b[0m`));
        }
        break;
      }
      case 'echo': {
        const topic = args[0];
        if (!topic) { this.term.writeln('Usage: ros2 topic echo <topic>'); return; }
        this.term.writeln(`\x1b[33mListening on ${topic} (Ctrl+C to stop)\x1b[0m`);
        const subId = this.bus.subscribe(topic, '*', (data) => {
          this.term.writeln('---');
          this.term.writeln(JSON.stringify(data, null, 2)
            .split('\n').map(l => `\x1b[32m${l}\x1b[0m`).join('\r\n'));
        });
        this._echoSubs.set(topic, subId);
        break;
      }
      case 'hz': {
        const topic = args[0];
        if (!topic) { this.term.writeln('Usage: ros2 topic hz <topic>'); return; }
        let count = 0, last = performance.now();
        const tracker = { count: 0, times: [] };
        this._hzTrackers.set(topic, tracker);
        this.bus.subscribe(topic, '*', () => {
          const now = performance.now();
          tracker.times.push(now);
          tracker.times = tracker.times.filter(t => now - t < 5000);
          if (tracker.times.length > 1) {
            const hz = (tracker.times.length - 1) /
              ((tracker.times[tracker.times.length-1] - tracker.times[0]) / 1000);
            this.term.writeln(`\r\x1b[2K[${topic}] Hz: \x1b[32m${hz.toFixed(2)}\x1b[0m`);
          }
        });
        break;
      }
      case 'info': {
        const topic = args[0];
        const topics = this.bus.getTopics();
        const info = topics.find(t => t.topic === topic);
        if (info) {
          this.term.writeln(`Type: \x1b[36m${info.msgType}\x1b[0m`);
          this.term.writeln(`Message count: ${info.count}`);
        } else {
          this.term.writeln(`Topic ${topic} not found`);
        }
        break;
      }
      case 'pub': {
        const topic   = args[0];
        const msgType = args[1];
        if (!topic || !msgType) {
          this.term.writeln('Usage: ros2 topic pub <topic> <type> \'{"field":value}\'');
          return;
        }
        // Rejoin remaining args (JSON may contain spaces), then strip wrapping quotes
        const raw = args.slice(2).join(' ').trim().replace(/^['"`]|['"`]$/g, '');
        try {
          const data = JSON.parse(raw || '{}');
          this.bus.publish(topic, msgType, data);
          this.term.writeln(`\x1b[32mPublished to ${topic}\x1b[0m`);
        } catch(e) {
          this.term.writeln(`\x1b[31mBad JSON: ${e.message}\x1b[0m`);
          this.term.writeln(`\x1b[33m  got: ${raw}\x1b[0m`);
        }
        break;
      }
      default:
        this.term.writeln('Usage: ros2 topic {list|echo|hz|info|pub}');
    }
  }

  // ── ros2 node ──────────────────────────────────────────────────────────────

  async _node(cmd, args) {
    switch (cmd) {
      case 'list': {
        const nodes = this.bus.getNodes();
        if (nodes.length === 0) {
          this.term.writeln('(no nodes running)');
        } else {
          nodes.forEach(n => this.term.writeln(`\x1b[36m/${n}\x1b[0m`));
        }
        break;
      }
      case 'info': {
        const name = args[0]?.replace(/^\//, '');
        this.term.writeln(`Node: \x1b[36m/${name}\x1b[0m`);
        const topics = this.bus.getTopics();
        this.term.writeln('Topics (active):');
        topics.forEach(t => this.term.writeln(`  \x1b[33m${t.topic}\x1b[0m [${t.msgType}]`));
        break;
      }
      default:
        this.term.writeln('Usage: ros2 node {list|info}');
    }
  }

  // ── ros2 run ───────────────────────────────────────────────────────────────

  async _run(pkg, executable, extraArgs) {
    if (!pkg || !executable) {
      this.term.writeln('Usage: ros2 run <package> <executable>');
      return;
    }
    // Write to the originating terminal BEFORE switching tabs
    this.term.writeln(`\x1b[33mStarting ${pkg}/${executable} — opening new terminal tab...\x1b[0m`);
    const session = window.termManager.addNodeSession(executable);
    session.xterm.writeln(`\x1b[2m▶  ros2 run ${pkg} ${executable}\x1b[0m`);
    await session.nodeManager.runNode(pkg, executable);
  }

  // ── ros2 launch ────────────────────────────────────────────────────────────

  async _launch(pkg, launchFile, extraArgs) {
    if (!pkg || !launchFile) {
      this.term.writeln('Usage: ros2 launch <package> <launch_file>');
      return;
    }
    const label = launchFile.replace(/\.launch\.py$|\.py$/, '');
    this.term.writeln(`\x1b[33mLaunching ${pkg}/${launchFile} — opening new terminal tab...\x1b[0m`);
    const session = window.termManager.addNodeSession(label);
    session.xterm.writeln(`\x1b[2m▶  ros2 launch ${pkg} ${launchFile}\x1b[0m`);
    await session.nodeManager.launchFile(pkg, launchFile);
  }

  // ── ros2 pkg ───────────────────────────────────────────────────────────────

  async _pkg(cmd, args) {
    switch (cmd) {
      case 'create': {
        // ros2 pkg create --build-type ament_python my_pkg
        const nameIdx = args.indexOf('--build-type') >= 0
          ? args.indexOf('--build-type') + 2
          : args.length - 1;
        const name = args[nameIdx] || args[args.length - 1];
        if (!name) { this.term.writeln('Usage: ros2 pkg create <name>'); return; }
        this.term.writeln(`Creating package \x1b[36m${name}\x1b[0m...`);
        const resp = await fetch('/api/create-package', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const data = await resp.json();
        if (data.ok) {
          this.term.writeln(`\x1b[32mPackage created: ${data.path}\x1b[0m`);
          this.term.writeln(`  ${data.path}/package.xml`);
          this.term.writeln(`  ${data.path}/setup.py`);
          this.term.writeln(`  ${data.path}/${name}/__init__.py`);
          this.term.writeln(`  ${data.path}/launch/`);
          this.term.writeln('');
          this.term.writeln('\x1b[33mNext steps to build a working node:\x1b[0m');
          this.term.writeln(`  1. Create your node file, e.g.:`);
          this.term.writeln(`       touch ${data.path}/${name}/my_node.py`);
          this.term.writeln(`  2. Write your node class with a \x1b[36mmain()\x1b[0m function.`);
          this.term.writeln(`  3. Register it in \x1b[36m${data.path}/setup.py\x1b[0m → console_scripts:`);
          this.term.writeln(`       \x1b[2m'my_node = ${name}.my_node:main',\x1b[0m`);
          this.term.writeln(`  4. \x1b[36mcolcon build\x1b[0m`);
          this.term.writeln(`  5. \x1b[36mros2 run ${name} my_node\x1b[0m`);
          this.term.writeln('');
          this.term.writeln('\x1b[2mTip: you can also open any .py file and click ▶ Run to test without setup.py.\x1b[0m');
          window.dispatchEvent(new CustomEvent('rospad:refresh-tree'));
        }
        break;
      }
      case 'list': {
        const resp = await fetch('/api/files?path=src');
        const entries = await resp.json();
        entries.filter(e => e.type === 'dir')
          .forEach(e => this.term.writeln(`\x1b[36m${e.name}\x1b[0m`));
        break;
      }
      default:
        this.term.writeln('Usage: ros2 pkg {create|list}');
    }
  }

  // ── ros2 param ────────────────────────────────────────────────────────────

  async _param(cmd, args) {
    this.term.writeln('\x1b[33mParameter server (stub — full impl coming)\x1b[0m');
  }

  // ── ros2 bag ──────────────────────────────────────────────────────────────

  async _bag(cmd, args) {
    switch(cmd) {
      case 'record':
        this.term.writeln('\x1b[33m[ros2 bag] Recording... (Ctrl+C to stop)\x1b[0m');
        window.dispatchEvent(new CustomEvent('rospad:bag-record', { detail: { args } }));
        break;
      case 'play':
        this.term.writeln('\x1b[33m[ros2 bag] Playback (stub)\x1b[0m');
        break;
      default:
        this.term.writeln('Usage: ros2 bag {record|play}');
    }
  }

  // ── ros2 service ──────────────────────────────────────────────────────────

  async _service(cmd, args) {
    if (cmd === 'list') {
      this.term.writeln('(service listing stub)');
    }
  }

  // ── colcon build ──────────────────────────────────────────────────────────

  async colconBuild() {
    this.term.writeln('\x1b[33mStarting >>> workspace\x1b[0m');
    // In browser: "build" just indexes available packages
    const resp = await fetch('/api/files?path=src');
    const pkgs = await resp.json();
    for (const pkg of pkgs.filter(e => e.type === 'dir')) {
      this.term.writeln(`Starting >>> \x1b[36m${pkg.name}\x1b[0m`);
      await new Promise(r => setTimeout(r, 200));
      this.term.writeln(`Finished <<< \x1b[32m${pkg.name}\x1b[0m [0.1s]`);
    }
    this.term.writeln(`\x1b[32mSummary: ${pkgs.length} package(s) finished\x1b[0m`);
    window.dispatchEvent(new CustomEvent('rospad:refresh-tree'));
    return true;
  }

  _help() {
    this.term.writeln(`\x1b[1mros2\x1b[0m — WebROS2 CLI

\x1b[33mTopic commands:\x1b[0m
  ros2 topic list
  ros2 topic echo <topic>
  ros2 topic hz <topic>
  ros2 topic pub <topic> <type> "<json>"

\x1b[33mNode commands:\x1b[0m
  ros2 node list
  ros2 node info <node>

\x1b[33mPackage commands:\x1b[0m
  ros2 pkg create --build-type ament_python <name>
  ros2 pkg list
  ros2 run <pkg> <executable>
  ros2 launch <pkg> <launch_file>

\x1b[33mBag commands:\x1b[0m
  ros2 bag record -a
  ros2 bag play <bag_name>

\x1b[33mOther:\x1b[0m
  colcon build`);
  }

  stopEcho(topic) {
    const id = this._echoSubs.get(topic);
    if (id) { this.bus.unsubscribe(topic, id); this._echoSubs.delete(topic); }
  }
}

window.ROS2CLI = ROS2CLI;
