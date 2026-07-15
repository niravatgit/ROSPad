"""
demo_robot/rrt_planner.py

RRT path planner node.
Listens for a goal, plans a path, publishes it, and follows it.

Subscribes: /goal_pose  (geometry_msgs/PoseStamped)
            /odom       (nav_msgs/Odometry)
Publishes:  /planned_path (nav_msgs/Path)
            /cmd_vel      (geometry_msgs/Twist)

Auto-demo: publishes a goal to itself 2 s after startup so the planner
           runs immediately when launched in ROSPad.
"""

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import PoseStamped, Twist
from nav_msgs.msg import Path, Odometry
import math
import random


def _position_from_odom(msg):
    """Extract (x, y) robustly from Odometry, handling flat JS dicts from sim."""
    pose = msg.pose
    if isinstance(pose, dict):
        pos = pose.get('position', {})
        if isinstance(pos, dict):
            return pos.get('x', 0.0), pos.get('y', 0.0)
        return 0.0, 0.0
    try:
        p = pose.position if hasattr(pose, 'position') else pose.pose.position
        return p.x, p.y
    except Exception:
        return 0.0, 0.0


class RRTPlanner(Node):
    """
    Rapidly-exploring Random Tree (RRT) planner.
    Students can modify the core RRT logic below.
    The ROS2 interface (topics, callbacks) stays the same.
    """

    def __init__(self):
        super().__init__('rrt_planner')

        self.declare_parameter('max_iter',  2000)
        self.declare_parameter('step_size', 0.15)
        self.declare_parameter('goal_bias', 0.1)
        self.declare_parameter('map_size',  5.0)

        self.max_iter  = self.get_parameter('max_iter').value
        self.step      = self.get_parameter('step_size').value
        self.goal_bias = self.get_parameter('goal_bias').value
        self.map_size  = self.get_parameter('map_size').value

        self.pub_path = self.create_publisher(Path,       '/planned_path', 10)
        self.pub_vel  = self.create_publisher(Twist,      '/cmd_vel',      10)
        self.pub_goal = self.create_publisher(PoseStamped,'/goal_pose',    10)

        self.sub_goal = self.create_subscription(
            PoseStamped, '/goal_pose', self.goal_callback, 10)
        self.sub_odom = self.create_subscription(
            Odometry, '/odom', self.odom_callback, 10)

        # Obstacles (x, y, radius) — matches default sim obstacles
        self.obstacles = [
            (1.5,  0.5, 0.4),
            (-1.0, 1.0, 0.3),
            (0.5, -1.5, 0.5),
        ]

        self.start    = (0.0, 0.0)
        self.path     = []
        self.path_idx = 0

        self.create_timer(0.1, self.control_loop)

        # Auto-demo: send a goal 2 s after startup
        self._demo_fired = False
        self.create_timer(2.0, self._auto_goal)

        self.get_logger().info('RRT Planner ready — auto-goal fires in 2 s')

    # ── Auto-demo ─────────────────────────────────────────────────────────────

    def _auto_goal(self):
        if self._demo_fired:
            return
        self._demo_fired = True
        goal = PoseStamped()
        goal.header.frame_id = 'map'
        goal.pose.position.x = 2.0
        goal.pose.position.y = 2.0
        self.get_logger().info('Auto-demo: publishing goal (2.0, 2.0)')
        self.pub_goal.publish(goal)

    # ── RRT Core ──────────────────────────────────────────────────────────────

    def rrt(self, start, goal):
        """
        Basic RRT. Returns list of (x, y) waypoints or [].
        Students can replace this with RRT*, RRT-Connect, etc.
        """
        tree   = [start]
        parent = {start: None}

        for _ in range(self.max_iter):
            q_rand = goal if random.random() < self.goal_bias else (
                random.uniform(-self.map_size, self.map_size),
                random.uniform(-self.map_size, self.map_size),
            )

            q_near = min(tree, key=lambda n: self._dist(n, q_rand))
            q_new  = self._steer(q_near, q_rand)

            if self._collides(q_near, q_new):
                continue

            tree.append(q_new)
            parent[q_new] = q_near

            if self._dist(q_new, goal) < self.step:
                parent[goal] = q_new
                return self._extract_path(parent, start, goal)

        self.get_logger().warn('RRT: max iterations reached, no path found')
        return []

    def _steer(self, q_from, q_to):
        d = self._dist(q_from, q_to)
        if d < self.step:
            return q_to
        r = self.step / d
        return (q_from[0] + r * (q_to[0] - q_from[0]),
                q_from[1] + r * (q_to[1] - q_from[1]))

    def _dist(self, a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1])

    def _collides(self, q_from, q_to):
        for (ox, oy, r) in self.obstacles:
            for t in [0, 0.25, 0.5, 0.75, 1.0]:
                x = q_from[0] + t * (q_to[0] - q_from[0])
                y = q_from[1] + t * (q_to[1] - q_from[1])
                if math.hypot(x - ox, y - oy) < r + 0.15:
                    return True
        return False

    def _extract_path(self, parent, start, goal):
        path, node = [], goal
        while node is not None:
            path.append(node)
            node = parent.get(node)
        return list(reversed(path))

    # ── ROS2 Callbacks ────────────────────────────────────────────────────────

    def goal_callback(self, msg: PoseStamped):
        goal = (msg.pose.position.x, msg.pose.position.y)
        self.get_logger().info(f'Planning to ({goal[0]:.2f}, {goal[1]:.2f})...')

        path_pts = self.rrt(self.start, goal)

        if path_pts:
            self.get_logger().info(f'Path found: {len(path_pts)} waypoints')
            self.path     = path_pts
            self.path_idx = 0
            self._publish_path(path_pts)
        else:
            self.get_logger().error('No path found!')

    def odom_callback(self, msg: Odometry):
        self.start = _position_from_odom(msg)

    def control_loop(self):
        """Simple pure-pursuit path follower."""
        if not self.path or self.path_idx >= len(self.path):
            return

        wp   = self.path[self.path_idx]
        dx   = wp[0] - self.start[0]
        dy   = wp[1] - self.start[1]
        dist = math.hypot(dx, dy)

        if dist < 0.15:
            self.path_idx += 1
            if self.path_idx >= len(self.path):
                self.get_logger().info('Goal reached!')
                self.pub_vel.publish(Twist())
            return

        twist = Twist()
        twist.linear.x  = min(0.3, dist * 0.5)
        twist.angular.z = math.atan2(dy, dx) * 1.5
        self.pub_vel.publish(twist)

    def _publish_path(self, pts):
        path_msg = Path()
        path_msg.header.frame_id = 'map'
        for (x, y) in pts:
            pose = PoseStamped()
            pose.header.frame_id = 'map'
            pose.pose.position.x = x
            pose.pose.position.y = y
            path_msg.poses.append(pose)
        self.pub_path.publish(path_msg)


def main(args=None):
    rclpy.init(args=args)
    node = RRTPlanner()
    rclpy.spin(node)
    rclpy.shutdown()