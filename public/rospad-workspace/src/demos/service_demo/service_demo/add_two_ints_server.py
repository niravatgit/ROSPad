"""
add_two_ints_server.py — ROS2 service server: AddTwoInts

Advertises the /add_two_ints service. Any client can call it with two
integers (a, b) and get back their sum.

This is the classic ROS2 service tutorial rewritten for ROSpad.
Run this first, then open add_two_ints_client.py and click ▶ Run.

Official docs reference:
  https://docs.ros.org/en/humble/Tutorials/Beginner-Client-Libraries/Writing-A-Simple-Py-Service-And-Client.html
"""

import rclpy
from rclpy.node import Node
from example_interfaces.srv import AddTwoInts


class AddTwoIntsServer(Node):
    def __init__(self):
        super().__init__('add_two_ints_server')
        self.srv = self.create_service(AddTwoInts, '/add_two_ints', self.handle_request)
        self.get_logger().info('Service /add_two_ints is ready — waiting for requests')

    def handle_request(self, request, response):
        response.sum = request.a + request.b
        self.get_logger().info(
            f'Request: {request.a} + {request.b} = {response.sum}'
        )
        return response


def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(AddTwoIntsServer())
    rclpy.shutdown()
