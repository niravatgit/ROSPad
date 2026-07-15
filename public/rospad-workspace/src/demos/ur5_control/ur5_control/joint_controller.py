"""
joint_controller.py — smooth pose sequencer for the UR5 arm

Cycles through a sequence of named poses with smooth interpolation between
each one (smoothstep easing). The arm holds each pose briefly before
transitioning to the next.

Click ▶ Run, then launch ur5_description to see the arm in the simulator.
Add or edit entries in POSES to define your own motion sequence.
"""

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState

JOINT_NAMES = [
    'shoulder_pan_joint', 'shoulder_lift_joint', 'elbow_joint',
    'wrist_1_joint', 'wrist_2_joint', 'wrist_3_joint',
]

# ── Edit poses here — angles in radians ──────────────────────────────────────
POSES = [
    {'name': 'home',   'joints': [0.0,  -1.57,  0.0,  -1.57, 0.0, 0.0]},
    {'name': 'reach',  'joints': [0.5,  -1.0,   0.8,  -1.4,  0.3, 0.0]},
    {'name': 'raised', 'joints': [0.0,  -0.5,   0.5,  -1.0,  0.0, 0.0]},
    {'name': 'right',  'joints': [1.57, -1.57,  0.0,  -1.57, 0.0, 0.0]},
    {'name': 'home',   'joints': [0.0,  -1.57,  0.0,  -1.57, 0.0, 0.0]},
]
TRANSITION_SECS = 3.0   # seconds to move between poses
HOLD_SECS       = 1.0   # seconds to hold at each pose
# ─────────────────────────────────────────────────────────────────────────────


class JointController(Node):
    def __init__(self):
        super().__init__('joint_controller')
        self.pub = self.create_publisher(JointState, '/joint_states', 10)
        self.timer = self.create_timer(0.05, self.step)  # 20 Hz
        self.pose_idx = 0
        self.current  = list(POSES[0]['joints'])
        self.t        = 0.0
        self.holding  = False
        self.hold_t   = 0.0
        self.get_logger().info('UR5 joint controller started — cycling through poses')

    def step(self):
        dt = 0.05
        if self.holding:
            self.hold_t += dt
            if self.hold_t >= HOLD_SECS:
                self.holding  = False
                self.hold_t   = 0.0
                self.pose_idx = (self.pose_idx + 1) % len(POSES)
                self.t        = 0.0
                self.get_logger().info(f"Moving to: {POSES[self.pose_idx]['name']}")
        else:
            self.t = min(self.t + dt / TRANSITION_SECS, 1.0)
            alpha  = self.t * self.t * (3 - 2 * self.t)  # smoothstep
            prev   = POSES[(self.pose_idx - 1) % len(POSES)]['joints']
            target = POSES[self.pose_idx]['joints']
            self.current = [prev[i] + (target[i] - prev[i]) * alpha for i in range(6)]
            if self.t >= 1.0:
                self.holding = True

        msg = JointState()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.name         = JOINT_NAMES
        msg.position     = self.current
        msg.velocity     = [0.0] * 6
        msg.effort       = [0.0] * 6
        self.pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(JointController())
    rclpy.shutdown()
