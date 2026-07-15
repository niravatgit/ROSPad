from setuptools import setup

package_name = 'diffbot_control'

setup(
    name=package_name,
    version='0.0.1',
    packages=[package_name],
    install_requires=['setuptools'],
    entry_points={
        'console_scripts': [
            'teleop_keyboard = diffbot_control.teleop_keyboard:main',
            'odometry_reader = diffbot_control.odometry_reader:main',
            'circle_drive    = diffbot_control.circle_drive:main',
        ],
    },
)
