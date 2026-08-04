"""
joint_state_server.py — UR5 joint-state service server

Subscribes to /joint_states and caches the latest reading.
Advertises /get_ur5_joints so any client can query the current
arm pose on demand — even while the arm is moving.

Prerequisites:
  Launch ur5_control.launch.py first so the arm appears in the sim
  and /joint_states is being published.

Once running, use service_demo/ur5_pose_client.py to query the pose.
"""

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from rospad_interfaces.srv import GetJointStates


UR5_JOINT_NAMES = [
    'shoulder_pan_joint',
    'shoulder_lift_joint',
    'elbow_joint',
    'wrist_1_joint',
    'wrist_2_joint',
    'wrist_3_joint',
]


class JointStateServer(Node):
    def __init__(self):
        super().__init__('ur5_joint_state_server')
        self._latest_names     = []
        self._latest_positions = []

        self.create_subscription(JointState, '/joint_states', self._on_joint_state, 10)
        self.create_service(GetJointStates, '/get_ur5_joints', self._handle_request)

        self.get_logger().info(
            'Service /get_ur5_joints ready — waiting for /joint_states data'
        )

    def _on_joint_state(self, msg):
        self._latest_names     = list(msg.name)
        self._latest_positions = list(msg.position)

    def _handle_request(self, request, response):
        if self._latest_positions:
            response.joint_names = self._latest_names or UR5_JOINT_NAMES
            response.positions   = self._latest_positions
            response.success     = True
            self.get_logger().info(
                'Served /get_ur5_joints — '
                + ', '.join(f'{p:+.3f}' for p in self._latest_positions)
            )
        else:
            response.success = False
            self.get_logger().warn(
                'No /joint_states received yet — launch the UR5 first'
            )
        return response


def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(JointStateServer())
    rclpy.shutdown()
