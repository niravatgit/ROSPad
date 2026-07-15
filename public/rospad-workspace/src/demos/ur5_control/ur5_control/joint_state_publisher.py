"""
joint_state_publisher.py — set UR5 joint angles and hold the pose

Edit JOINT_POSITIONS below, then click ▶ Run to move the arm to that position.
The 3D simulator will update in real-time.

Joint order: shoulder_pan, shoulder_lift, elbow, wrist_1, wrist_2, wrist_3
All values in radians.
"""

import math
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState

JOINT_NAMES = [
    'shoulder_pan_joint',
    'shoulder_lift_joint',
    'elbow_joint',
    'wrist_1_joint',
    'wrist_2_joint',
    'wrist_3_joint',
]

# ── Edit these angles to move the arm (radians) ──────────────────────────────
JOINT_POSITIONS = [0.0, -math.pi / 2, 0.0, -math.pi / 2, 0.0, 0.0]
# ─────────────────────────────────────────────────────────────────────────────


class JointStatePublisher(Node):
    def __init__(self):
        super().__init__('joint_state_publisher')
        self.pub = self.create_publisher(JointState, '/joint_states', 10)
        self.timer = self.create_timer(0.05, self.publish_state)  # 20 Hz
        self.get_logger().info('Publishing joint states at 20 Hz — edit JOINT_POSITIONS to move the arm')

    def publish_state(self):
        msg = JointState()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.name = JOINT_NAMES
        msg.position = list(JOINT_POSITIONS)
        msg.velocity = [0.0] * 6
        msg.effort = [0.0] * 6
        self.pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(JointStatePublisher())
    rclpy.shutdown()
