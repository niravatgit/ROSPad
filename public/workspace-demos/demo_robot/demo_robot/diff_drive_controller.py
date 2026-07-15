"""
demo_robot/diff_drive_controller.py

Differential drive obstacle avoidance using LaserScan.
Falls back to forward motion when no scan is available (browser sim mode).
100% standard ROS2 Python — same code runs on a real robot.
"""

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry
import math


def _position_from_odom(msg):
    """Extract (x, y) from an Odometry message regardless of nesting depth.

    The browser sim publishes odom as a flat JS dict so msg.pose arrives as
    a Python dict rather than a PoseStamped.  Handle both cases.
    """
    pose = msg.pose
    if isinstance(pose, dict):
        pos = pose.get('position', {})
        if isinstance(pos, dict):
            return pos.get('x', 0.0), pos.get('y', 0.0)
        return 0.0, 0.0
    # Real ROS2 nav_msgs/Odometry: pose is PoseWithCovariance → pose.pose.position
    # Our shim uses PoseStamped:       pose is PoseStamped   → pose.pose.position
    try:
        p = pose.position if hasattr(pose, 'position') else pose.pose.position
        return p.x, p.y
    except Exception:
        return 0.0, 0.0


class DiffDriveController(Node):
    """
    Simple reactive obstacle avoider for a differential drive robot.

    Subscribes: /scan    (sensor_msgs/LaserScan)   — optional
                /odom    (nav_msgs/Odometry)
    Publishes:  /cmd_vel (geometry_msgs/Twist)

    When no scan data has arrived yet the node drives forward so the robot
    is immediately visible moving in the ROSPad simulation.
    """

    def __init__(self):
        super().__init__('diff_drive_controller')

        self.declare_parameter('linear_speed',       0.3)
        self.declare_parameter('angular_speed',      0.8)
        self.declare_parameter('obstacle_distance',  0.6)

        self.v        = self.get_parameter('linear_speed').value
        self.w        = self.get_parameter('angular_speed').value
        self.d_thresh = self.get_parameter('obstacle_distance').value

        self.pub_vel  = self.create_publisher(Twist, '/cmd_vel', 10)
        self.sub_scan = self.create_subscription(
            LaserScan, '/scan', self.scan_callback, 10)
        self.sub_odom = self.create_subscription(
            Odometry, '/odom', self.odom_callback, 10)

        self.pose        = {'x': 0.0, 'y': 0.0}
        self._last_scan  = None

        # Main control loop at 10 Hz
        self.create_timer(0.1, self.drive_loop)

        self.get_logger().info(
            f'DiffDriveController started | '
            f'v={self.v} m/s  w={self.w} rad/s  '
            f'obstacle_threshold={self.d_thresh} m'
        )

    # ── Control loop ──────────────────────────────────────────────────────────

    def drive_loop(self):
        """Publish /cmd_vel at 10 Hz.

        Uses laser scan for obstacle avoidance when available.
        Drives straight forward as a fallback (browser sim has no /scan).
        """
        twist = Twist()

        if self._last_scan is not None:
            ranges = list(self._last_scan.ranges)  # ensure plain Python list
            range_max = float(self._last_scan.range_max or 30.0)
            n = len(ranges)
            if n > 0:
                front_idx = list(range(0, n // 8)) + list(range(7 * n // 8, n))
                left_idx  = list(range(n // 8, 3 * n // 8))

                def min_range(indices):
                    vals = []
                    for i in indices:
                        try:
                            r = float(ranges[i])
                            if 0.0 < r < range_max:
                                vals.append(r)
                        except (TypeError, ValueError):
                            pass
                    return min(vals) if vals else float('inf')

                front_dist = min_range(front_idx)
                left_dist  = min_range(left_idx)

                if front_dist < self.d_thresh:
                    twist.linear.x  = 0.0
                    twist.angular.z = self.w if left_dist > self.d_thresh else -self.w
                    self.get_logger().info(
                        f'Obstacle at {front_dist:.2f} m — turning '
                        f'{"left" if twist.angular.z > 0 else "right"}'
                    )
                else:
                    twist.linear.x  = self.v
                    twist.angular.z = 0.0
        else:
            # No scan available — drive straight forward
            twist.linear.x  = self.v
            twist.angular.z = 0.0

        self.pub_vel.publish(twist)

    # ── Callbacks ─────────────────────────────────────────────────────────────

    def scan_callback(self, msg: LaserScan):
        self._last_scan = msg

    def odom_callback(self, msg: Odometry):
        x, y = _position_from_odom(msg)
        self.pose['x'] = x
        self.pose['y'] = y


def main(args=None):
    rclpy.init(args=args)
    node = DiffDriveController()
    rclpy.spin(node)
    rclpy.shutdown()