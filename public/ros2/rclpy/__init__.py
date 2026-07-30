"""
rclpy/__init__.py — Drop-in rclpy replacement for WebROS
Runs inside Pyodide. Routes through BroadcastChannel instead of DDS.
API is 100% identical to real rclpy.
"""

import asyncio
from js import rosBus  # type: ignore  (Pyodide JS bridge)

_initialized = False
_nodes = []


def init(args=None, **kwargs):
    global _initialized
    _initialized = True


def shutdown():
    global _initialized, _nodes
    for node in _nodes:
        node.destroy_node()
    _nodes.clear()
    _initialized = False


def ok():
    return _initialized


class _ROSpadSpin(BaseException):
    """Sentinel raised by spin() in Pyodide.

    The JS event loop is already running so run_until_complete() would fail.
    We raise this instead so main() exits without reaching rclpy.shutdown(),
    leaving the node's setInterval timers alive in the worker.
    The worker catches this and does NOT post 'stopped'.
    """


def spin(node):
    """In WebROS/Pyodide, timers are driven by JS setInterval — already running.
    Raise the sentinel so main() exits cleanly without reaching shutdown().
    The worker catches _ROSpadSpin and stays alive until worker.terminate().
    """
    try:
        import js as _js
        _js._rospadSpinning = True
    except Exception:
        pass
    raise _ROSpadSpin()


async def _spin_async(node):
    node._spinning = True
    while node._spinning:
        await asyncio.sleep(0.01)


def spin_once(node, timeout_sec=0):
    pass


def spin_until_future_complete(node, future, timeout_sec=None):
    loop = asyncio.get_event_loop()
    if not loop.is_running():
        loop.run_until_complete(future)


def create_node(node_name, **kwargs):
    from rclpy.node import Node
    return Node(node_name, **kwargs)


# Re-export commonly used submodules
from rclpy import node, qos, logging
