import rclpy
from rclpy.node import Node
from std_msgs.msg import String

class Listener(Node):
    def __init__(self):
        super().__init__('listener')
        self.create_subscription(String, '/chatter', self.callback, 10)
        self.get_logger().info('Listener started, waiting for messages...')

    def callback(self, msg):
        self.get_logger().info(f'Heard: {msg.data}')

def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(Listener())
    rclpy.shutdown()
