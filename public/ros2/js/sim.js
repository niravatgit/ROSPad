/**
 * sim.js — Three.js 3D simulation, LiDAR raycasting, WASD keyboard teleop
 *
 * Camera: manual orbit controls (drag to rotate, scroll to zoom).
 * Teleop: WASD only active when the sim canvas has focus (click canvas first).
 */

// ── Orbit camera state ────────────────────────────────────────────────────────
const orbitCam = {
  theta:    0.5,   // horizontal angle (radians)
  phi:      0.55,  // vertical elevation (radians)
  radius:   4.0,   // distance from target
  tx: 0, ty: 0.3, tz: 0,   // look-at target (tracks robot)
  dragging: false,
  lastX: 0, lastY: 0,
};

// ── Canvas focus state (gate WASD to sim canvas only) ─────────────────────────
let simCanvasFocused = false;

// ── Keyboard teleop state ─────────────────────────────────────────────────────
const keysDown = {};
let lastTeleopPublish = 0;
let lastTeleopActive  = false;

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (['w','a','s','d'].includes(k) && simCanvasFocused) {
    keysDown[k] = true;
    rosBus.publish('/rospad/key', 'std_msgs/String', { data: `${k}:down` });
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (['w','a','s','d'].includes(k)) {
    keysDown[k] = false;
    if (simCanvasFocused) rosBus.publish('/rospad/key', 'std_msgs/String', { data: `${k}:up` });
  }
});

// ── Simulation state ──────────────────────────────────────────────────────────
let simScene, simCamera, simRenderer, simRobot;
let lidarLines    = null;
let lastLidarUpdate = 0;
const LIDAR_N     = 360;
const LIDAR_RANGE = 5.0;
const simObstacles  = []; // tracked meshes for LiDAR raycasting + collision
const ROBOT_RADIUS  = 0.26; // metres — bounding circle of diffbot footprint
let   _robotUrdfXml = null; // stored when URDF is loaded; reused on reset
let   _armJointData = []; // [{parent,child,xyz,rpy,axis}] revolute joints — populated by arm URDF builder
let   _armStaticTF  = []; // [{parent,child,xyz,rpy}] fixed joints — populated by arm URDF builder

// ── Robot camera rigs (sensor_msgs/Image publishers driven by WebGLRenderTarget)
let _robotCameras = []; // [{cam, target, mount, topic, width, height, lastMs}]

// ── Bullet physics (ammo.js) ──────────────────────────────────────────────────
let _Ammo             = null;  // resolved ammo.js namespace
let physicsWorld      = null;
let robotBody         = null;
let _tmpAmmoVec       = null;  // reusable btVector3 — avoids per-frame allocation
let _tmpAmmoTransform = null;  // reusable btTransform

function _initPhysics() {
  if (typeof Ammo === 'undefined') { console.warn('ammo.js not loaded — physics disabled'); return; }
  // Some CDN builds expose Ammo as the ready namespace; others return a Promise
  const ammoReady = typeof Ammo === 'function' ? Ammo() : Promise.resolve(Ammo);
  ammoReady.then(ammo => {
    try {
    _Ammo = ammo;
    const A = _Ammo;

    _tmpAmmoVec       = new A.btVector3(0, 0, 0);
    _tmpAmmoTransform = new A.btTransform();

    const cc  = new A.btDefaultCollisionConfiguration();
    const disp = new A.btCollisionDispatcher(cc);
    const bp   = new A.btDbvtBroadphase();
    const solver = new A.btSequentialImpulseConstraintSolver();
    physicsWorld = new A.btDiscreteDynamicsWorld(disp, bp, solver, cc);
    physicsWorld.setGravity(new A.btVector3(0, -9.82, 0));

    // Static ground plane
    const gndShape = new A.btStaticPlaneShape(new A.btVector3(0, 1, 0), 0);
    const gndT     = new A.btTransform(); gndT.setIdentity();
    const gndBody  = new A.btRigidBody(
      new A.btRigidBodyConstructionInfo(0, new A.btDefaultMotionState(gndT), gndShape, new A.btVector3(0, 0, 0))
    );
    physicsWorld.addRigidBody(gndBody);

    // Kinematic robot body — position driven by our own integration + collision code
    const rShape = new A.btSphereShape(ROBOT_RADIUS);
    const rT     = new A.btTransform(); rT.setIdentity();
    rT.setOrigin(new A.btVector3(0, ROBOT_RADIUS, 0));
    robotBody = new A.btRigidBody(
      new A.btRigidBodyConstructionInfo(0, new A.btDefaultMotionState(rT), rShape, new A.btVector3(0, 0, 0))
    );
    robotBody.setCollisionFlags(robotBody.getCollisionFlags() | 2); // CF_KINEMATIC_OBJECT
    robotBody.setActivationState(4); // DISABLE_DEACTIVATION
    physicsWorld.addRigidBody(robotBody);

    // Build bodies for any obstacles already in scene
    simObstacles.forEach(obs => { if (!obs.userData.physBody) obs.userData.physBody = _makeObsBody(obs); });
    } catch(e) { console.warn('ammo.js init failed — physics disabled:', e.message); _Ammo = null; physicsWorld = null; }
  });
}

function _makeObsBody(obs) {
  const A = _Ammo;
  if (!A || !physicsWorld) return null;
  const shape = obs.userData.shape || 'box';
  const p = obs.geometry.parameters;
  const s = obs.scale;
  let btShape;
  switch (shape) {
    case 'sphere':
      btShape = new A.btSphereShape(p.radius * Math.max(s.x, s.y, s.z));
      break;
    case 'cylinder':
      btShape = new A.btCylinderShape(new A.btVector3(p.radiusTop * s.x, p.height / 2 * s.y, p.radiusTop * s.x));
      break;
    default:
      btShape = new A.btBoxShape(new A.btVector3(p.width / 2 * s.x, p.height / 2 * s.y, p.depth / 2 * s.z));
  }
  const t = new A.btTransform(); t.setIdentity();
  t.setOrigin(new A.btVector3(obs.position.x, obs.position.y, obs.position.z));
  const body = new A.btRigidBody(
    new A.btRigidBodyConstructionInfo(0, new A.btDefaultMotionState(t), btShape, new A.btVector3(0, 0, 0))
  );
  body.setCollisionFlags(body.getCollisionFlags() | 2); // CF_KINEMATIC_OBJECT
  body.setActivationState(4); // DISABLE_DEACTIVATION
  physicsWorld.addRigidBody(body);
  return body;
}

function _rebuildObsBody(obs) {
  if (!_Ammo || !physicsWorld) return;
  const old = obs.userData.physBody;
  if (old) physicsWorld.removeRigidBody(old);
  obs.userData.physBody = _makeObsBody(obs);
}

// Simulation running state — false = render only, no topic publishing
let simRunning = false;

function startSim() {
  if (simRunning) return;
  simRunning = true;
  rosBus.registerNode('sim_bridge');
  // Only declare universal topics here — robot-specific ones are added in _loadRobotFromUrdf()
  ['/tf', '/tf_static'].forEach(t => rosBus.trackPublisher(t, 'sim_bridge'));
  rosBus.trackSubscriber('/robot_description', 'sim_bridge');
}

function stopSim() {
  simRunning = false;
  ['w','a','s','d'].forEach(k => { keysDown[k] = false; });
  clearRobot();
  rosBus.unregisterNode('sim_bridge');
}

function clearRobot() {
  _clearCameraRigs();
  if (simRobot) { simScene.remove(simRobot); simRobot = null; }
  // Turtle is created once at init and stays in the scene — just hide it and
  // reset state so the next cmd_vel can make it reappear (don't null/remove it)
  if (_simTurtle) { _simTurtle.visible = false; _simTurtle.position.set(0, 0, 0); }
  Object.assign(_simTurtleState, { x: 0, y: 0, theta: 0, vx: 0, wz: 0, active: false });
  _clearTurtleTrail();
  _setSimLabel('');
}

// ── URDF helpers ──────────────────────────────────────────────────────────────
function _parseXyz(s) {
  if (!s) return [0, 0, 0];
  return s.trim().split(/\s+/).map(Number);
}
function _parseRgba(s) {
  if (!s) return 0x888888;
  const [r, g, b] = s.trim().split(/\s+/).map(Number);
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

// Build a Three.js group from a URDF XML string.
// Supports box, cylinder, sphere primitives. Applies the full kinematic chain
// (joint origins) and the ROS → Three.js coordinate frame conversion:
//   ROS(x=fwd, y=left, z=up) → Three.js(-y, z, x)  i.e. T = [[0,-1,0],[0,0,1],[1,0,0]]
//
// Visual origins with arbitrary RPY are converted by:
//   M_three = T * (Rz(yaw)*Ry(pitch)*Rx(roll) | xyz_ros) * T^T
//
// The returned group's origin is the URDF root link (e.g. base_footprint at ground).
// A LiDAR visual element is added at the top of the robot if the URDF has no ray sensor.
async function _buildUrdfVisuals(urdfXml) {
  const doc = new DOMParser().parseFromString(urdfXml, 'text/xml');

  // Dispatch to arm builder for serial manipulators (≥ 4 revolute joints, no wheel links)
  const nRevolute = doc.querySelectorAll('robot > joint[type="revolute"]').length;
  const hasWheels = /wheel/i.test(urdfXml);
  if (!hasWheels && nRevolute >= 4) return _buildArmVisualsFromUrdf(doc);

  const grp = new THREE.Group();

  // Frame transform matrices: T(3×3) maps ROS→THREE.js, T^T is its inverse.
  // Encoded as homogeneous 4×4 (last row/col = identity).
  const T = new THREE.Matrix4().set(
     0, -1,  0, 0,
     0,  0,  1, 0,
     1,  0,  0, 0,
     0,  0,  0, 1
  );
  const TT = new THREE.Matrix4().set(   // T^T = T^{-1} (T is orthogonal)
     0,  0,  1, 0,
    -1,  0,  0, 0,
     0,  1,  0, 0,
     0,  0,  0, 1
  );

  // Build a Three.js Matrix4 from a ROS-space pose (xyz + RPY).
  // M_three = T * M_ros * T^T  (change-of-basis formula).
  function rosToThreeMat(xyz, rpy) {
    const [roll, pitch, yaw] = rpy;
    // ROS RPY = Rz(yaw) * Ry(pitch) * Rx(roll)  (extrinsic XYZ)
    const Rx = new THREE.Matrix4().makeRotationX(roll);
    const Ry = new THREE.Matrix4().makeRotationY(pitch);
    const Rz = new THREE.Matrix4().makeRotationZ(yaw);
    const M_ros = new THREE.Matrix4().multiplyMatrices(Rz, new THREE.Matrix4().multiplyMatrices(Ry, Rx));
    M_ros.setPosition(...xyz);
    return new THREE.Matrix4().multiplyMatrices(T, M_ros).multiply(TT);
  }

  // Parse every link's visuals
  const linkVisuals = {};
  for (const link of doc.querySelectorAll('robot > link')) {
    const name = link.getAttribute('name');
    const vs = [];
    for (const vis of link.querySelectorAll('visual')) {
      const o = vis.querySelector('origin');
      vs.push({
        xyz:   _parseXyz(o?.getAttribute('xyz')),
        rpy:   _parseXyz(o?.getAttribute('rpy')),
        geo:   vis.querySelector('geometry'),
        color: _parseRgba(vis.querySelector('material > color')?.getAttribute('rgba')),
      });
    }
    linkVisuals[name] = vs;
  }

  // Parse every joint
  const joints = {};
  for (const j of doc.querySelectorAll('robot > joint')) {
    const o = j.querySelector('origin');
    joints[j.getAttribute('name')] = {
      parent: j.querySelector('parent')?.getAttribute('link'),
      child:  j.querySelector('child')?.getAttribute('link'),
      xyz: _parseXyz(o?.getAttribute('xyz')),
      rpy: _parseXyz(o?.getAttribute('rpy')),
    };
  }

  // child link → the joint that produced it
  const childJoint = {};
  for (const j of Object.values(joints)) childJoint[j.child] = j;

  // Compute a link's Three.js world matrix by walking up to the root (memoised)
  const linkWorldMat = {};
  function getLinkWorld(name) {
    if (linkWorldMat[name]) return linkWorldMat[name];
    const pj = childJoint[name];
    if (!pj) return (linkWorldMat[name] = new THREE.Matrix4()); // root = identity
    const parentMat = getLinkWorld(pj.parent);
    const localMat  = rosToThreeMat(pj.xyz, pj.rpy);
    return (linkWorldMat[name] = new THREE.Matrix4().multiplyMatrices(parentMat, localMat));
  }

  // Material cache
  const matCache = {};
  const getLambertMat = c => (matCache[c] ??= new THREE.MeshLambertMaterial({ color: c }));

  // Build a Three.js geometry from a URDF <geometry> element.
  // Dimensions are given in ROS frame; BoxGeometry(sy, sz, sx) re-maps them so that
  // after the frame transform (x→z, y→-x, z→y) the extents land in the right axes.
  function makeGeo(geoEl) {
    const box = geoEl.querySelector('box');
    const cyl = geoEl.querySelector('cylinder');
    const sph = geoEl.querySelector('sphere');
    if (box) {
      const [sx, sy, sz] = _parseXyz(box.getAttribute('size'));
      return new THREE.BoxGeometry(sy, sz, sx); // width=ROS.y, height=ROS.z, depth=ROS.x
    }
    if (cyl) {
      const r = Number(cyl.getAttribute('radius') || 0.05);
      const l = Number(cyl.getAttribute('length') || 0.1);
      // URDF cylinder axis = ROS Z → after frame transform = Three.js Y (matches CylinderGeometry default)
      return new THREE.CylinderGeometry(r, r, l, 20);
    }
    if (sph) return new THREE.SphereGeometry(Number(sph.getAttribute('radius') || 0.025), 12, 8);
    return null; // mesh files not supported — handled via GLB loader elsewhere
  }

  // Place each visual as a mesh in the group
  let hasLidar = false;
  for (const [linkName, visuals] of Object.entries(linkVisuals)) {
    if (linkName.toLowerCase().includes('lidar') || linkName.toLowerCase().includes('laser'))
      hasLidar = true;
    const worldMat = getLinkWorld(linkName);
    for (const { xyz, rpy, geo, color } of visuals) {
      if (!geo) continue;
      const geometry = makeGeo(geo);
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, getLambertMat(color));
      // Compose: link's world matrix × visual-origin transform (both in Three.js space)
      const visMat = new THREE.Matrix4().multiplyMatrices(worldMat, rosToThreeMat(xyz, rpy));
      mesh.applyMatrix4(visMat);
      mesh.castShadow = true;
      grp.add(mesh);
    }
  }

  // LiDAR visual — added only if the URDF does not already define a ray sensor link
  if (!hasLidar) {
    const lidar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.05, 16),
      getLambertMat(0x58a6ff)
    );
    lidar.position.set(0, 0.22, 0);
    grp.add(lidar);
  }

  return grp;
}

// Build a hierarchical arm scene graph from a parsed URDF document.
// Uses wrapper.rotation.x = -π/2 to convert ROS Z-up → Three.js Y-up in one shot.
// Joint xyz/rpy are applied in ROS-space within the wrapper.
// GLBs are pre-aligned to their link frames so visual origins are skipped for mesh geometry.
// Mesh loads fire in background; wrapper is returned immediately so the arm structure is visible.
function _buildArmVisualsFromUrdf(doc) {
  const wrapper = new THREE.Group();
  wrapper.rotation.x = -Math.PI / 2;

  // ── Parse joints ────────────────────────────────────────────────────────────
  const parsedJoints = {};
  for (const j of doc.querySelectorAll('robot > joint')) {
    const o  = j.querySelector('origin');
    const ax = j.querySelector('axis');
    parsedJoints[j.getAttribute('name')] = {
      type:   j.getAttribute('type') ?? 'fixed',
      parent: j.querySelector('parent')?.getAttribute('link') ?? '',
      child:  j.querySelector('child')?.getAttribute('link') ?? '',
      xyz:    _parseXyz(o?.getAttribute('xyz')),
      rpy:    _parseXyz(o?.getAttribute('rpy')),
      axis:   ax ? _parseXyz(ax.getAttribute('xyz')) : [0, 0, 1],
    };
  }

  // ── Find root link (not a child of any joint) ────────────────────────────────
  const allLinks   = new Set();
  const childLinks = new Set();
  for (const j of Object.values(parsedJoints)) {
    allLinks.add(j.parent); allLinks.add(j.child); childLinks.add(j.child);
  }
  const rootLink = [...allLinks].find(l => !childLinks.has(l)) ?? 'world';

  // ── BFS to order joints parent → child ──────────────────────────────────────
  const queue = [rootLink], visited = new Set([rootLink]), orderedJoints = [];
  while (queue.length) {
    const cur = queue.shift();
    for (const j of Object.values(parsedJoints)) {
      if (j.parent === cur && !visited.has(j.child)) {
        orderedJoints.push(j); visited.add(j.child); queue.push(j.child);
      }
    }
  }

  // ── Build group hierarchy in ROS-space ──────────────────────────────────────
  const linkGroups = {};
  const getLinkGrp = name => (linkGroups[name] ??= new THREE.Group());
  const revoluteGroups = [];
  _armJointData = [];
  _armStaticTF  = [];

  for (const j of orderedJoints) {
    const childGrp = getLinkGrp(j.child);
    childGrp.position.set(j.xyz[0], j.xyz[1], j.xyz[2]);
    const origQuat = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(j.rpy[0], j.rpy[1], j.rpy[2], 'ZYX'));
    childGrp.quaternion.copy(origQuat);

    if (j.type === 'revolute' || j.type === 'continuous') {
      childGrp._origQuat = origQuat.clone();
      childGrp._axis     = new THREE.Vector3(j.axis[0], j.axis[1], j.axis[2]);
      revoluteGroups.push(childGrp);
      _armJointData.push({ parent: j.parent, child: j.child, xyz: j.xyz, rpy: j.rpy, axis: j.axis });
    } else if (j.type === 'fixed') {
      _armStaticTF.push({ parent: j.parent, child: j.child, xyz: j.xyz, rpy: j.rpy });
    }
    getLinkGrp(j.parent).add(childGrp);
  }

  wrapper.add(getLinkGrp(rootLink));
  wrapper._armJoints = revoluteGroups;

  // ── Add visuals for each link ────────────────────────────────────────────────
  const ARM_COLORS = [0x546e7a, 0x1565c0, 0x2e7d32, 0xc62828, 0xf57f17, 0x6a1b9a, 0x00838f];
  let colorIdx = 0;
  const matCache = {};
  const getLambertMat = c => (matCache[c] ??= new THREE.MeshLambertMaterial({ color: c }));

  for (const link of doc.querySelectorAll('robot > link')) {
    const linkName = link.getAttribute('name');
    const linkGrp  = getLinkGrp(linkName);

    for (const vis of link.querySelectorAll('visual')) {
      const o     = vis.querySelector('origin');
      const vxyz  = _parseXyz(o?.getAttribute('xyz'));
      const vrpy  = _parseXyz(o?.getAttribute('rpy'));
      const geoEl = vis.querySelector('geometry');
      if (!geoEl) continue;

      const meshEl = geoEl.querySelector('mesh');
      const boxEl  = geoEl.querySelector('box');
      const cylEl  = geoEl.querySelector('cylinder');
      const sphEl  = geoEl.querySelector('sphere');

      if (meshEl) {
        const filename = meshEl.getAttribute('filename') ?? '';
        if (!filename.endsWith('.glb')) continue; // skip .dae / .stl
        const tint = ARM_COLORS[colorIdx++ % ARM_COLORS.length];
        // GLBs are pre-aligned to their link frame — skip visual origin (added at identity)
        const holder = new THREE.Group();
        linkGrp.add(holder);
        _loadGLBMesh(_resolveRosUrl(filename)).then(mg => {
          mg.traverse(c => { if (c.isMesh) c.material.color.setHex(tint); });
          holder.add(mg);
        }).catch(() => {
          holder.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), getLambertMat(tint)));
        });
      } else {
        // Primitive geometry: apply visual origin in ROS-space (within wrapper)
        const color  = _parseRgba(vis.querySelector('material > color')?.getAttribute('rgba'));
        const holder = new THREE.Group();
        holder.position.set(vxyz[0], vxyz[1], vxyz[2]);
        holder.quaternion.setFromEuler(new THREE.Euler(vrpy[0], vrpy[1], vrpy[2], 'ZYX'));
        linkGrp.add(holder);

        let geo = null;
        if (boxEl) {
          const [sx, sy, sz] = _parseXyz(boxEl.getAttribute('size'));
          geo = new THREE.BoxGeometry(sx, sy, sz);
        } else if (cylEl) {
          const r = Number(cylEl.getAttribute('radius') || 0.05);
          const l = Number(cylEl.getAttribute('length') || 0.1);
          geo = new THREE.CylinderGeometry(r, r, l, 20);
        } else if (sphEl) {
          geo = new THREE.SphereGeometry(Number(sphEl.getAttribute('radius') || 0.025), 12, 8);
        }
        if (geo) { const m = new THREE.Mesh(geo, getLambertMat(color)); m.castShadow = true; holder.add(m); }
      }
    }
  }

  return wrapper;
}

// ── URDF camera sensor parsing ────────────────────────────────────────────────
function _parseCamerasFromUrdf(urdfXml) {
  const dom = new DOMParser().parseFromString(urdfXml, 'text/xml');
  const cameras = [];
  dom.querySelectorAll('gazebo').forEach(gz => {
    const ref    = gz.getAttribute('reference');
    const sensor = gz.querySelector('sensor[type="camera"]');
    if (!sensor || !ref) return;
    const w   = parseInt(sensor.querySelector('image width')?.textContent  || '320');
    const h   = parseInt(sensor.querySelector('image height')?.textContent || '240');
    const fov = parseFloat(sensor.querySelector('horizontal_fov')?.textContent || '1.0472');
    let topic = '/camera/image_raw';
    const remap = sensor.querySelector('remapping');
    if (remap) {
      const m = remap.textContent.match(/:=\s*(\S+)/);
      if (m) topic = m[1].trim();
    }
    // Find the fixed joint that attaches this link to its parent, extract xyz offset
    let offset = [0, 0, 0];
    for (const j of dom.querySelectorAll('joint')) {
      if (j.querySelector('child')?.getAttribute('link') === ref) {
        const orig = j.querySelector('origin');
        if (orig) offset = (orig.getAttribute('xyz') || '0 0 0').split(/\s+/).map(Number);
        break;
      }
    }
    cameras.push({ ref, topic, width: w, height: h, fov, offset });
  });
  return cameras;
}

// Dispose all active camera rigs (call before loading a new robot)
function _clearCameraRigs() {
  for (const rig of _robotCameras) {
    if (rig.mount.parent) rig.mount.parent.remove(rig.mount);
    rig.target.dispose();
  }
  _robotCameras = [];
}

// Build Three.js camera rigs from parsed URDF camera definitions.
// Each rig: a PerspectiveCamera + WebGLRenderTarget attached to the robot.
function _setupCameraRigs(cameras, robot, robotType) {
  if (!cameras.length || !robot || !simRenderer || !simScene) return;
  cameras.forEach(def => {
    // URDF uses ROS frame (x=forward, y=left, z=up).
    // Three.js DiffBot local frame: z=forward, y=up, x=right.
    // Conversion: urdf(x,y,z) → three(-y, z, x)
    const [ux, uy, uz] = def.offset;

    // Attachment point: wrist_3 for arm cameras, robot root for diffbot
    let attachTo = robot;
    if (robotType === 'arm') {
      const joints = robot._armJoints;
      if (joints?.length) attachTo = joints[joints.length - 1];
    }

    const mount = new THREE.Object3D();
    if (robotType === 'arm') {
      // Arm hierarchy uses ROS Z-up coordinates internally (the wrapper at the top
      // converts to Three.js Y-up). Use the URDF joint offset directly.
      mount.position.set(ux, uy, uz);
    } else {
      // DiffBot: robot root is in Three.js Y-up space; convert ROS(x,y,z)→Three.js(-y,z,x).
      mount.position.set(-uy, uz, ux);
    }
    attachTo.add(mount);

    const fovDeg = def.fov * (180 / Math.PI);
    const cam = new THREE.PerspectiveCamera(fovDeg, def.width / def.height, 0.01, 50);
    // Three.js camera looks along local -Z by default.
    // DiffBot forward = robot local +Z → rotate camera 180° around Y so -Z becomes +Z.
    // UR5 arm joints are in ROS Z-up space (inside the -π/2 wrapper); keep default.
    if (robotType === 'diffbot') cam.rotation.y = Math.PI;
    mount.add(cam);

    // Visible camera body — procedural geometry so no STL file is needed
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6, metalness: 0.4 });
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.2, metalness: 0.8 });
    const body    = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.032, 0.042), bodyMat);
    const lens    = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.014, 0.022, 12), lensMat);
    if (robotType === 'diffbot') {
      // Camera looks along mount +Z; lens nub extends forward
      lens.rotation.x = Math.PI / 2;
      lens.position.z = 0.038;
    } else {
      // Camera looks along mount -Z; lens nub extends forward
      lens.rotation.x = Math.PI / 2;
      lens.position.z = -0.032;
    }
    // Layer 1 — visible in main viewport but invisible to the robot's render camera
    body.layers.set(1);
    lens.layers.set(1);
    mount.add(body);
    mount.add(lens);

    const target = new THREE.WebGLRenderTarget(def.width, def.height);
    _robotCameras.push({ cam, target, mount, topic: def.topic, frameId: def.ref,
                         width: def.width, height: def.height, lastMs: 0 });
    rosBus.trackPublisher(def.topic, 'sim_bridge', 'sensor_msgs/Image');
  });
}

// Called each animation frame: capture + publish at ~10 Hz per rig
function _captureCameraFrames(time) {
  if (!simRunning || !_robotCameras.length) return;
  for (const rig of _robotCameras) {
    if (time - rig.lastMs < 100) continue;
    rig.lastMs = time;

    simRenderer.setRenderTarget(rig.target);
    simRenderer.render(simScene, rig.cam);
    simRenderer.setRenderTarget(null);

    // Read RGBA pixels (OpenGL bottom-to-top) → flip + strip alpha → RGB
    const buf = new Uint8Array(rig.width * rig.height * 4);
    simRenderer.readRenderTargetPixels(rig.target, 0, 0, rig.width, rig.height, buf);
    const rgb = new Uint8Array(rig.width * rig.height * 3);
    for (let row = 0; row < rig.height; row++) {
      const srcRow = rig.height - 1 - row; // flip vertically
      for (let col = 0; col < rig.width; col++) {
        const s = (srcRow * rig.width + col) * 4;
        const d = (row   * rig.width + col) * 3;
        rgb[d] = buf[s]; rgb[d+1] = buf[s+1]; rgb[d+2] = buf[s+2];
      }
    }

    rosBus.publish(rig.topic, 'sensor_msgs/Image', {
      header: { stamp: { sec: Math.floor(time / 1000), nanosec: 0 }, frame_id: rig.frameId || 'camera_link' },
      height: rig.height,
      width:  rig.width,
      encoding: 'rgb8',
      is_bigendian: false,
      step: rig.width * 3,
      data: rgb,
    });
  }
}

// Full reset: stops sim, clears robot + camera rigs + turtle + obstacles + physics.
// Safe to call at any time — all guards are null-checked.
function simClearAll() {
  stopSim();  // sets simRunning=false, clears robot mesh, camera rigs, turtle state, rosBus

  // Remove placed obstacles from scene and physics world
  selectObs(null);
  simObstacles.forEach(o => {
    simScene.remove(o);
    if (o.userData.physBody && physicsWorld) physicsWorld.removeRigidBody(o.userData.physBody);
  });
  simObstacles.length = 0;

  // Reset robot physics body to origin so the next launch starts at (0,0)
  if (robotBody && _Ammo && _tmpAmmoTransform) {
    _tmpAmmoTransform.setIdentity();
    _tmpAmmoVec.setValue(0, ROBOT_RADIUS, 0);
    _tmpAmmoTransform.setOrigin(_tmpAmmoVec);
    robotBody.setWorldTransform(_tmpAmmoTransform);
    robotBody.getMotionState()?.setWorldTransform(_tmpAmmoTransform);
  }
}

window.startSim    = startSim;
window.stopSim     = stopSim;
window.clearRobot  = clearRobot;
window.simClearAll = simClearAll;
window.addObstacle = addObstacle;
window.resetSim    = resetSim;
Object.defineProperty(window, 'simRunning', { get: () => simRunning });

// ── Checkerboard floor texture ────────────────────────────────────────────────
function _makeFloorTex() {
  const size = 512, tile = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  for (let y = 0; y < size; y += tile) {
    for (let x = 0; x < size; x += tile) {
      ctx.fillStyle = ((x / tile + y / tile) & 1) ? '#111820' : '#0d1117';
      ctx.fillRect(x, y, tile, tile);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  return tex;
}


// ── 3D Turtle + trail (appears in main sim scene when /turtle1/cmd_vel is received) ───
let _simTurtle = null;
const _simTurtleState = { x: 0, y: 0, theta: 0, vx: 0, wz: 0, active: false };

// Trail: grows as the turtle moves, cleared on sim reset
const _TRAIL_MAX = 4000;
let _trailLine = null;
let _trailPositions = null; // Float32Array(TRAIL_MAX * 3)
let _trailCount = 0;
let _trailLastX = null;
let _trailLastZ = null;

function _initTurtleTrail() {
  _trailPositions = new Float32Array(_TRAIL_MAX * 3);
  _trailCount = 0; _trailLastX = null; _trailLastZ = null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(_trailPositions, 3));
  geo.setDrawRange(0, 0);
  _trailLine = new THREE.Line(
    geo,
    new THREE.LineBasicMaterial({ color: 0x22c55e, linewidth: 2, depthWrite: false })
  );
  _trailLine.frustumCulled = false;
  simScene.add(_trailLine);
}

function _addTrailPoint(x, z) {
  if (_trailLastX !== null && Math.abs(x - _trailLastX) < 0.005 && Math.abs(z - _trailLastZ) < 0.005) return;
  if (_trailCount < _TRAIL_MAX) {
    const i = _trailCount * 3;
    _trailPositions[i]   = x;
    _trailPositions[i+1] = 0.01; // just above ground
    _trailPositions[i+2] = z;
    _trailCount++;
    _trailLine.geometry.setDrawRange(0, _trailCount);
    _trailLine.geometry.attributes.position.needsUpdate = true;
  }
  _trailLastX = x; _trailLastZ = z;
}

function _clearTurtleTrail() {
  _trailCount = 0; _trailLastX = null; _trailLastZ = null;
  if (_trailLine) {
    _trailLine.geometry.setDrawRange(0, 0);
    _trailLine.geometry.attributes.position.needsUpdate = true;
  }
}

function _makeTurtle3D() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 0.025, 32),
    new THREE.MeshLambertMaterial({ color: 0x3fb950 })
  );
  body.position.y = 0.0125;
  body.castShadow = true;
  g.add(body);
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x22c55e, transparent: true, opacity: 0.8 })
  );
  shell.position.y = 0.025;
  g.add(shell);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.04, 0.10, 8),
    new THREE.MeshLambertMaterial({ color: 0x85e89d })
  );
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(0.22, 0.02, 0);
  g.add(nose);
  return g;
}

// ── initSim ───────────────────────────────────────────────────────────────────
function initSim() {
  const canvas = document.getElementById('sim-canvas');

  simScene = new THREE.Scene();
  simScene.background = new THREE.Color(0x070a0f);
  simScene.fog = new THREE.Fog(0x070a0f, 10, 50);

  simCamera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.01, 100);
  simCamera.layers.enable(1); // show camera body/lens meshes (hidden from robot render cams)
  // Initial position is overridden on the first animate() tick by updateOrbitCamera()
  simCamera.position.set(3, 3, 3);
  simCamera.lookAt(0, 0, 0);

  simRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  simRenderer.setPixelRatio(window.devicePixelRatio);
  simRenderer.shadowMap.enabled = true;
  simRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  resize();

  // Lighting
  simScene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(5, 10, 5);
  sun.castShadow = true;
  simScene.add(sun);

  // Checkerboard ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshLambertMaterial({ map: _makeFloorTex() })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  simScene.add(ground);
  // Brighter grid lines on top
  simScene.add(new THREE.GridHelper(20, 40, 0x21262d, 0x21262d));

  initLidar();
  initOrbitControls(canvas);
  animate();

  // Re-render whenever the sim panel is resized (drag handle or window resize)
  new ResizeObserver(() => resize()).observe(canvas.parentElement);

  // Receive /cmd_vel from Python nodes (or ros2 topic pub)
  rosBus.subscribe('/cmd_vel', 'geometry_msgs/Twist', (data) => {
    if (simRobot && simRobot.userData.type === 'diffbot') {
      simRobot.userData.vx = data.linear?.x  || 0;
      simRobot.userData.wz = data.angular?.z || 0;
    }
  });

  // Receive /joint_states for arm animation
  rosBus.subscribe('/joint_states', 'sensor_msgs/JointState', (data) => {
    if (simRobot && simRobot.userData.type === 'arm' && data.position) {
      updateArmJoints(data.position);
    }
  });

  // Turtle sim — appears in 3D scene when /turtle1/cmd_vel arrives (no URDF needed)
  _simTurtle = _makeTurtle3D();
  _simTurtle.visible = false;
  simScene.add(_simTurtle);
  _initTurtleTrail();
  rosBus.subscribe('/turtle1/cmd_vel', 'geometry_msgs/Twist', (data) => {
    _simTurtleState.vx = data.linear?.x  || 0;
    _simTurtleState.wz = data.angular?.z || 0;
    if (!_simTurtleState.active) {
      _simTurtleState.active = true;
      _simTurtle.visible = true;
      _setSimLabel('Turtle');
      // Start sim_bridge and declare turtle topics on first cmd_vel
      startSim();
      rosBus.trackSubscriber('/turtle1/cmd_vel', 'sim_bridge');
      rosBus.trackPublisher('/turtle1/pose', 'sim_bridge');
    }
  });

  // Load robot from URDF when a package is launched; also activates sim_bridge
  rosBus.subscribe('/robot_description', 'std_msgs/String', (data) => {
    const urdf = typeof data === 'string' ? data : data?.data;
    if (urdf) { startSim(); _loadRobotFromUrdf(urdf); }
  });

  _initVizMonitor();
  try { _initPhysics(); } catch(e) { console.error('_initPhysics failed:', e); }
}

// ── Raycasting helpers ────────────────────────────────────────────────────────
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function _makeRay(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  const y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  const rc = new THREE.Raycaster();
  rc.setFromCamera({ x, y }, simCamera);
  return rc;
}

function _pickObstacle(e, canvas) {
  const hits = _makeRay(e, canvas).intersectObjects(simObstacles, false);
  return hits.length > 0 ? hits[0].object : null;
}

function _groundHit(e, canvas) {
  const target = new THREE.Vector3();
  const hit = _makeRay(e, canvas).ray.intersectPlane(_groundPlane, target);
  return hit ? target : null;
}

// ── Obstacle selection & drag state ──────────────────────────────────────────
let _dragObs     = null; // { mesh, offX, offZ, startX, startY, moved }
let _selectedObs = null;
let _selHelper   = null;

function selectObs(obs) {
  if (_selHelper) { simScene.remove(_selHelper); _selHelper = null; }
  _selectedObs = obs;
  const panel = document.getElementById('obs-props');
  if (!obs) { if (panel) panel.style.display = 'none'; return; }
  _selHelper = new THREE.BoxHelper(obs, 0xffffff);
  _selHelper.material.transparent = true;
  _selHelper.material.opacity = 0.6;
  simScene.add(_selHelper);
  _updateObsPanel();
  if (panel) panel.style.display = 'block';
}

function _updateObsPanel() {
  if (!_selectedObs) return;
  const shape = _selectedObs.userData.shape || 'obstacle';
  const el = document.getElementById('obs-props-title');
  if (el) el.textContent = shape[0].toUpperCase() + shape.slice(1);
  const sx = _selectedObs.scale.x, sy = _selectedObs.scale.y, sz = _selectedObs.scale.z;
  ['x','y','z'].forEach((ax, i) => {
    const v = [sx, sy, sz][i];
    const inp = document.getElementById(`obs-s${ax}`);
    const lbl = document.getElementById(`obs-s${ax}-val`);
    if (inp) inp.value = v;
    if (lbl) lbl.textContent = v.toFixed(2) + '×';
  });
  const col = document.getElementById('obs-color');
  if (col) col.value = '#' + _selectedObs.material.color.getHexString();
}

function applyObsScale() {
  if (!_selectedObs) return;
  const sx = parseFloat(document.getElementById('obs-sx').value);
  const sy = parseFloat(document.getElementById('obs-sy').value);
  const sz = parseFloat(document.getElementById('obs-sz').value);
  _selectedObs.scale.set(sx, sy, sz);
  _selectedObs.position.y = _selectedObs.userData.halfH * sy;
  ['x','y','z'].forEach((ax, i) => {
    const lbl = document.getElementById(`obs-s${ax}-val`);
    if (lbl) lbl.textContent = [sx, sy, sz][i].toFixed(2) + '×';
  });
  _rebuildObsBody(_selectedObs);
}

function applyObsColor() {
  if (!_selectedObs) return;
  _selectedObs.material.color.set(document.getElementById('obs-color').value);
}

function deleteSelectedObs() {
  if (!_selectedObs) return;
  if (_selectedObs.userData.physBody && physicsWorld) physicsWorld.removeRigidBody(_selectedObs.userData.physBody);
  simScene.remove(_selectedObs);
  const idx = simObstacles.indexOf(_selectedObs);
  if (idx >= 0) simObstacles.splice(idx, 1);
  selectObs(null);
}

window.applyObsScale    = applyObsScale;
window.applyObsColor    = applyObsColor;
window.deleteSelectedObs = deleteSelectedObs;

// ── Orbit controls ────────────────────────────────────────────────────────────
function initOrbitControls(canvas) {
  canvas.setAttribute('tabindex', '0');
  canvas.style.outline = 'none';
  canvas.style.cursor  = 'grab';

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    canvas.focus();
    e.preventDefault();

    const obs = _pickObstacle(e, canvas);
    if (obs) {
      const gp = _groundHit(e, canvas);
      _dragObs = {
        mesh:   obs,
        offX:   gp ? obs.position.x - gp.x : 0,
        offZ:   gp ? obs.position.z - gp.z : 0,
        startX: e.clientX,
        startY: e.clientY,
        moved:  false,
      };
      canvas.style.cursor = 'move';
      return;
    }

    // Click on empty space → deselect
    if (_selectedObs) selectObs(null);

    orbitCam.dragging = true;
    orbitCam.lastX    = e.clientX;
    orbitCam.lastY    = e.clientY;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (_dragObs) {
      const dx = e.clientX - _dragObs.startX, dy = e.clientY - _dragObs.startY;
      if (!_dragObs.moved && dx * dx + dy * dy < 25) return; // 5 px threshold
      _dragObs.moved = true;
      const gp = _groundHit(e, canvas);
      if (gp) {
        const newX = gp.x + _dragObs.offX, newZ = gp.z + _dragObs.offZ;
        _dragObs.mesh.position.x = newX;
        _dragObs.mesh.position.z = newZ;
        const body = _dragObs.mesh.userData.physBody;
        if (body && _Ammo && _tmpAmmoTransform) {
          _tmpAmmoTransform.setIdentity();
          _tmpAmmoVec.setValue(newX, _dragObs.mesh.position.y, newZ);
          _tmpAmmoTransform.setOrigin(_tmpAmmoVec);
          body.getMotionState().setWorldTransform(_tmpAmmoTransform);
          body.setCenterOfMassTransform(_tmpAmmoTransform);
        }
      }
      return;
    }

    if (!orbitCam.dragging) return;
    const dx = e.clientX - orbitCam.lastX;
    const dy = e.clientY - orbitCam.lastY;
    orbitCam.theta -= dx * 0.008;
    orbitCam.phi    = Math.max(0.05, Math.min(1.5, orbitCam.phi - dy * 0.008));
    orbitCam.lastX  = e.clientX;
    orbitCam.lastY  = e.clientY;
  });

  window.addEventListener('mouseup', () => {
    if (_dragObs) {
      if (!_dragObs.moved) selectObs(_dragObs.mesh); // click → select
      _dragObs = null;
    }
    orbitCam.dragging   = false;
    canvas.style.cursor = 'grab';
  });

  // Hover cursor — pointer over obstacle, grab otherwise
  canvas.addEventListener('mousemove', (e) => {
    if (_dragObs || orbitCam.dragging) return;
    canvas.style.cursor = _pickObstacle(e, canvas) ? 'pointer' : 'grab';
  });

  // Scroll → zoom
  canvas.addEventListener('wheel', (e) => {
    orbitCam.radius = Math.max(1.0, Math.min(12.0, orbitCam.radius + e.deltaY * 0.01));
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('focus', () => { simCanvasFocused = true; });
  canvas.addEventListener('blur',  () => {
    simCanvasFocused = false;
    ['w','a','s','d'].forEach(k => { keysDown[k] = false; });
  });
}

function updateOrbitCamera() {
  // Smoothly pan target toward robot position
  if (simRobot?.userData?.type === 'diffbot') {
    const d = simRobot.userData;
    orbitCam.tx += (-d.y - orbitCam.tx) * 0.08;
    orbitCam.tz += (d.x - orbitCam.tz) * 0.08; // d.x maps to world Z (robot forward)
  } else {
    orbitCam.tx = 0; orbitCam.ty = 0.3; orbitCam.tz = 0;
  }

  const { tx, ty, tz, radius: r, phi: ph, theta: th } = orbitCam;
  simCamera.position.set(
    tx + r * Math.cos(ph) * Math.sin(th),
    ty + r * Math.sin(ph),
    tz + r * Math.cos(ph) * Math.cos(th),
  );
  simCamera.lookAt(tx, ty, tz);
}

// ── Robot loading ─────────────────────────────────────────────────────────────
function _setSimLabel(text) {
  const el = document.getElementById('sim-robot-label');
  if (el) el.textContent = text;
}

async function loadRobot(type, cameras = []) {
  _clearCameraRigs();
  if (simRobot) simScene.remove(simRobot);
  if (type === 'diffbot') {
    simRobot = _robotUrdfXml ? await _buildUrdfVisuals(_robotUrdfXml) : _makeDiffBotFallback();
    simRobot.userData = { type: 'diffbot', vx: 0, wz: 0, x: 0, y: 0, theta: 0 };
    simScene.add(simRobot);
    _setSimLabel('DiffBot');
    if (cameras.length) _setupCameraRigs(cameras, simRobot, 'diffbot');
  } else if (type === 'arm') {
    _setSimLabel('UR5 Arm (loading meshes…)');
    // Placeholder group so scene is never empty
    simRobot = new THREE.Group();
    simRobot.userData = { type: 'arm' };
    simScene.add(simRobot);
    (_robotUrdfXml ? _buildUrdfVisuals(_robotUrdfXml) : Promise.resolve(make6DOFFallback()))
      .then(g => {
        if (simRobot.userData.type !== 'arm') return;
        simScene.remove(simRobot);
        simRobot = g;
        simRobot.userData = { type: 'arm' };
        simScene.add(simRobot);
        _setSimLabel('UR5 Arm');
        // Upright home pose: shoulder_lift and wrist_1 at -π/2 so the arm looks
        // correct on load. Overridden the moment any node publishes /joint_states.
        updateArmJoints([0, -Math.PI / 2, 0, -Math.PI / 2, 0, 0]);
        // Broadcast static TF (fixed joints) once on load
        _publishStaticTF();
        // Aim camera at mid-arm height
        orbitCam.ty = 0.5;
        if (cameras.length) _setupCameraRigs(cameras, simRobot, 'arm');
      }).catch(() => {
        simScene.remove(simRobot);
        simRobot = make6DOFFallback();
        simRobot.userData = { type: 'arm' };
        simScene.add(simRobot);
        if (cameras.length) _setupCameraRigs(cameras, simRobot, 'arm');
      });
  }
}

// ── Robot builders ────────────────────────────────────────────────────────────
// Minimal placeholder shown before any URDF is received (or if URDF is unavailable).
function _makeDiffBotFallback() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.1, 0.3),
    new THREE.MeshLambertMaterial({ color: 0x22c55e })
  );
  body.position.y = 0.115;
  g.add(body);
  const lidar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.05, 16),
    new THREE.MeshLambertMaterial({ color: 0x58a6ff })
  );
  lidar.position.set(0, 0.22, 0);
  g.add(lidar);
  return g;
}

// Fallback stick arm (shown while GLB loads or on load failure)
function make6DOFFallback() {
  const g    = new THREE.Group();
  const mat  = new THREE.MeshLambertMaterial({ color: 0x58a6ff });
  const jMat = new THREE.MeshLambertMaterial({ color: 0xe3b341 });
  const links = [
    { len: 0.30 }, { len: 0.25 }, { len: 0.20 },
    { len: 0.15 }, { len: 0.10 }, { len: 0.08 },
  ];
  let parent = g, y = 0;
  g._joints = [];
  links.forEach((l) => {
    const joint = new THREE.Group();
    joint.position.y = y;
    parent.add(joint);
    g._joints.push({ group: joint, axis: 'y' });
    joint.add(new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), jMat));
    const link = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, l.len, 8), mat);
    link.position.y = l.len / 2;
    link.castShadow = true;
    joint.add(link);
    parent = joint;
    y = l.len;
  });
  return g;
}

// Resolve package:// URLs used in URDF mesh filenames.
// Description packages live under their robot container (diffbot/ or ur5/).
function _resolveRosUrl(url) {
  const base = window.location.pathname.split('/').slice(0, -1).join('/');
  const PKG_CONTAINERS = {
    'diffbot_description':        'diffbot',
    'diffbot_camera_description': 'diffbot',
    'ur5_description':            'ur5',
    'ur5_camera_description':     'ur5',
  };
  return url.replace(/^package:\/\/([^/]+)\/(.*)$/, (_, pkg, rest) => {
    const container = PKG_CONTAINERS[pkg] || '';
    const srcPath = container ? `${container}/${pkg}/${rest}` : `${pkg}/${rest}`;
    return `${base}/rospad-workspace/src/${srcPath}`;
  });
}

// Custom minimal GLB parser — all objects built with global THREE so
// matrixWorld propagation works correctly inside the renderer's scene graph.
async function _loadGLBMesh(url) {
  const resolved = url.startsWith('package://') ? _resolveRosUrl(url) : url;
  const buf = await fetch(resolved).then(r => r.arrayBuffer());
  const dv  = new DataView(buf);
  // GLB layout: 12-byte header | 8-byte JSON chunk header | JSON bytes | 8-byte BIN chunk header | binary
  const jLen    = dv.getUint32(12, true);
  const j       = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jLen)));
  const binStart = 28 + jLen;  // offset of binary chunk data inside ArrayBuffer

  const accs  = j.accessors;
  const bvs   = j.bufferViews;
  const group = new THREE.Group();
  const mat   = new THREE.MeshLambertMaterial({ color: 0xb0b4b8, side: THREE.DoubleSide });

  const readAcc = (idx, TypedArr, elStride) => {
    const acc = accs[idx];
    const bv  = bvs[acc.bufferView];
    const off = binStart + (bv.byteOffset || 0) + (acc.byteOffset || 0);
    // slice() copies to a fresh ArrayBuffer, guaranteeing alignment
    return new TypedArr(buf.slice(off, off + acc.count * elStride));
  };

  for (const gm of j.meshes) {
    for (const prim of gm.primitives) {
      const geo = new THREE.BufferGeometry();

      geo.setAttribute('position',
        new THREE.BufferAttribute(readAcc(prim.attributes.POSITION, Float32Array, 12), 3));

      if (prim.attributes.NORMAL !== undefined) {
        geo.setAttribute('normal',
          new THREE.BufferAttribute(readAcc(prim.attributes.NORMAL, Float32Array, 12), 3));
      } else {
        geo.computeVertexNormals();
      }

      if (prim.indices !== undefined) {
        const compType = accs[prim.indices].componentType;
        const T  = compType === 5125 ? Uint32Array : Uint16Array;  // UNSIGNED_INT vs SHORT
        const sz = compType === 5125 ? 4 : 2;
        geo.setIndex(new THREE.BufferAttribute(readAcc(prim.indices, T, sz), 1));
      }

      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.castShadow   = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  return group;
}

// Publish /tf_static for all fixed joints parsed from the loaded arm URDF
function _publishStaticTF() {
  function qFromRPY(r, p, y) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, y, 'ZYX'));
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  }
  const transforms = _armStaticTF.map(j => ({
    header: { stamp: { sec: 0, nanosec: 0 }, frame_id: j.parent },
    child_frame_id: j.child,
    transform: {
      translation: { x: j.xyz[0], y: j.xyz[1], z: j.xyz[2] },
      rotation: qFromRPY(j.rpy[0], j.rpy[1], j.rpy[2])
    }
  }));
  rosBus.publish('/tf_static', 'tf2_msgs/TFMessage', { transforms });
}

// Publish /tf for revolute joints given their current angle array
function _publishDynamicTF(positions) {
  const stamp = { sec: Math.floor(Date.now() / 1000), nanosec: (Date.now() % 1000) * 1e6 | 0 };
  const transforms = _armJointData.map((j, i) => {
    const angle = positions[i] ?? 0;
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(j.axis[0], j.axis[1], j.axis[2]), angle
    );
    q.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(j.rpy[0], j.rpy[1], j.rpy[2], 'ZYX')));
    return {
      header: { stamp, frame_id: j.parent },
      child_frame_id: j.child,
      transform: {
        translation: { x: j.xyz[0], y: j.xyz[1], z: j.xyz[2] },
        rotation: { x: q.x, y: q.y, z: q.z, w: q.w }
      }
    };
  });
  rosBus.publish('/tf', 'tf2_msgs/TFMessage', { transforms });
}

function updateArmJoints(positions) {
  const joints = simRobot?._armJoints;
  if (!joints) return;
  joints.forEach((jg, i) => {
    if (positions[i] === undefined) return;
    // Match URDFLoader's setJointValue: total = origQuat × axisRotation(angle)
    jg.quaternion.setFromAxisAngle(jg._axis, positions[i]).premultiply(jg._origQuat);
  });
  _publishDynamicTF(positions);
}

// ── Obstacles ─────────────────────────────────────────────────────────────────
const OBS_COLORS = [0xf85149, 0xd29922, 0x8957e5, 0x39c5cf, 0x58a6ff, 0x3fb950];

function addObstacle(shape = 'box') {
  let geo;
  switch (shape) {
    case 'sphere':
      geo = new THREE.SphereGeometry(0.15 + Math.random() * 0.2, 16, 12);
      break;
    case 'cylinder':
      geo = new THREE.CylinderGeometry(
        0.08 + Math.random() * 0.15,
        0.08 + Math.random() * 0.15,
        0.25 + Math.random() * 0.5, 16
      );
      break;
    default:
      geo = new THREE.BoxGeometry(
        0.2 + Math.random() * 0.4,
        0.2 + Math.random() * 0.5,
        0.2 + Math.random() * 0.4
      );
  }
  geo.computeBoundingBox();
  const halfH = (geo.boundingBox.max.y - geo.boundingBox.min.y) / 2;

  const obs = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ color: OBS_COLORS[Math.floor(Math.random() * OBS_COLORS.length)] })
  );
  obs.position.set((Math.random() - 0.5) * 4, halfH, (Math.random() - 0.5) * 4);
  obs.castShadow = true;
  obs.userData.isObstacle = true;
  obs.userData.halfH  = halfH;
  obs.userData.shape  = shape;
  simObstacles.push(obs);
  simScene.add(obs);
  if (_Ammo && physicsWorld) obs.userData.physBody = _makeObsBody(obs);
}

// Detect robot type from URDF XML and load into sim
function _loadRobotFromUrdf(urdfXml) {
  // Heuristic: check for wheel joints (diff-drive) vs serial revolute chain (arm)
  const hasWheels = /wheel/i.test(urdfXml);
  const revolutes = (urdfXml.match(/type=["']revolute["']/g) || []).length;
  const continuous = (urdfXml.match(/type=["']continuous["']/g) || []).length;

  let type;
  if (hasWheels || continuous >= 2) {
    type = 'diffbot';
  } else if (revolutes >= 4) {
    type = 'arm';
  } else {
    type = 'arm';
  }

  // Declare only the topics this robot type actually uses
  if (type === 'diffbot') {
    ['/scan', '/odom', '/cmd_vel'].forEach(t => rosBus.trackPublisher(t, 'sim_bridge'));
    rosBus.trackSubscriber('/cmd_vel', 'sim_bridge');
  } else if (type === 'arm') {
    rosBus.trackSubscriber('/joint_states', 'sim_bridge');
  }

  // Parse any <gazebo><sensor type="camera"> blocks from the URDF
  const cameras = _parseCamerasFromUrdf(urdfXml);

  // Store for reset (loadRobot reuses _robotUrdfXml when rebuilding after resetSim)
  _robotUrdfXml = urdfXml;

  const simCanvas = document.getElementById('sim-canvas');
  if (simCanvas) { simCanvas.style.display = 'block'; resize(); }
  loadRobot(type, cameras);
}

function resetSim() {
  // Clear obstacles only — robot is managed by /robot_description
  selectObs(null);
  simObstacles.forEach(o => {
    simScene.remove(o);
    if (o.userData.physBody && physicsWorld) physicsWorld.removeRigidBody(o.userData.physBody);
  });
  simObstacles.length = 0;
  if (robotBody && _Ammo && _tmpAmmoTransform) {
    _tmpAmmoTransform.setIdentity();
    _tmpAmmoVec.setValue(0, ROBOT_RADIUS, 0);
    _tmpAmmoTransform.setOrigin(_tmpAmmoVec);
    robotBody.setWorldTransform(_tmpAmmoTransform);
    robotBody.getMotionState().setWorldTransform(_tmpAmmoTransform);
  }
  // Reset turtle + trail
  _simTurtleState.x = 0; _simTurtleState.y = 0; _simTurtleState.theta = 0;
  _simTurtleState.vx = 0; _simTurtleState.wz = 0;
  if (_simTurtle) _simTurtle.position.set(0, 0, 0);
  _clearTurtleTrail();
  // If a robot is already loaded, reset it to origin
  if (simRobot) loadRobot(simRobot.userData.type);
}

// ── Animation loop ────────────────────────────────────────────────────────────
let lastSimTime = 0;

function animate(time = 0) {
  requestAnimationFrame(animate);
  const dt = Math.min((time - lastSimTime) / 1000, 0.05);
  lastSimTime = time;

  if (simRunning && simRobot?.userData?.type === 'diffbot') {
    const d = simRobot.userData;

    // Keyboard teleop — publish /cmd_vel at 10 Hz
    if (time - lastTeleopPublish >= 100) {
      let vx = 0, wz = 0;
      if (keysDown['w']) vx += 0.5;
      if (keysDown['s']) vx -= 0.5;
      if (keysDown['a']) wz += 1.0;
      if (keysDown['d']) wz -= 1.0;
      const active = vx !== 0 || wz !== 0;
      if (active || lastTeleopActive) {
        rosBus.publish('/cmd_vel', 'geometry_msgs/Twist', {
          linear:  { x: vx, y: 0, z: 0 },
          angular: { x: 0,  y: 0, z: wz },
        });
        lastTeleopActive = active;
      }
      lastTeleopPublish = time;
    }

    // Integrate heading and position
    d.theta += d.wz * dt;
    d.x     += d.vx * Math.cos(d.theta) * dt;
    d.y     += d.vx * Math.sin(d.theta) * dt;

    // Sphere-vs-AABB depenetration for each obstacle
    // Robot THREE.js world position: x = -d.y, z = d.x
    for (const obs of simObstacles) {
      const bb = new THREE.Box3().setFromObject(obs);
      const rx = -d.y, rz = d.x;
      const nearX = Math.max(bb.min.x, Math.min(rx, bb.max.x));
      const nearZ = Math.max(bb.min.z, Math.min(rz, bb.max.z));
      const dx = rx - nearX, dz = rz - nearZ;
      const dist2 = dx * dx + dz * dz;
      if (dist2 < ROBOT_RADIUS * ROBOT_RADIUS) {
        const dist = Math.sqrt(dist2) || 1e-6;
        const pen  = ROBOT_RADIUS - dist;
        d.y -= (dx / dist) * pen;  // THREE.js x = -d.y
        d.x += (dz / dist) * pen;  // THREE.js z = d.x
      }
    }

    // Keep ammo.js kinematic body in sync with resolved position
    if (robotBody && _Ammo && _tmpAmmoTransform) {
      _tmpAmmoTransform.setIdentity();
      _tmpAmmoVec.setValue(-d.y, ROBOT_RADIUS, d.x);
      _tmpAmmoTransform.setOrigin(_tmpAmmoVec);
      robotBody.setWorldTransform(_tmpAmmoTransform);
      robotBody.getMotionState().setWorldTransform(_tmpAmmoTransform);
    }

    simRobot.position.set(-d.y, 0, d.x);
    simRobot.rotation.y = -d.theta;

    // Publish odometry
    rosBus.publish('/odom', 'nav_msgs/Odometry', {
      pose:  { position:    { x: d.x, y: d.y, z: 0 },
               orientation: { z: Math.sin(d.theta / 2), w: Math.cos(d.theta / 2) } },
      twist: { linear: { x: d.vx }, angular: { z: d.wz } },
    });
  }

  // Turtle kinematics — runs when turtle is active (WASD or /turtle1/cmd_vel)
  if (_simTurtleState.active && _simTurtle) {
    if (simCanvasFocused && time - lastTeleopPublish >= 100) {
      let tvx = 0, twz = 0;
      if (keysDown['w']) tvx += 1.5;
      if (keysDown['s']) tvx -= 1.5;
      if (keysDown['a']) twz += 1.5;
      if (keysDown['d']) twz -= 1.5;
      if (tvx !== 0 || twz !== 0) {
        rosBus.publish('/turtle1/cmd_vel', 'geometry_msgs/Twist', {
          linear: { x: tvx, y: 0, z: 0 }, angular: { x: 0, y: 0, z: twz },
        });
      }
    }
    _simTurtleState.theta += _simTurtleState.wz * dt;
    _simTurtleState.x     += _simTurtleState.vx * Math.cos(_simTurtleState.theta) * dt;
    _simTurtleState.y     += _simTurtleState.vx * Math.sin(_simTurtleState.theta) * dt;
    _simTurtle.position.set(_simTurtleState.x, 0, _simTurtleState.y);
    _simTurtle.rotation.y = _simTurtleState.theta;
    if (_simTurtleState.vx !== 0 || _simTurtleState.wz !== 0) {
      _addTrailPoint(_simTurtleState.x, _simTurtleState.y);
    }
    rosBus.publish('/turtle1/pose', 'turtlesim/Pose', {
      x: _simTurtleState.x, y: _simTurtleState.y, theta: _simTurtleState.theta,
      linear_velocity: _simTurtleState.vx, angular_velocity: _simTurtleState.wz,
    });
  }

  updateOrbitCamera();
  updateLidar(time);
  _captureCameraFrames(time);
  if (_selHelper) _selHelper.update();
  simRenderer.render(simScene, simCamera);
}

function resize() {
  const canvas = document.getElementById('sim-canvas');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  simRenderer.setSize(w, h, false);
  if (simCamera) {
    simCamera.aspect = w / h;
    simCamera.updateProjectionMatrix();
  }
}

// ── LiDAR simulation ──────────────────────────────────────────────────────────
function initLidar() {
  const geo       = new THREE.BufferGeometry();
  const positions = new Float32Array(LIDAR_N * 2 * 3);
  const colors    = new Float32Array(LIDAR_N * 2 * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

  lidarLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false,
  }));
  lidarLines.frustumCulled = false;
  simScene.add(lidarLines);
}

function updateLidar(time) {
  if (!lidarLines || !simRunning || !simRobot || simRobot.userData.type !== 'diffbot') {
    if (lidarLines) lidarLines.visible = false;
    return;
  }
  if (time - lastLidarUpdate < 100) return; // 10 Hz
  lastLidarUpdate = time;
  lidarLines.visible = _activeViz.has('/scan');

  const raycaster = new THREE.Raycaster();
  raycaster.near = 0.05;
  raycaster.far  = LIDAR_RANGE;

  const ox = simRobot.position.x, oy = 0.22, oz = simRobot.position.z;
  const origin = new THREE.Vector3(ox, oy, oz);

  const pos    = lidarLines.geometry.attributes.position.array;
  const col    = lidarLines.geometry.attributes.color.array;
  const ranges = [];

  for (let i = 0; i < LIDAR_N; i++) {
    const angle = simRobot.rotation.y + (i / LIDAR_N) * Math.PI * 2;
    const dir   = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    raycaster.set(origin, dir);

    const hits  = raycaster.intersectObjects(simObstacles, true);
    const range = hits.length > 0 ? Math.min(hits[0].distance, LIDAR_RANGE) : LIDAR_RANGE;
    const hit   = hits.length > 0;
    ranges.push(range);

    const ex = ox + Math.sin(angle) * range;
    const ez = oz + Math.cos(angle) * range;
    const pi = i * 6;

    // Ray origin — dim
    pos[pi] = ox;  pos[pi+1] = oy;  pos[pi+2] = oz;
    col[pi] = 0.04; col[pi+1] = 0.15; col[pi+2] = 0.04;
    // Ray end — red/orange on hit, dim green on clear space
    pos[pi+3] = ex; pos[pi+4] = oy; pos[pi+5] = ez;
    if (hit) {
      const t = range / LIDAR_RANGE;
      col[pi+3] = 1.0; col[pi+4] = t * 0.5; col[pi+5] = 0.0;
    } else {
      col[pi+3] = 0.04; col[pi+4] = 0.25; col[pi+5] = 0.12;
    }
  }

  lidarLines.geometry.attributes.position.needsUpdate = true;
  lidarLines.geometry.attributes.color.needsUpdate    = true;

  rosBus.publish('/scan', 'sensor_msgs/LaserScan', {
    header:          { stamp: { sec: Math.floor(Date.now() / 1000), nanosec: 0 }, frame_id: 'laser' },
    angle_min:       0,
    angle_max:       Math.PI * 2 - (Math.PI * 2) / LIDAR_N,
    angle_increment: (Math.PI * 2) / LIDAR_N,
    time_increment:  0, scan_time: 0.1,
    range_min:       0.1, range_max: LIDAR_RANGE,
    ranges,
    intensities:     ranges.map(r => r < LIDAR_RANGE ? Math.round((1 - r / LIDAR_RANGE) * 255) : 0),
  });
}

// ── Topic visualizer ──────────────────────────────────────────────────────────

const VIZ_TYPES = {
  'sensor_msgs/LaserScan':          { label: 'LaserScan',   color: '#f0ab2b', autoEnable: true  },
  'sensor_msgs/Image':              { label: 'Image',       color: '#58a6ff', autoEnable: false },
  'sensor_msgs/PointCloud2':        { label: 'PointCloud2', color: '#a371f7', autoEnable: false },
  'nav_msgs/Odometry':              { label: 'Odometry',    color: '#3fb950', autoEnable: false },
  'geometry_msgs/PoseStamped':      { label: 'Pose',        color: '#f85149', autoEnable: false },
  'geometry_msgs/TransformStamped': { label: 'TF',          color: '#d29922', autoEnable: false },
  'turtlesim/Pose':                 { label: 'TurtlePose',  color: '#56d364', autoEnable: false },
};

const _seenVizTopics = new Map();  // topic → msgType
const _vizLastSeen   = new Map();  // topic → performance.now()
const _activeViz     = new Map();  // topic → { subId?, objects:[], imgEl? }

function _initVizMonitor() {
  rosBus.onPublish((topic, msgType) => {
    if (!VIZ_TYPES[msgType]) return;
    _vizLastSeen.set(topic, performance.now());
    if (_seenVizTopics.has(topic)) return;
    _seenVizTopics.set(topic, msgType);
    if (VIZ_TYPES[msgType].autoEnable) _enableViz(topic, msgType);
    _renderVizList();
  });

  setInterval(() => {
    const now = performance.now();
    let changed = false;
    for (const [topic, ts] of _vizLastSeen) {
      if (now - ts > 5000) {
        _disableViz(topic);
        _seenVizTopics.delete(topic);
        _vizLastSeen.delete(topic);
        changed = true;
      }
    }
    if (changed) _renderVizList();
  }, 2000);
}

function _renderVizList() {
  const el = document.getElementById('viz-items');
  if (!el) return;
  if (_seenVizTopics.size === 0) {
    el.innerHTML = '<div class="viz-empty">No visualizable topics — start simulation or launch a package</div>';
    return;
  }
  el.innerHTML = [..._seenVizTopics.entries()].map(([topic, msgType]) => {
    const def     = VIZ_TYPES[msgType];
    const checked = _activeViz.has(topic) ? 'checked' : '';
    return `<div class="viz-row"><label>` +
      `<input type="checkbox" class="viz-check" ${checked} onchange="toggleViz('${topic}','${msgType}',this.checked)">` +
      `<span class="viz-dot" style="background:${def.color}"></span>` +
      `<span class="viz-topic">${topic}</span>` +
      `<span class="viz-type">${def.label}</span>` +
      `</label></div>`;
  }).join('');
}

function toggleViz(topic, msgType, enabled) {
  if (enabled) _enableViz(topic, msgType);
  else         _disableViz(topic);
}
window.toggleViz = toggleViz;

function _enableViz(topic, msgType) {
  if (_activeViz.has(topic)) return;
  switch (msgType) {
    case 'sensor_msgs/LaserScan':
      _activeViz.set(topic, { objects: [] });
      if (lidarLines) lidarLines.visible = true;
      break;
    case 'nav_msgs/Odometry':
      _enableOdomViz(topic);
      break;
    case 'geometry_msgs/PoseStamped':
      _enablePoseViz(topic);
      break;
    case 'sensor_msgs/Image':
      _enableImageViz(topic);
      break;
    default:
      _activeViz.set(topic, { objects: [] });
  }
  _renderVizList();
}

function _disableViz(topic) {
  const entry = _activeViz.get(topic);
  if (!entry) return;
  (entry.objects || []).forEach(o => simScene?.remove(o));
  if (entry.subId !== undefined) rosBus.unsubscribe(topic, entry.subId);
  if (entry.imgEl) entry.imgEl.remove();
  _activeViz.delete(topic);
  if (_seenVizTopics.get(topic) === 'sensor_msgs/LaserScan' && lidarLines) {
    lidarLines.visible = false;
  }
  _renderVizList();
}

function _enableOdomViz(topic) {
  if (!simScene) return;
  const maxPts = 1000;
  const pos    = new Float32Array(maxPts * 3);
  const geo    = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setDrawRange(0, 0);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x3fb950 }));
  line.frustumCulled = false;
  simScene.add(line);

  let count = 0;
  const subId = rosBus.subscribe(topic, 'nav_msgs/Odometry', (data) => {
    const p = data?.pose?.position || {};
    if (count < maxPts) {
      const i = count++ * 3;
      pos[i] = p.x || 0; pos[i+1] = 0.02; pos[i+2] = p.y || 0;
      geo.setDrawRange(0, count);
      geo.attributes.position.needsUpdate = true;
    }
  });
  _activeViz.set(topic, { objects: [line], subId });
}

function _enablePoseViz(topic) {
  if (!simScene) return;
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0.1, 0), 0.4, 0xf85149
  );
  simScene.add(arrow);
  const subId = rosBus.subscribe(topic, 'geometry_msgs/PoseStamped', (data) => {
    const p = data?.pose?.position  || {};
    const q = data?.pose?.orientation || {};
    arrow.position.set(p.x || 0, (p.z || 0) + 0.1, p.y || 0);
    const ang = 2 * Math.atan2(q.z || 0, q.w !== undefined ? q.w : 1);
    arrow.setDirection(new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)).normalize());
  });
  _activeViz.set(topic, { objects: [arrow], subId });
}

function _enableImageViz(topic) {
  const panel = document.getElementById('sim-viewport');
  if (!panel) return;
  const wrap = document.createElement('div');
  wrap.className = 'img-viz-overlay';
  wrap.innerHTML = `
    <div style="font-size:10px;color:#58a6ff;padding:2px 4px;background:rgba(0,0,0,.6)">
      ${topic}
    </div>
    <canvas style="display:block;max-width:160px;image-rendering:pixelated"></canvas>`;
  panel.appendChild(wrap);
  const cv  = wrap.querySelector('canvas');
  const ctx = cv.getContext('2d');
  cv.width = 160; cv.height = 120;
  ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, 160, 120);

  const subId = rosBus.subscribe(topic, 'sensor_msgs/Image', (data) => {
    const w = data.width || 320, h = data.height || 240;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const raw = data.data;
    if (!raw || raw.length < w * h * 3) return;
    const imgData = ctx.createImageData(w, h);
    const rgba = imgData.data;
    for (let i = 0; i < w * h; i++) {
      rgba[i*4]   = raw[i*3];
      rgba[i*4+1] = raw[i*3+1];
      rgba[i*4+2] = raw[i*3+2];
      rgba[i*4+3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
  });
  _activeViz.set(topic, { objects: [], subId, imgEl: wrap });
}
