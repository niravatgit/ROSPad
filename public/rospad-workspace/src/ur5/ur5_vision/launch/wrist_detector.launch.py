from launch import LaunchDescription
from launch_ros.actions import Node

def generate_launch_description():
    return LaunchDescription([
        Node(package='ur5_vision', executable='wrist_detector', name='wrist_detector'),
    ])
