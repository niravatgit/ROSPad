"""
wrist_detector.py — Color detection from UR5 wrist camera

Subscribes to /wrist_camera/image_raw published when ur5_camera.urdf is loaded
and reports the location of coloured objects in the camera's field of view.
This demonstrates eye-in-hand perception — the camera moves with the arm.

Prerequisites:
  1. Launch ur5_camera_description:  ros2 launch ur5_camera_description ur5_camera.launch.py
  2. Run ur5_control joint_state_server (so /joint_states are published)
  3. Add coloured obstacles in the sim (Obstacles panel)
  4. Run this node:  ros2 run ur5_vision wrist_detector
  5. Enable /wrist_camera/image_raw in the Viz panel to see the camera feed

Image format: sensor_msgs/Image, encoding=rgb8, 320×240
"""

import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image


# Colour definitions: name → (R_min, R_max, G_min, G_max, B_min, B_max)
# Ranges account for Lambert shading (ambient 0.4 → shadow at 40% brightness).
# Pure colours: #ff0000, #00ff00, #0000ff.
# Sim palette (OBS_COLORS): 0xf85149, 0x3fb950, 0x39c5cf, 0x58a6ff, 0xd29922, 0x8957e5.
COLOURS = {
    'red':    ( 70, 255,   0,  95,   0,  95),  # #ff0000 + 0xf85149
    'green':  (  0,  85,  60, 255,   0,  90),  # #00ff00 + 0x3fb950
    'blue':   (  0, 115,   0, 115,  80, 255),  # #0000ff + 0x58a6ff (B_min 80 covers shadow)
    'cyan':   (  0,  70, 100, 255,  90, 255),  # 0x39c5cf (G≈B both high, R low)
    'orange': ( 70, 220,  50, 170,   0,  55),  # 0xd29922
    'purple': ( 40, 165,  15, 110,  60, 240),  # 0x8957e5
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

        # Debug: log data type + first pixel on first few frames
        if self._frame_count <= 30:
            raw = msg.data
            self.get_logger().info(
                f'DBG data type={type(raw).__name__} len={len(raw) if hasattr(raw,"__len__") else "?"}'
                f' first3={list(raw)[:3] if hasattr(raw,"__iter__") else "no-iter"}'
            )

        arr = np.asarray(list(msg.data), dtype=np.uint8).reshape(h, w, 3)

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
