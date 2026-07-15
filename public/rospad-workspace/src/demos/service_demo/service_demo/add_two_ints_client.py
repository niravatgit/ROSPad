"""
add_two_ints_client.py — ROS2 service client: AddTwoInts

Calls the /add_two_ints service with a=3, b=4 and prints the result.

Make sure add_two_ints_server.py is running before you click ▶ Run here.
The client waits 1.5 seconds before calling to give the server time to start.

Edit A and B below to try different numbers.
"""

import asyncio
import rclpy
from rclpy.node import Node
from example_interfaces.srv import AddTwoInts

# ── Edit these ────────────────────────────────────────────────────────────────
A = 3
B = 4
# ─────────────────────────────────────────────────────────────────────────────


class AddTwoIntsClient(Node):
    def __init__(self):
        super().__init__('add_two_ints_client')
        self._done = False
        self.client = self.create_client(AddTwoInts, '/add_two_ints')
        # Wait 1.5 s so the server is ready, then call once
        self.create_timer(1.5, self._call_once)
        self.get_logger().info(f'Will call /add_two_ints({A}, {B}) in 1.5 s...')

    def _call_once(self):
        if self._done:
            return
        self._done = True
        asyncio.ensure_future(self._do_call())

    async def _do_call(self):
        req = AddTwoInts.Request()
        req.a = A
        req.b = B
        self.get_logger().info(f'Calling /add_two_ints: {A} + {B}')
        try:
            resp = await self.client.call_async(req)
            self.get_logger().info(f'Result: {A} + {B} = {resp.sum}')
        except Exception as e:
            self.get_logger().error(f'Service call failed: {e}')


def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(AddTwoIntsClient())
    rclpy.shutdown()
