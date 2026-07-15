"""
msgs/__init__.py
Auto-generated ROS2 message types for WebROS.
Same field names and structure as real ROS2 messages.
"""

# ── std_msgs ──────────────────────────────────────────────────────────────────

class std_msgs:
    class msg:
        class String:
            def __init__(self): self.data = ''
        class Bool:
            def __init__(self): self.data = False
        class Int32:
            def __init__(self): self.data = 0
        class Float32:
            def __init__(self): self.data = 0.0
        class Float64:
            def __init__(self): self.data = 0.0
        class Header:
            def __init__(self):
                self.stamp = {'sec': 0, 'nanosec': 0}
                self.frame_id = ''


# ── geometry_msgs ─────────────────────────────────────────────────────────────

class geometry_msgs:
    class msg:
        class Vector3:
            def __init__(self): self.x = 0.0; self.y = 0.0; self.z = 0.0

        class Point:
            def __init__(self): self.x = 0.0; self.y = 0.0; self.z = 0.0

        class Quaternion:
            def __init__(self): self.x = 0.0; self.y = 0.0; self.z = 0.0; self.w = 1.0

        class Pose:
            def __init__(self):
                self.position = geometry_msgs.msg.Point()
                self.orientation = geometry_msgs.msg.Quaternion()

        class PoseStamped:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.pose = geometry_msgs.msg.Pose()

        class Twist:
            def __init__(self):
                self.linear = geometry_msgs.msg.Vector3()
                self.angular = geometry_msgs.msg.Vector3()

        class TwistStamped:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.twist = geometry_msgs.msg.Twist()

        class Transform:
            def __init__(self):
                self.translation = geometry_msgs.msg.Vector3()
                self.rotation = geometry_msgs.msg.Quaternion()

        class TransformStamped:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.child_frame_id = ''
                self.transform = geometry_msgs.msg.Transform()


# ── sensor_msgs ───────────────────────────────────────────────────────────────

class sensor_msgs:
    class msg:
        class LaserScan:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.angle_min = -3.14159
                self.angle_max = 3.14159
                self.angle_increment = 0.01745
                self.time_increment = 0.0
                self.scan_time = 0.1
                self.range_min = 0.1
                self.range_max = 30.0
                self.ranges = []
                self.intensities = []

        class JointState:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.name = []
                self.position = []
                self.velocity = []
                self.effort = []

        class Image:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.height = 480
                self.width = 640
                self.encoding = 'rgb8'
                self.is_bigendian = False
                self.step = 1920
                self.data = []

        class CameraInfo:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.height = 480
                self.width = 640
                self.distortion_model = 'plumb_bob'
                self.d = [0.0] * 5
                self.k = [525.0, 0.0, 320.0, 0.0, 525.0, 240.0, 0.0, 0.0, 1.0]
                self.r = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
                self.p = [525.0, 0.0, 320.0, 0.0, 0.0, 525.0, 240.0, 0.0, 0.0, 0.0, 1.0, 0.0]

        class Imu:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.orientation = geometry_msgs.msg.Quaternion()
                self.angular_velocity = geometry_msgs.msg.Vector3()
                self.linear_acceleration = geometry_msgs.msg.Vector3()


# ── nav_msgs ──────────────────────────────────────────────────────────────────

class nav_msgs:
    class msg:
        class Odometry:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.child_frame_id = 'base_link'
                self.pose = geometry_msgs.msg.PoseStamped()
                self.twist = geometry_msgs.msg.TwistStamped()

        class OccupancyGrid:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.info = nav_msgs.msg.MapMetaData()
                self.data = []

        class MapMetaData:
            def __init__(self):
                self.resolution = 0.05
                self.width = 0
                self.height = 0
                self.origin = geometry_msgs.msg.Pose()

        class Path:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.poses = []


# ── turtlesim ────────────────────────────────────────────────────────────────

class turtlesim:
    class msg:
        class Pose:
            def __init__(self):
                self.x = 0.0
                self.y = 0.0
                self.theta = 0.0
                self.linear_velocity  = 0.0
                self.angular_velocity = 0.0

        class Color:
            def __init__(self): self.r = 0; self.g = 0; self.b = 0


# ── trajectory_msgs ───────────────────────────────────────────────────────────

class trajectory_msgs:
    class msg:
        class JointTrajectory:
            def __init__(self):
                self.header = std_msgs.msg.Header()
                self.joint_names = []
                self.points = []

        class JointTrajectoryPoint:
            def __init__(self):
                self.positions = []
                self.velocities = []
                self.accelerations = []
                self.time_from_start = {'sec': 0, 'nanosec': 0}


# ── Convenience imports matching real ROS2 style ──────────────────────────────
# from std_msgs.msg import String → works after this bootstrap

import sys

class _MsgModule:
    def __init__(self, cls): self._cls = cls
    def __getattr__(self, name): return getattr(self._cls, name)

class _PkgModule:
    def __init__(self, pkg_class):
        self.msg = _MsgModule(pkg_class.msg)

sys.modules['std_msgs'] = _PkgModule(std_msgs)
sys.modules['std_msgs.msg'] = std_msgs.msg
sys.modules['geometry_msgs'] = _PkgModule(geometry_msgs)
sys.modules['geometry_msgs.msg'] = geometry_msgs.msg
sys.modules['sensor_msgs'] = _PkgModule(sensor_msgs)
sys.modules['sensor_msgs.msg'] = sensor_msgs.msg
sys.modules['nav_msgs'] = _PkgModule(nav_msgs)
sys.modules['nav_msgs.msg'] = nav_msgs.msg
sys.modules['trajectory_msgs'] = _PkgModule(trajectory_msgs)
sys.modules['trajectory_msgs.msg'] = trajectory_msgs.msg
sys.modules['turtlesim'] = _PkgModule(turtlesim)
sys.modules['turtlesim.msg'] = turtlesim.msg
sys.modules['turtlesim.msg'] = turtlesim.msg
