"""
rclpy/node.py — Node class matching real rclpy API exactly
"""

import asyncio
import time
from js import rosBus, setInterval, clearInterval  # type: ignore
from pyodide.ffi import create_proxy  # type: ignore


class Node:
    def __init__(self, node_name, **kwargs):
        self._node_name = node_name
        self._publishers = []
        self._subscriptions = []
        self._timers = []
        self._services = []
        self._spinning = False
        self._logger = Logger(node_name)
        self._clock = Clock()
        self._parameters = {}   # name → Parameter
        rosBus.registerNode(node_name)

    # ── Core API ──────────────────────────────────────────────────────────────

    def get_name(self):
        return self._node_name

    def get_logger(self):
        return self._logger

    def get_clock(self):
        return self._clock

    def get_node_names(self):
        return list(rosBus.getNodes())

    def get_topic_names_and_types(self):
        topics = rosBus.getTopics()
        return [(t['topic'], [t['msgType']]) for t in topics]

    # ── Publishers ────────────────────────────────────────────────────────────

    def create_publisher(self, msg_type, topic, qos_profile=10, **kwargs):
        pub = Publisher(msg_type, topic, self._node_name)
        self._publishers.append(pub)
        qname = getattr(msg_type, '__qualname__', msg_type.__name__)
        rosBus.trackPublisher(topic, self._node_name, qname.replace('.msg.', '/'))
        return pub

    # ── Subscriptions ─────────────────────────────────────────────────────────

    def create_subscription(self, msg_type, topic, callback, qos_profile=10, **kwargs):
        sub = Subscription(msg_type, topic, callback, self._node_name)
        self._subscriptions.append(sub)
        return sub

    # ── Timers ────────────────────────────────────────────────────────────────

    def create_timer(self, timer_period_sec, callback):
        timer = Timer(timer_period_sec, callback, self._node_name)
        self._timers.append(timer)
        return timer

    # ── Services ──────────────────────────────────────────────────────────────

    def create_service(self, srv_type, srv_name, callback, **kwargs):
        svc = Service(srv_type, srv_name, callback)
        self._services.append(svc)
        return svc

    def create_client(self, srv_type, srv_name, **kwargs):
        return ServiceClient(srv_type, srv_name)

    # ── Parameters ────────────────────────────────────────────────────────────

    def declare_parameter(self, name, value=None, **kwargs):
        p = Parameter(name, value)
        self._parameters[name] = p
        return p

    def get_parameter(self, name):
        return self._parameters.get(name, Parameter(name, None))

    def set_parameters(self, params):
        for p in params:
            self._parameters[p.name] = p

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def destroy_node(self):
        self._spinning = False
        for t in self._timers:
            t.cancel()
        rosBus.unregisterNode(self._node_name)

    def destroy_publisher(self, pub):
        self._publishers.remove(pub)

    def destroy_subscription(self, sub):
        sub.destroy()
        self._subscriptions.remove(sub)

    def destroy_timer(self, timer):
        timer.cancel()
        self._timers.remove(timer)


# ── Publisher ──────────────────────────────────────────────────────────────────

class Publisher:
    def __init__(self, msg_type, topic, node_name):
        self._msg_type = msg_type
        self._topic = topic
        self._node_name = node_name

    def publish(self, msg):
        data = _msg_to_dict(msg)
        # Use qualname to get 'geometry_msgs.msg.Twist' → 'geometry_msgs/Twist'
        qname = getattr(self._msg_type, '__qualname__', self._msg_type.__name__)
        type_str = qname.replace('.msg.', '/')
        rosBus.publish(self._topic, type_str, _to_js(data))

    @property
    def topic_name(self):
        return self._topic


# ── Subscription ──────────────────────────────────────────────────────────────

class Subscription:
    def __init__(self, msg_type, topic, callback, node_name):
        self._msg_type = msg_type
        self._topic = topic
        self._callback = callback
        self._node_name = node_name

        # Wrap callback so JS can call it (envelope optional — worker calls with one arg)
        def _js_callback(data, envelope=None):
            msg = _dict_to_msg(msg_type, _from_js(data))
            callback(msg)

        self._proxy = create_proxy(_js_callback)
        self._sub_id = rosBus.subscribe(topic, msg_type.__name__, self._proxy)

    def destroy(self):
        rosBus.unsubscribe(self._topic, self._sub_id)
        self._proxy.destroy()


# ── Timer ──────────────────────────────────────────────────────────────────────

class Timer:
    def __init__(self, period_sec, callback, node_name):
        self._period = period_sec
        self._callback = callback
        self._cancelled = False

        proxy = create_proxy(lambda: callback() if not self._cancelled else None)
        self._interval_id = setInterval(proxy, int(period_sec * 1000))

    def cancel(self):
        self._cancelled = True
        clearInterval(self._interval_id)

    def reset(self):
        self._cancelled = False

    @property
    def timer_period_ns(self):
        return int(self._period * 1e9)


# ── Service ───────────────────────────────────────────────────────────────────

class Service:
    def __init__(self, srv_type, srv_name, callback):
        self._srv_name = srv_name

        def _handler(request_js):
            req = _dict_to_msg(srv_type.Request, _from_js(request_js))
            resp = callback(req, srv_type.Response())
            return _to_js(_msg_to_dict(resp))

        rosBus.advertiseService(srv_name, create_proxy(_handler))


class ServiceClient:
    def __init__(self, srv_type, srv_name):
        self._srv_name = srv_name
        self._srv_type = srv_type

    async def call_async(self, request):
        import asyncio
        result = await asyncio.ensure_future(
            _js_promise_to_future(rosBus.callService(self._srv_name, _to_js(_msg_to_dict(request))))
        )
        return _dict_to_msg(self._srv_type.Response, _from_js(result))

    def service_is_ready(self):
        return True


# ── Logger ────────────────────────────────────────────────────────────────────

class Logger:
    def __init__(self, name):
        self._name = name

    def info(self, msg):
        print(f'[INFO] [{self._name}]: {msg}')
        _emit_log('INFO', self._name, msg)

    def warn(self, msg):
        print(f'\x1b[33m[WARN] [{self._name}]: {msg}\x1b[0m')
        _emit_log('WARN', self._name, msg)

    def error(self, msg):
        print(f'\x1b[31m[ERROR] [{self._name}]: {msg}\x1b[0m')
        _emit_log('ERROR', self._name, msg)

    def debug(self, msg):
        print(f'\x1b[2m[DEBUG] [{self._name}]: {msg}\x1b[0m')
        _emit_log('DEBUG', self._name, msg)

    def fatal(self, msg):
        print(f'\x1b[31;1m[FATAL] [{self._name}]: {msg}\x1b[0m')
        _emit_log('FATAL', self._name, msg)


def _emit_log(level, name, msg):
    from js import rosBus  # type: ignore
    rosBus.publish('/rosout', 'rcl_interfaces/msg/Log', _to_js({
        'level': level, 'name': name, 'msg': str(msg),
        'stamp': {'sec': int(time.time()), 'nanosec': 0}
    }))


# ── Clock ─────────────────────────────────────────────────────────────────────

class Clock:
    def now(self):
        return Time()


class Time:
    def __init__(self):
        self._t = time.time()

    @property
    def nanoseconds(self):
        return int(self._t * 1e9)

    def to_msg(self):
        return {'sec': int(self._t), 'nanosec': int((self._t % 1) * 1e9)}


# ── Parameter ─────────────────────────────────────────────────────────────────

class Parameter:
    def __init__(self, name, value):
        self.name = name
        self._value = value

    @property
    def value(self):
        return self._value


# ── Helpers ───────────────────────────────────────────────────────────────────

def _msg_to_dict(msg):
    """Convert ROS message object to plain dict."""
    if hasattr(msg, '__dict__'):
        return {k: _msg_to_dict(v) for k, v in vars(msg).items()
                if not k.startswith('_')}
    if isinstance(msg, (list, tuple)):
        return [_msg_to_dict(i) for i in msg]
    return msg


def _dict_to_msg(msg_type, d):
    """Reconstruct ROS message from dict."""
    if d is None:
        return msg_type()
    msg = msg_type()
    if isinstance(d, dict):
        for k, v in d.items():
            if hasattr(msg, k):
                current = getattr(msg, k)
                if isinstance(v, dict) and hasattr(current, '__dict__'):
                    # Nested message object (e.g. Twist.linear is Vector3): recurse
                    v = _dict_to_msg(type(current), v)
                elif isinstance(v, (list, tuple)) and v and isinstance(current, list):
                    # Numeric arrays: ensure plain Python floats
                    cleaned = []
                    for item in v:
                        try:
                            cleaned.append(float(item))
                        except (TypeError, ValueError):
                            cleaned.append(0.0)
                    v = cleaned
                setattr(msg, k, v)
    return msg


def _to_js(obj):
    """Convert Python dict to plain JS object via Pyodide."""
    from pyodide.ffi import to_js  # type: ignore
    from js import Object  # type: ignore
    return to_js(obj, dict_converter=Object.fromEntries)


def _from_js(obj):
    """Convert JS object to Python dict."""
    try:
        return obj.to_py()
    except Exception:
        return obj


async def _js_promise_to_future(promise):
    """Await a JS Promise from Python."""
    import asyncio
    future = asyncio.get_event_loop().create_future()
    promise.then(
        create_proxy(lambda v: future.set_result(v)),
        create_proxy(lambda e: future.set_exception(Exception(str(e))))
    )
    return await future
