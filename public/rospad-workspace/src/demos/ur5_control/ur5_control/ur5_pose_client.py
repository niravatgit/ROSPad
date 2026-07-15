"""
ur5_pose_client.py — Query current UR5 joint positions via service

Calls the /get_ur5_joints service (provided by ur5_control/joint_state_server)
and prints the current joint angles in degrees.

Prerequisites:
  1. Launch ur5_control.launch.py  (loads the UR5 into the sim)
  2. Run ur5_control/joint_state_server.py  (advertises /get_ur5_joints)
  3. Then click ▶ Run here to query the pose

You can call this as many times as you like while the arm is moving.
"""

import asyncio
import math
import rclpy
from rclpy.node import Node
from rospad_interfaces.srv import GetJointStates


class UR5PoseClient(Node):
    def __init__(self):
        super().__init__('ur5_pose_client')
        self._done = False
        self.client = self.create_client(GetJointStates, '/get_ur5_joints')
        self.create_timer(1.5, self._call_once)
        self.get_logger().info('Querying UR5 joint states in 1.5 s...')

    def _call_once(self):
        if self._done:
            return
        self._done = True
        asyncio.ensure_future(self._do_call())

    async def _do_call(self):
        req = GetJointStates.Request()
        try:
            resp = await self.client.call_async(req)
            if resp and resp.success:
                self.get_logger().info('UR5 current joint positions:')
                for name, pos in zip(resp.joint_names, resp.positions):
                    deg = math.degrees(pos)
                    self.get_logger().info(f'  {name:20s}  {pos:+.4f} rad  ({deg:+7.2f} deg)')
            else:
                self.get_logger().warn(
                    'No joint data yet — make sure joint_state_server is running '
                    'and the UR5 has been launched'
                )
        except Exception as e:
            self.get_logger().error(f'Service call failed: {e}')


def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(UR5PoseClient())
    rclpy.shutdown()
