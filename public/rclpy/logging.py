"""rclpy/logging.py — logging stubs matching real rclpy"""

class LoggingSeverity:
    DEBUG = 10
    INFO = 20
    WARN = 30
    ERROR = 40
    FATAL = 50

def get_logger(name):
    from rclpy.node import Logger
    return Logger(name)

def set_logger_level(name, level):
    pass
