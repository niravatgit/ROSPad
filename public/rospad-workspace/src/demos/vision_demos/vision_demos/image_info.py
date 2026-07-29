"""
image_info.py — Subscribe to any sensor_msgs/Image topic and print statistics.

Useful as a first test to confirm the camera pipeline is working before
writing more complex vision code.

Usage:
  ros2 run vision_demos image_info             # listens to /camera/image_raw
  ros2 run vision_demos image_info /wrist_camera/image_raw
"""

import sys
import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image


class ImageInfo(Node):
    def __init__(self, topic):
        super().__init__('image_info')
        self._topic = topic
        self._sub = self.create_subscription(Image, topic, self._on_image, 10)
        self.get_logger().info(f'Subscribing to {topic}')
        self._count = 0

    def _on_image(self, msg):
        self._count += 1
        if self._count % 10 != 1:
            return

        arr = np.asarray(msg.data, dtype=np.uint8).reshape(msg.height, msg.width, 3)

        r_mean = float(np.mean(arr[:, :, 0]))
        g_mean = float(np.mean(arr[:, :, 1]))
        b_mean = float(np.mean(arr[:, :, 2]))

        self.get_logger().info(
            f'Frame #{self._count}  {msg.width}x{msg.height}  {msg.encoding}  '
            f'mean RGB=({r_mean:.0f},{g_mean:.0f},{b_mean:.0f})'
        )


def main():
    rclpy.init()
    topic = sys.argv[1] if len(sys.argv) > 1 else '/camera/image_raw'
    node = ImageInfo(topic)
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
