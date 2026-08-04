from setuptools import setup

package_name = 'planner_demo'

setup(
    name=package_name,
    version='0.1.0',
    packages=[package_name],
    install_requires=['setuptools'],
    entry_points={
        'console_scripts': [
            'diff_drive = planner_demo.diff_drive_controller:main',
            'rrt_planner = planner_demo.rrt_planner:main',
        ],
    },
)
