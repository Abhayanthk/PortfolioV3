import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Loader, ScrollControls, useAnimations, useGLTF, useScroll } from '@react-three/drei'
import * as THREE from 'three'

/* ============================================================================
 *  KATANA HERO — FEEL TEST
 *  Every number that controls the FEEL lives in this block. Tune freely.
 *
 *  Structure (from the GLB, see diagnose.mjs):
 *    SWORD    = node "katana blade.001"  (blade + guard + handle + pommel)
 *    SCABBARD = node "katana cover.002"  (the two cover meshes)
 *  Both are independent sibling nodes — we animate those parents directly.
 *
 *  The katana lies flat in the XY plane and is DIAGONAL. The draw axis is the
 *  blade's own long axis (handle→tip), computed from geometry at load — never a
 *  world axis. Distances below are in the model's own units (~1.0 = blade-ish).
 * ========================================================================== */

const MODEL_URL = '/katana.glb'
// Logical name prefixes. NB: GLTFLoader sanitizes names (spaces→_, dots dropped),
// e.g. "katana blade.001" → "katana_blade001". We match by normalized name below.
const SWORD_PREFIX = 'katana blade'
const SCABBARD_PREFIX = 'katana cover'
// The GLB's built-in unsheathe clip (animates the blade node). Scrubbed by scroll.
const CLIP_NAME = 'katana blade.001|Action.013'

/* ---- Framing (tight & cinematic — katana fills most of the frame) --------- */
const FOV = 32 // degrees. Long lens = flatter, more filmic.
const TARGET_FILL = 0.82 // model fills ~82% of the smaller viewport axis at hero
const HERO_OFF = new THREE.Vector3(0.0, 0.05, 5.2) // camera offset from focus — close
const DISPLAY_OFF = new THREE.Vector3(0.0, -0.1, 7.4) // pulled back to reveal the parallel layout
const DRIFT_DIR = new THREE.Vector3(1.25, 0.0, 0.0) // lateral camera drift across the blade (hold)
// Hero zoom: at scroll 0 the camera is pushed IN (×HERO_ZOOM of the offset) so the
// sheathed katana cuts diagonally across the frame, then eases back to the normal
// framing as the unsheathe begins. < 1 = closer/bigger.
const HERO_ZOOM = 0.66
const ZOOM = { in: 0.0, out: 0.13 } // scroll range over which the zoom releases to normal

/* ---- Scroll breakpoints (progress 0 → 1) ---------------------------------- */
//  0.00–0.20  unsheathe (built-in clip)  |  0.20–0.32  rotate toward horizontal
//  0.32–0.48  scabbard glides parallel   |  0.48–0.54  hold + camera drift
//  0.54–0.62  scabbard returns           |  0.62–0.80  resheathe (clip reversed)
//  0.80–1.00  camera returns to hero
const CLIP = { in: 0.0, out: 0.2, backIn: 0.62, backOut: 0.8 } // scroll→clip-time ramp
const POSE = { in: 0.2, out: 0.32, backIn: 0.8, backOut: 1.0 } // diagonal→horizontal ramp
const PART = { in: 0.32, out: 0.48, backIn: 0.54, backOut: 0.62 } // scabbard parallel ramp (back before resheathe)
const FRAME = { in: 0.2, out: 0.48, backIn: 0.8, backOut: 1.0 } // hero→display camera ramp
const DRIFT = { a: 0.46, b: 0.5, c: 0.52, d: 0.56 } // hold drift bump

/* ---- Object motion -------------------------------------------------------- */
const SCAB_DROP = 0.32 // scabbard offset perpendicular to the blade (fraction of blade length)

/* ---- Clip plane: hides the blade portion still inside the sheath ----------- */
// Active during the unsheathe + resheathe (when the blade overlaps the bore); OFF
// during the display, where the blade is fully drawn and must be entirely visible.
const CLIP_DRAW_CLEAR = 0.3 // p ≤ this: clip ON (covers the unsheathe, blade clears by 0.2)
const CLIP_RESHEATHE = 0.62 // p ≥ this: clip ON again (scabbard back home, blade slides in)

/* ---- Damping — the SINGLE source of smoothing ----------------------------- */
// One progress value `p` is damped toward the raw scroll each frame; EVERYTHING
// (clip time, blade, scabbard, camera) is a pure function of that same `p`, so all
// parts stay in lockstep at any scroll speed. Higher = snappier, lower = floatier.
const PROGRESS_DAMP = 3.0

/* ============================================================================
 *  Helpers
 * ========================================================================== */

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

// Hermite smoothstep — eased 0→1 ramp.
function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

// 0→1→0 plateau: up across [a,b], hold, down across [c,d].
const plateau = (p: number, a: number, b: number, c: number, d: number) =>
  clamp01(smoothstep(a, b, p) - smoothstep(c, d, p))

const damp = THREE.MathUtils.damp

type Axes = {
  sword: THREE.Object3D // blade node — driven by the built-in clip (we never set it directly)
  scabbard: THREE.Object3D
  scab0: THREE.Vector3 // authored (sheathed) scabbard position, in node-parent (root) space
  scabQuat0: THREE.Quaternion // authored scabbard orientation
  perpAxis: THREE.Vector3 // unit, perpendicular — drops scabbard below blade in the display
  displayQuatRest: THREE.Quaternion // lays the SHEATHED blade horizontal; composed with the
  //                                   clip's end rotation at runtime to lay the DRAWN blade flat
  len: number // blade length in NODE/root space — the unit for the scabbard drop
  center: THREE.Vector3 // model center in SCENE space — for framing
  maxDim: number // model size in SCENE space — for framing
  mouthLocal: THREE.Vector3 // mouth point in the scabbard node's LOCAL frame (clip anchor)
  drawAxisLocal: THREE.Vector3 // bore tangent at the mouth, in the scabbard's LOCAL frame
}

/* ----------------------------------------------------------------------------
 *  Derive the draw axis + display orientation straight from the mesh geometry.
 *  Robust to the model's diagonal pose; uses no world-axis assumptions.
 * -------------------------------------------------------------------------- */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const hasMeshDescendant = (o: THREE.Object3D) => {
  let has = false
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) has = true })
  return has
}

// Resolve a movable group by logical prefix, robust to loader name-sanitizing.
// Prefers the real parent container node; falls back to grouping meshes via attach.
function resolveGroup(scene: THREE.Object3D, prefix: string): THREE.Object3D {
  const np = norm(prefix)

  // 1) Existing container node whose (normalized) name matches and holds meshes.
  let container: THREE.Object3D | undefined
  scene.traverse((o) => {
    if (container || o === scene || (o as THREE.Mesh).isMesh) return
    if (norm(o.name).startsWith(np) && hasMeshDescendant(o)) container = o
  })
  if (container) return container

  // 2) Fallback: group matching meshes into a fresh node (attach keeps world xform).
  const tag = `${np}__group`
  const existing = scene.getObjectByName(tag)
  if (existing) return existing
  const group = new THREE.Group()
  group.name = tag
  const meshes: THREE.Object3D[] = []
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && norm(o.name).startsWith(np)) meshes.push(o)
  })
  scene.add(group)
  meshes.forEach((m) => group.attach(m))
  return group
}

function deriveAxes(scene: THREE.Object3D): Axes {
  const sword = resolveGroup(scene, SWORD_PREFIX)
  const scabbard = resolveGroup(scene, SCABBARD_PREFIX)

  scene.updateMatrixWorld(true)
  const root = (scene.getObjectByName('RootNode') ?? scene) as THREE.Object3D
  const rootInv = root.matrixWorld.clone().invert()

  // Walk every vertex of `node` in ROOT-local space (the space the node's own
  // .position lives in), calling cb. Cancels our Canvas/fit/pose wrappers.
  const v = new THREE.Vector3()
  const eachVertex = (node: THREE.Object3D, cb: (p: THREE.Vector3) => void) => {
    node.traverse((o) => {
      const pos = (o as THREE.Mesh).geometry?.attributes?.position as THREE.BufferAttribute | undefined
      if (!pos) return
      const m = o.matrixWorld.clone().premultiply(rootInv) // mesh-local → root-local
      for (let i = 0; i < pos.count; i++) cb(v.fromBufferAttribute(pos, i).applyMatrix4(m))
    })
  }

  // Approximate farthest-pair over a node (2 passes): the endpoints of its long axis.
  const farthestPair = (node: THREE.Object3D) => {
    const seed = new THREE.Vector3()
    let got = false
    eachVertex(node, (p) => { if (!got) { seed.copy(p); got = true } })
    const P = new THREE.Vector3()
    let best = -1
    eachVertex(node, (p) => { const d = p.distanceToSquared(seed); if (d > best) { best = d; P.copy(p) } })
    const Q = new THREE.Vector3()
    best = -1
    eachVertex(node, (p) => { const d = p.distanceToSquared(P); if (d > best) { best = d; Q.copy(p) } })
    return [P, Q] as const
  }

  // SWORD: farthest pair → blade length (the motion unit); AABB → face normal + union.
  const [A, B] = farthestPair(sword)
  const swordLen = A.distanceTo(B)
  const smn = new THREE.Vector3(Infinity, Infinity, Infinity)
  const smx = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  const mn = new THREE.Vector3(Infinity, Infinity, Infinity)
  const mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  eachVertex(sword, (p) => { smn.min(p); smx.max(p); mn.min(p); mx.max(p) })

  // SCABBARD BORE CENTERLINE — the single source of truth for the draw direction.
  // Rough direction from the farthest pair, then REFINE with the two end-cap
  // centroids: averaging each rim cancels off-axis bias, giving the exact centerline
  // (so the blade slides perfectly collinear through the mouth — no kink).
  const [sA, sB] = farthestPair(scabbard)
  const boreRough = sB.clone().sub(sA).normalize()

  let cMin = Infinity, cMax = -Infinity
  eachVertex(scabbard, (p) => {
    const t = p.dot(boreRough)
    if (t < cMin) cMin = t
    if (t > cMax) cMax = t
    mn.min(p); mx.max(p)
  })

  const band = 0.12 * (cMax - cMin) // sample the outer 12% at each end as the caps
  const tipCenter = new THREE.Vector3()
  const mouthCenter = new THREE.Vector3()
  let tipN = 0, mouthN = 0
  eachVertex(scabbard, (p) => {
    const t = p.dot(boreRough)
    if (t <= cMin + band) { tipCenter.add(p); tipN++ }
    else if (t >= cMax - band) { mouthCenter.add(p); mouthN++ }
  })
  tipCenter.multiplyScalar(1 / Math.max(1, tipN))
  mouthCenter.multiplyScalar(1 / Math.max(1, mouthN))

  // Exact bore axis from cap centroids. Sign it toward the mouth = the end where the
  // sword's handle protrudes past the scabbard.
  const tA = A.dot(boreRough), tB = B.dot(boreRough)
  const mouthAtHigh = tB - cMax >= cMin - tA // handle pokes out the +boreRough end?
  const drawAxis = mouthCenter.clone().sub(tipCenter).normalize() // tip→mouth (≈ +boreRough)
  if ((drawAxis.dot(boreRough) > 0) !== mouthAtHigh) drawAxis.negate()

  // Mouth point = the mouth cap centroid, dead on the bore centerline.
  const mouth = (mouthAtHigh ? mouthCenter : tipCenter).clone()

  // Blade face normal = the sword's thinnest extent, oriented toward camera (+Z).
  const ex = smx.x - smn.x, ey = smx.y - smn.y, ez = smx.z - smn.z
  const faceNormal = new THREE.Vector3(
    ex <= ey && ex <= ez ? 1 : 0,
    ey <= ex && ey <= ez ? 1 : 0,
    !(ex <= ey && ex <= ez) && !(ey <= ex && ey <= ez) ? 1 : 0
  )
  if (faceNormal.dot(new THREE.Vector3(0, 0, 1)) < 0) faceNormal.negate()

  // Rest blade basis: e1=along blade, e3=face normal. perpAxis (screen-DOWN) drops
  // the scabbard below the blade (rotated into the drawn frame at runtime).
  const e1 = drawAxis.clone()
  const e3 = faceNormal.clone().addScaledVector(e1, -faceNormal.dot(e1)).normalize()
  const e2 = new THREE.Vector3().crossVectors(e3, e1).normalize()
  const perpAxis = new THREE.Vector3().crossVectors(e1, e3).normalize()

  // displayQuatRest lays the SHEATHED blade horizontal (flat to camera). At runtime
  // we compose it with the clip's end rotation so the DRAWN blade ends up horizontal.
  const basis = new THREE.Matrix4().makeBasis(e1, e2, e3).transpose()
  const displayQuatRest = new THREE.Quaternion().setFromRotationMatrix(basis)

  // The mesh sits under an ancestor scale (~0.01 from FBX import). Motion uses
  // root-space distances (len), but FRAMING needs the model's true SCENE-space
  // size. Map the root-space AABB into scene space to measure it correctly.
  const rootToScene = scene.matrixWorld.clone().invert().multiply(root.matrixWorld)
  const smn2 = new THREE.Vector3(Infinity, Infinity, Infinity)
  const smx2 = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  const c = new THREE.Vector3()
  for (const X of [mn.x, mx.x]) for (const Y of [mn.y, mx.y]) for (const Z of [mn.z, mx.z]) {
    c.set(X, Y, Z).applyMatrix4(rootToScene)
    smn2.min(c); smx2.max(c)
  }

  // Capture the AUTHORED scabbard rest pose ONCE and stash it on the node, so
  // re-deriving (StrictMode / HMR) after it has animated can never drift the rest.
  // (The blade's rest comes from the clip at time 0 — we never capture it here.)
  if (!scabbard.userData.rest) {
    scabbard.userData.rest = { p: scabbard.position.clone(), q: scabbard.quaternion.clone() }
  }
  const scabRest = scabbard.userData.rest as { p: THREE.Vector3; q: THREE.Quaternion }

  // Express the mouth point + bore tangent in the scabbard node's LOCAL frame, so the
  // clip plane follows the scabbard's full transform (translation + rotation).
  const scabRestInv = new THREE.Matrix4().compose(scabRest.p, scabRest.q, scabbard.scale).invert()
  const mouthLocal = mouth.clone().applyMatrix4(scabRestInv)
  const drawAxisLocal = drawAxis.clone().transformDirection(scabRestInv).normalize()

  return {
    sword,
    scabbard,
    scab0: scabRest.p.clone(),
    scabQuat0: scabRest.q.clone(),
    perpAxis,
    displayQuatRest,
    len: swordLen,
    center: smn2.clone().add(smx2).multiplyScalar(0.5),
    maxDim: Math.max(smx2.x - smn2.x, smx2.y - smn2.y, smx2.z - smn2.z) || swordLen,
    mouthLocal,
    drawAxisLocal,
  }
}

/* ============================================================================
 *  Katana — loads, derives axes, fits to frame, drives the draw + rotation
 * ========================================================================== */

const HERO_QUAT = new THREE.Quaternion() // identity = the authored diagonal hero pose

// Data extracted from the built-in clip once it's loaded (sampled at its end pose).
type ClipData = {
  mixer: THREE.AnimationMixer
  action: THREE.AnimationAction
  duration: number
  displayQuat: THREE.Quaternion // lays the CLIP-drawn blade horizontal
  scabPos: THREE.Vector3 // scabbard target (concentric under the drawn blade + drop)
  scabQuat: THREE.Quaternion
}

function Katana({ axesRef, progressRef }: DriveProps) {
  const { scene, animations } = useGLTF(MODEL_URL)
  const { actions, mixer } = useAnimations(animations, scene)
  const { size, gl } = useThree()

  const poseRef = useRef<THREE.Group>(null!)
  const fitRef = useRef<THREE.Group>(null!)

  const axes = useMemo(() => deriveAxes(scene), [scene])
  axesRef.current = axes

  // Clip plane: starts "open" (constant huge ⇒ nothing clipped) until driven each frame.
  const clipPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e9), [])

  // Built-in clip, sampled for its end pose + the derived display/scabbard targets.
  const clipRef = useRef<ClipData | null>(null)

  // Center + scale to fill the frame. Recomputes on resize.
  useLayoutEffect(() => {
    const dist = HERO_OFF.length()
    const visH = 2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * dist
    const visW = visH * (size.width / size.height)
    const fit = (TARGET_FILL * Math.min(visH, visW)) / axes.maxDim
    fitRef.current.scale.setScalar(fit)
    fitRef.current.position.copy(axes.center).multiplyScalar(-fit)
  }, [axes, size.width, size.height])

  // Enable local clipping and bind the plane ONLY to the sword's materials
  // (cloned so the scabbard, which may share a material, is never clipped).
  useLayoutEffect(() => {
    gl.localClippingEnabled = true
    axes.sword.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const bind = (m: THREE.Material) => {
        const c = m.clone()
        c.clippingPlanes = [clipPlane]
        c.clipShadows = true
        return c
      }
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(bind)
        : bind(mesh.material)
    })
  }, [axes, gl, clipPlane])

  // Set up the built-in unsheathe clip: pause it (we scrub by scroll), and SAMPLE its
  // end pose so the parallel layout + display orientation hand off with no jump.
  useLayoutEffect(() => {
    const action = actions[CLIP_NAME] ?? Object.values(actions)[0]
    if (!action) return
    action.play()
    action.paused = true

    const sword = axes.sword
    const duration = action.getClip().duration

    // Sample the blade's authored sheathed (t=0) and fully-drawn (t=end) poses.
    action.time = 0; mixer.update(0)
    const pos0 = sword.position.clone()
    const quat0 = sword.quaternion.clone()
    action.time = duration; mixer.update(0)
    const posEnd = sword.position.clone()
    const quatEnd = sword.quaternion.clone()
    action.time = 0; mixer.update(0) // leave it sheathed

    // deltaQuat = the rigid rotation the clip applies to the blade (root space).
    const deltaQuat = quatEnd.clone().multiply(quat0.clone().invert())

    // Display orientation: compose the rest-display with the clip rotation so the
    // DRAWN blade ends up horizontal (poseRef·deltaQuat must equal displayQuatRest).
    const displayQuat = axes.displayQuatRest.clone().multiply(deltaQuat.clone().invert())

    // Scabbard parallel target = apply the blade's rigid draw motion to the scabbard
    // (g(x) = posEnd + deltaQuat·(x − pos0)) so it sits concentric UNDER the drawn
    // blade, then add a perpendicular drop. Built straight from the clip end ⇒ no jump.
    const scabPos = axes.scab0.clone().sub(pos0).applyQuaternion(deltaQuat).add(posEnd)
    const dropDir = axes.perpAxis.clone().applyQuaternion(deltaQuat)
    scabPos.addScaledVector(dropDir, SCAB_DROP * axes.len)
    const scabQuat = deltaQuat.clone().multiply(axes.scabQuat0)

    clipRef.current = { mixer, action, duration, displayQuat, scabPos, scabQuat }
  }, [actions, mixer, axes])

  const mouthWorld = useMemo(() => new THREE.Vector3(), [])
  const axisWorld = useMemo(() => new THREE.Vector3(), [])

  useFrame(() => {
    const cd = clipRef.current
    if (!cd) return
    const p = progressRef.current // the ONE smoothed progress — no per-element damping
    const { scabbard, scab0, scabQuat0, mouthLocal, drawAxisLocal } = axes

    // UNSHEATHE: clip time is a pure function of p. 0→0.2 out, held, 0.62→0.8 in.
    const frac = plateau(p, CLIP.in, CLIP.out, CLIP.backIn, CLIP.backOut)
    cd.action.time = frac * cd.duration
    cd.mixer.update(0) // applies the blade pose for this clip time

    // SCABBARD: glide rest → parallel target (under the drawn blade + drop) by part(p).
    const part = plateau(p, PART.in, PART.out, PART.backIn, PART.backOut)
    scabbard.position.lerpVectors(scab0, cd.scabPos, part)
    scabbard.quaternion.slerpQuaternions(scabQuat0, cd.scabQuat, part)

    // POSE: diagonal hero → horizontal display, set directly from poseAmt(p).
    const poseAmt = plateau(p, POSE.in, POSE.out, POSE.backIn, POSE.backOut)
    poseRef.current.quaternion.slerpQuaternions(HERO_QUAT, cd.displayQuat, poseAmt)

    // CLIP PLANE: hide the blade still inside the sheath. Sits at the scabbard mouth,
    // normal along the bore tangent; anchored in the scabbard's LOCAL frame so it
    // follows the scabbard. OFF during the fully-drawn display.
    const clipOn = p <= CLIP_DRAW_CLEAR || p >= CLIP_RESHEATHE
    if (clipOn) {
      scabbard.updateWorldMatrix(true, false)
      mouthWorld.copy(mouthLocal).applyMatrix4(scabbard.matrixWorld)
      axisWorld.copy(drawAxisLocal).transformDirection(scabbard.matrixWorld).normalize()
      clipPlane.setFromNormalAndCoplanarPoint(axisWorld, mouthWorld)
    } else {
      clipPlane.constant = 1e9 // open: nothing clipped
    }
  })

  return (
    <group ref={poseRef}>
      <group ref={fitRef}>
        <primitive object={scene} />
      </group>
    </group>
  )
}

/* ============================================================================
 *  Rig — camera follows the live midpoint of the two pieces (auto-framed),
 *  damped like a slow film dolly.
 * ========================================================================== */

function Rig({ axesRef, progressRef }: DriveProps) {
  const { camera } = useThree()

  const focus = useMemo(() => new THREE.Vector3(), [])
  const pa = useMemo(() => new THREE.Vector3(), [])
  const pb = useMemo(() => new THREE.Vector3(), [])
  const off = useMemo(() => new THREE.Vector3(), [])

  useFrame(() => {
    const axes = axesRef.current
    if (!axes) return
    const p = progressRef.current // same smoothed progress as the blade/scabbard

    // Live focus = midpoint of sword & scabbard (both already posed from p this frame),
    // so the camera is a PURE function of p too — set directly, no extra damping.
    axes.sword.getWorldPosition(pa)
    axes.scabbard.getWorldPosition(pb)
    focus.copy(pa).add(pb).multiplyScalar(0.5)

    const frameAmt = plateau(p, FRAME.in, FRAME.out, FRAME.backIn, FRAME.backOut)
    const driftAmt = plateau(p, DRIFT.a, DRIFT.b, DRIFT.c, DRIFT.d)
    // Hero zoom: push IN at scroll 0, ease back to the normal offset as the draw starts.
    const zoom = THREE.MathUtils.lerp(HERO_ZOOM, 1, smoothstep(ZOOM.in, ZOOM.out, p))

    off.copy(HERO_OFF).lerp(DISPLAY_OFF, frameAmt).multiplyScalar(zoom).addScaledVector(DRIFT_DIR, driftAmt)
    camera.position.copy(focus).add(off)
    camera.lookAt(focus)
  })

  return null
}

/* ============================================================================
 *  Scene — lights, environment reflections (UNCHANGED), the katana, the rig
 * ========================================================================== */

type DriveProps = {
  axesRef: React.MutableRefObject<Axes | null>
  progressRef: React.MutableRefObject<number>
}

// Runs FIRST each frame: damps the one shared progress `p` toward the RAW scroll
// (read straight off the DOM container, bypassing ScrollControls' own smoothing).
// Everything else reads progressRef.current, so all parts share a single timeline.
function Progress({ progressRef }: { progressRef: React.MutableRefObject<number> }) {
  const data = useScroll()
  useFrame((_, dt) => {
    const el = data.el
    const raw = el ? el.scrollTop / (el.scrollHeight - el.clientHeight || 1) : 0
    progressRef.current = damp(progressRef.current, clamp01(raw), PROGRESS_DAMP, dt)
  })
  return null
}

function Scene({ axesRef, progressRef }: DriveProps) {
  return (
    <>
      {/* Single smoothed progress — updated before Katana & Rig read it. */}
      <Progress progressRef={progressRef} />

      {/* Key light: hard, raking, defines the blade's edge. */}
      <directionalLight position={[4, 6, 5]} intensity={2.4} color="#fff6ea" />
      {/* Soft fill from the opposite side so shadows aren't crushed. */}
      <directionalLight position={[-6, 2, -3]} intensity={0.5} color="#9fb4ff" />
      {/* Gentle ambient floor. */}
      <hemisphereLight args={['#2a2a30', '#050505', 0.35]} />

      {/* Studio HDRI for real metal reflections — kept OUT of the background. */}
      <Environment preset="studio" background={false} />

      <Katana axesRef={axesRef} progressRef={progressRef} />
      <Rig axesRef={axesRef} progressRef={progressRef} />
    </>
  )
}

/* ============================================================================
 *  App — layered hero: sakura backdrop · transparent 3D canvas · HTML HUD
 * ========================================================================== */

// Soft FEATHERED hexagon mask (blurred polygon ⇒ edges dissolve, not a hard border).
const HEX_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 240'>" +
  "<filter id='f' filterUnits='userSpaceOnUse' x='-50' y='-50' width='300' height='340'>" +
  "<feGaussianBlur stdDeviation='16'/></filter>" +
  "<polygon points='100,26 168,72 168,168 100,214 32,168 32,72' fill='white' filter='url(#f)'/></svg>"
const HEX_MASK: React.CSSProperties = {
  WebkitMaskImage: `url("data:image/svg+xml,${encodeURIComponent(HEX_SVG)}")`,
  maskImage: `url("data:image/svg+xml,${encodeURIComponent(HEX_SVG)}")`,
  WebkitMaskSize: '100% 100%',
  maskSize: '100% 100%',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
}

// Reusable class fragments (kept DRY; all styling is Tailwind utilities).
const MONO = 'font-mono text-[0.7rem] tracking-[0.22em] uppercase text-washi/50'
const PILL = 'font-mono text-[0.64rem] tracking-[0.13em] uppercase px-3 py-1.5 rounded-full border'

export default function App() {
  const axesRef = useRef<Axes | null>(null)
  const progressRef = useRef(0)

  const sakuraRef = useRef<HTMLDivElement>(null)
  const wordmarkRef = useRef<HTMLHeadingElement>(null)
  const hudRef = useRef<HTMLDivElement>(null)
  const pctRef = useRef<HTMLSpanElement>(null)

  // Drive the hero's fade + the live scroll % off the ONE shared progress value.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const p = progressRef.current
      const textFade = 1 - smoothstep(0.02, 0.16, p) // wordmark + HUD fade out
      const treeFade = 1 - smoothstep(0.08, 0.42, p) // sakura lingers a touch longer
      if (hudRef.current) hudRef.current.style.opacity = `${textFade}`
      if (wordmarkRef.current) wordmarkRef.current.style.opacity = `${0.15 * textFade}`
      if (sakuraRef.current) sakuraRef.current.style.opacity = `${0.55 * treeFade}`
      if (pctRef.current) pctRef.current.textContent = `${Math.round(clamp01(p) * 100)}`.padStart(3, '0')
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <>
      {/* Layer 0 — backdrop: sakura tree + anchor wordmark, BEHIND the canvas. */}
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
        <div
          ref={sakuraRef}
          className="absolute left-1/2 top-[46%] -translate-x-1/2 -translate-y-1/2 w-[min(62vh,88vw)] h-[min(93vh,132vw)] bg-[url('/Sakura_tree_bg.png')] bg-contain bg-center bg-no-repeat mix-blend-screen"
          style={{ opacity: 0.55, ...HEX_MASK }}
        />
        <h1
          ref={wordmarkRef}
          className="absolute inset-x-0 -bottom-[1.5vh] text-center font-display font-black leading-[0.8] tracking-[-0.04em] whitespace-nowrap text-washi select-none text-[clamp(3.5rem,17.5vw,17rem)]"
          style={{ opacity: 0.15 }}
        >
          Abhayanth K
        </h1>
      </div>

      {/* Layer 1 — the 3D scene (transparent so the backdrop shows through). */}
      <Canvas
        style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 1 }}
        dpr={[1, 2]}
        gl={{
          alpha: true,
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
        camera={{ position: HERO_OFF.toArray(), fov: FOV, near: 0.1, far: 100 }}
      >
        <Suspense fallback={null}>
          <ScrollControls pages={4}>
            <Scene axesRef={axesRef} progressRef={progressRef} />
          </ScrollControls>
        </Suspense>
      </Canvas>

      {/* Layer 2 — HUD instrument panel, ABOVE the canvas (fades with scroll). */}
      <div ref={hudRef} className="fixed inset-0 z-10 pointer-events-none text-washi">
        {/* top-left — monogram + tagline */}
        <div className="absolute top-6 left-6 md:top-10 md:left-10">
          <div className="text-2xl leading-none text-gold mb-3.5">鍛</div>
          <div className="font-display font-bold leading-[1.06] tracking-[-0.015em] text-[clamp(1rem,1.65vw,1.5rem)]">
            Building software.
            <br />
            Sharpening algorithms.
          </div>
        </div>

        {/* top-center — build tag */}
        <div className={`absolute top-6 md:top-10 left-1/2 -translate-x-1/2 ${MONO}`}>V_1.0.0</div>

        {/* top-right — live scroll % + nav pills */}
        <div className="absolute top-6 right-6 md:top-10 md:right-10 flex flex-col items-end gap-4">
          <div className="font-mono text-[0.72rem] tracking-[0.2em] text-gold">
            <span ref={pctRef}>000</span>%
          </div>
          <nav className="flex gap-1.5">
            <span className={`${PILL} border-gold/50 text-gold`}>About</span>
            <span className={`${PILL} border-washi/15 text-washi/70`}>Projects</span>
            <span className={`${PILL} border-washi/15 text-washi/70`}>CP</span>
            <span className={`${PILL} border-washi/15 text-washi/70`}>Contact</span>
          </nav>
        </div>

        {/* bottom-left — role descriptor */}
        <div className={`absolute bottom-6 left-6 md:bottom-10 md:left-10 ${MONO}`}>
          SDE / COMPETITIVE PROGRAMMER
        </div>

        {/* bottom-right — signature stat (placeholder text — edit me) */}
        <div className={`absolute bottom-6 right-6 md:bottom-10 md:right-10 text-right ${MONO}`}>
          TLE ELIMINATORS · LVL 4 <span className="text-gold ml-1">鍛</span>
        </div>

        {/* bottom-center — scroll cue */}
        <div className="absolute bottom-6 md:bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
          <span className={MONO}>scroll</span>
          <span className="block w-px h-9 bg-linear-to-b from-washi/55 to-transparent" />
        </div>
      </div>

      {/* Loading state (DOM overlay, fades out when the model is ready). */}
      <Loader
        containerStyles={{ background: '#0a0a0a' }}
        barStyles={{ background: '#c8a24a', height: '2px' }}
        dataStyles={{
          color: '#8a8a8a',
          fontSize: '11px',
          letterSpacing: '0.3em',
          fontFamily: 'ui-monospace, monospace',
        }}
        dataInterpolation={(v) => `LOADING ${v.toFixed(0)}%`}
      />
    </>
  )
}

useGLTF.preload(MODEL_URL)
