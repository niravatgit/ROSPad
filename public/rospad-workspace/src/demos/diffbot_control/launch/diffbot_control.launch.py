from launch import LaunchDescription
from launch_ros.actions import Node

def generate_launch_description():
    return LaunchDescription([
        Node(package='diffbot_control', executable='circle_drive', name='circle_drive'),
    ])
