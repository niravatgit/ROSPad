from setuptools import setup

package_name = 'demo_robot'

setup(
    name=package_name,
    version='0.1.0',
    packages=[package_name],
    install_requires=['setuptools'],
    entry_points={
        'console_scripts': [
            'diff_drive = demo_robot.diff_drive_controller:main',
            'rrt_planner = demo_robot.rrt_planner:main',
        ],
    },
)
