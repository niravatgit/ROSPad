from setuptools import setup

package_name = 'talker_listener'

setup(
    name=package_name,
    version='0.0.1',
    packages=[package_name],
    install_requires=['setuptools'],
    entry_points={
        'console_scripts': [
            'talker  = talker_listener.talker:main',
            'listener = talker_listener.listener:main',
        ],
    },
)
