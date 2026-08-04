"""
turtlesim_demo/teleop_key.py
Keyboard teleop for the turtle: subscribes /rospad/key, publishes /turtle1/cmd_vel.
The ROSpad sim canvas publishes WASD keystrokes to /rospad/key automatically;
this node translates them to Twist messages for the turtle.
"""

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from std_msgs.msg import String


LINEAR_SPEED  = 2.0
ANGULAR_SPEED = 2.0


class TeleopKey(Node):
    def __init__(self):
        super().__init__('turtle_teleop_key')

        self._pub = self.create_publisher(Twist, '/turtle1/cmd_vel', 10)
        self.create_subscription(String, '/rospad/key', self._key_cb, 10)

        self._active = {}
        self.create_timer(0.05, self._publish)
        self.get_logger().info('turtle_teleop_key ready — WASD to move turtle')

    def _key_cb(self, msg):
        # message format: "<key>:down" or "<key>:up"
        parts = msg.data.split(':')
        if len(parts) == 2:
            key, state = parts
            self._active[key] = (state == 'down')

    def _publish(self):
        tw = Twist()
        if self._active.get('w'): tw.linear.x  =  LINEAR_SPEED
        if self._active.get('s'): tw.linear.x  = -LINEAR_SPEED
        if self._active.get('a'): tw.angular.z =  ANGULAR_SPEED
        if self._active.get('d'): tw.angular.z = -ANGULAR_SPEED
        self._pub.publish(tw)


def main():
    rclpy.init()
    node = TeleopKey()
    rclpy.spin(node)
