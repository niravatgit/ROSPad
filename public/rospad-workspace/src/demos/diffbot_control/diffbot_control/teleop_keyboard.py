"""
teleop_keyboard.py — drive the DiffBot with a fixed velocity command

Edit LINEAR and ANGULAR below, then click ▶ Run to publish /cmd_vel at 10 Hz.
The 3D simulator also responds to WASD keys — click the viewport first.

Tip: set LINEAR=0 and a non-zero ANGULAR to spin in place.
"""

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist

# ── Edit these to drive the robot ────────────────────────────────────────────
LINEAR  =  0.4   # m/s   (positive = forward, negative = reverse)
ANGULAR =  0.0   # rad/s (positive = left turn, negative = right turn)
# ─────────────────────────────────────────────────────────────────────────────


class TeleopPublisher(Node):
    def __init__(self):
        super().__init__('teleop_publisher')
        self.pub   = self.create_publisher(Twist, '/cmd_vel', 10)
        self.timer = self.create_timer(0.1, self.publish_cmd)
        self.get_logger().info(
            f'Teleop running — linear={LINEAR} m/s  angular={ANGULAR} rad/s'
        )

    def publish_cmd(self):
        msg = Twist()
        msg.linear.x  = float(LINEAR)
        msg.angular.z = float(ANGULAR)
        self.pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(TeleopPublisher())
    rclpy.shutdown()
