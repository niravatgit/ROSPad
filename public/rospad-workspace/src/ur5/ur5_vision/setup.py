from setuptools import setup

package_name = 'ur5_vision'

setup(
    name=package_name,
    version='0.1.0',
    packages=[package_name],
    install_requires=['setuptools'],
    entry_points={
        'console_scripts': [
            'wrist_detector = ur5_vision.wrist_detector:main',
            'image_info     = ur5_vision.image_info:main',
        ],
    },
)
