"""
circle_drive.py — drive the DiffBot in a continuous circle

Publishes a constant forward velocity and angular rate so the robot traces
a circle. Adjust RADIUS and SPEED to change the circle size and how fast
the robot travels around it.

Click ▶ Run and watch the robot loop in the 3D simulator.
"""

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist

# ── Tune these ────────────────────────────────────────────────────────────────
SPEED  = 0.3   # linear speed  (m/s)
RADIUS = 1.0   # circle radius (metres)
# ─────────────────────────────────────────────────────────────────────────────

ANGULAR = SPEED / RADIUS   # ω = v / r


class CircleDrive(Node):
    def __init__(self):
        super().__init__('circle_drive')
        self.pub   = self.create_publisher(Twist, '/cmd_vel', 10)
        self.timer = self.create_timer(0.1, self.drive)
        self.get_logger().info(
            f'CircleDrive started — radius={RADIUS} m  speed={SPEED} m/s'
        )

    def drive(self):
        msg = Twist()
        msg.linear.x  = SPEED
        msg.angular.z = ANGULAR
        self.pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(CircleDrive())
    rclpy.shutdown()
