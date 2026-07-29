"""
wrist_detector.py — Color detection from UR5 wrist camera

Subscribes to /wrist_camera/image_raw published when ur5_camera.urdf is loaded
and reports the location of coloured objects in the camera's field of view.
This demonstrates eye-in-hand perception — the camera moves with the arm.

Prerequisites:
  1. Launch ur5_camera_description:  ros2 launch ur5_camera_description ur5_camera.launch.py
  2. Run ur5_control joint_state_server (so /joint_states are published)
  3. Add coloured obstacles in the sim (Obstacles panel)
  4. Run this node:  ros2 run vision_demos wrist_detector
  5. Enable /wrist_camera/image_raw in the Viz panel to see the camera feed

Image format: sensor_msgs/Image, encoding=rgb8, 320×240
"""

import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image


# Colour definitions: name → (R_min, R_max, G_min, G_max, B_min, B_max)
COLOURS = {
    'red':    (150, 255,   0,  80,   0,  80),
    'green':  (  0,  80, 120, 255,   0,  80),
    'blue':   (  0,  80,   0,  80, 120, 255),
    'yellow': (150, 255, 120, 255,   0,  80),
}


def detect_colour(arr, bounds):
    r0, r1, g0, g1, b0, b1 = bounds
    return (
        (arr[:, :, 0] >= r0) & (arr[:, :, 0] <= r1) &
        (arr[:, :, 1] >= g0) & (arr[:, :, 1] <= g1) &
        (arr[:, :, 2] >= b0) & (arr[:, :, 2] <= b1)
    )


class WristDetector(Node):
    def __init__(self):
        super().__init__('wrist_detector')
        self._sub = self.create_subscription(
            Image, '/wrist_camera/image_raw', self._on_image, 10
        )
        self.get_logger().info('WristDetector started — watching /wrist_camera/image_raw')
        self._frame_count = 0

    def _on_image(self, msg):
        if self._frame_count % 15 != 0:   # log every ~1.5 s at 10 Hz
            self._frame_count += 1
            return
        self._frame_count += 1

        w, h = msg.width, msg.height
        if w == 0 or h == 0:
            return

        arr = np.asarray(msg.data, dtype=np.uint8).reshape(h, w, 3)

        detections = []
        for name, bounds in COLOURS.items():
            mask  = detect_colour(arr, bounds)
            count = int(np.sum(mask))
            if count < 30:
                continue
            ys, xs = np.where(mask)
            cx = float(np.mean(xs))
            cy = float(np.mean(ys))
            # Normalize: (0,0) = top-left, (1,1) = bottom-right
            nx = cx / w
            ny = cy / h
            area = count / (w * h) * 100.0
            detections.append(f'{name}: pos=({nx:.2f},{ny:.2f}) area={area:.1f}%')

        if detections:
            self.get_logger().info('Detected — ' + '  |  '.join(detections))
        else:
            self.get_logger().info('No coloured objects in view')


def main():
    rclpy.init()
    node = WristDetector()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
