"""
turtlesim_demo/turtle_node.py
Simulates turtle physics: subscribes /turtle1/cmd_vel, publishes /turtle1/pose.
World bounds: 0–11.09 m (matches classic turtlesim).
"""

import math
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from turtlesim.msg import Pose


WORLD = 11.09


class TurtleNode(Node):
    def __init__(self):
        super().__init__('turtlesim')

        self._x     = 5.5
        self._y     = 5.5
        self._theta = 0.0
        self._vlin  = 0.0
        self._vang  = 0.0

        self._pub = self.create_publisher(Pose, '/turtle1/pose', 10)
        self.create_subscription(Twist, '/turtle1/cmd_vel', self._cmd_cb, 10)

        self.create_timer(0.05, self._update)   # 20 Hz physics
        self.get_logger().info('turtlesim started — world 11.09 x 11.09 m')

    def _cmd_cb(self, msg):
        self._vlin = float(msg.linear.x)
        self._vang = float(msg.angular.z)

    def _update(self):
        dt = 0.05
        self._theta += self._vang * dt
        self._x     += self._vlin * math.cos(self._theta) * dt
        self._y     += self._vlin * math.sin(self._theta) * dt

        # Clamp to world bounds (matches real turtlesim behaviour)
        self._x     = max(0.0, min(WORLD, self._x))
        self._y     = max(0.0, min(WORLD, self._y))
        self._theta = math.atan2(math.sin(self._theta), math.cos(self._theta))

        pose = Pose()
        pose.x                = self._x
        pose.y                = self._y
        pose.theta            = self._theta
        pose.linear_velocity  = self._vlin
        pose.angular_velocity = self._vang
        self._pub.publish(pose)


def main():
    rclpy.init()
    node = TurtleNode()
    rclpy.spin(node)
