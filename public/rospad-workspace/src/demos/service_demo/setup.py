from setuptools import setup

package_name = 'service_demo'

setup(
    name=package_name,
    version='0.0.1',
    packages=[package_name],
    install_requires=['setuptools'],
    entry_points={
        'console_scripts': [
            'server       = service_demo.add_two_ints_server:main',
            'client       = service_demo.add_two_ints_client:main',
            'ur5_client   = service_demo.ur5_pose_client:main',
        ],
    },
)
