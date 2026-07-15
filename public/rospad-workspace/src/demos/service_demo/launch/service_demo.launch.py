"""
service_demo.launch.py

Starts the AddTwoInts service server. The client is a separate script
so you can see the server's "ready" log message before the client calls.

Usage:
  1. Click ⚡ Launch  →  server starts, prints "Service /add_two_ints is ready"
  2. Open add_two_ints_client.py and click ▶ Run
  3. Watch the terminal: server prints the computation, client prints the result
"""

from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        Node(package='service_demo', executable='server'),
    ])
