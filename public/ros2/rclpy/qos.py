"""rclpy/qos.py — QoS profile stubs matching real rclpy"""

class QoSProfile:
    def __init__(self, depth=10, **kwargs):
        self.depth = depth

class ReliabilityPolicy:
    RELIABLE = 'reliable'
    BEST_EFFORT = 'best_effort'

class DurabilityPolicy:
    VOLATILE = 'volatile'
    TRANSIENT_LOCAL = 'transient_local'

class HistoryPolicy:
    KEEP_LAST = 'keep_last'
    KEEP_ALL = 'keep_all'

# Common presets
qos_profile_sensor_data = QoSProfile(depth=10)
qos_profile_system_default = QoSProfile(depth=10)
qos_profile_services_default = QoSProfile(depth=10)
