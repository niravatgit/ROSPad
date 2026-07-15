from setuptools import setup

package_name = 'ur5_control'

setup(
    name=package_name,
    version='0.0.1',
    packages=[package_name],
    install_requires=['setuptools'],
    entry_points={
        'console_scripts': [
            'joint_state_publisher = ur5_control.joint_state_publisher:main',
            'joint_sine_demo       = ur5_control.joint_sine_demo:main',
            'joint_controller      = ur5_control.joint_controller:main',
            'joint_state_server    = ur5_control.joint_state_server:main',
        ],
    },
)
