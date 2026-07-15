from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        Node(
            package='rospad',
            executable='sim',
            name='sim_bridge',
            output='screen',
        ),
  
    ])
