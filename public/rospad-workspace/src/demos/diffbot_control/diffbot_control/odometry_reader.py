"""
odometry_reader.py — print the DiffBot's position from /odom

Run this while the robot is moving to track its x/y position in real-time.
Great for verifying your control nodes are working correctly.

Click ▶ Run, then drive the robot with teleop_keyboard or circle_drive.
"""

import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry


class OdomReader(Node):
    def __init__(self):
        super().__init__('odom_reader')
        self.create_subscription(Odometry, '/odom', self.cb, 10)
        self.get_logger().info('Listening on /odom...')

    def cb(self, msg):
        x = msg.pose.pose.position.x
        y = msg.pose.pose.position.y
        self.get_logger().info(f'Position  x={x:.3f}  y={y:.3f}')


def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(OdomReader())
    rclpy.shutdown()
