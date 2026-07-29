from setuptools import setup

package_name = 'vision_demos'

setup(
    name=package_name,
    version='0.0.1',
    packages=[package_name],
    install_requires=['setuptools'],
    entry_points={
        'console_scripts': [
            'color_tracker  = vision_demos.color_tracker:main',
            'wrist_detector = vision_demos.wrist_detector:main',
            'image_info     = vision_demos.image_info:main',
        ],
    },
)
