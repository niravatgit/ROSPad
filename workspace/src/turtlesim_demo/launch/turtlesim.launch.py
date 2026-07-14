from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        Node(package='turtlesim_demo', executable='turtle_node'),
        Node(package='turtlesim_demo', executable='teleop_key'),
    ])
