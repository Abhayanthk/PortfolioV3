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
const HERO_ZOOM = 0.5 // tighter, corner-to-corner hero framing
const ZOOM = { in: 0.0, out: 0.13 } // scroll range over which the zoom releases to normal

// HERO REST FRAMING (scroll 0): roll the katana so the handle/guard sits UPPER-RIGHT
// with the scabbard running off toward the lower-left, then aim the camera there.
// All of this BLENDS OUT to the normal choreography framing by HERO_BLEND.out — the
// unsheathe/parallel/resheathe phases are untouched.
const HERO_BLEND = { in: 0.0, out: 0.16 }
const HERO_ROLL_DEG = -104 // in-plane roll (about the view axis) at rest; handle → upper-right
const HANDLE_SHIFT = 0.45 // world units from the scabbard mouth toward the handle (focal point)
const HERO_AIM_X = 0.85 // push the focal point toward the RIGHT of the frame (world units)
const HERO_AIM_Y = 0.55 // push the focal point UP in the frame (world units)
const WORLD_RIGHT = new THREE.Vector3(1, 0, 0)
const WORLD_UP = new THREE.Vector3(0, 1, 0)

/* ---- Scroll breakpoints (progress 0 → 1) ---------------------------------- */
//  STAGE 1 (ABOUT): forward journey only — the sword draws, then SETTLES slowly into
//  the parallel layout across the whole About-beat sequence, reaching full parallel at
//  SETTLE_END = the moment the last beat lands. The back half (hold/return/resheathe/
//  hero-return) is DROPPED: every back-ramp is pushed past 1 so it never triggers.
//  0.00–0.20  unsheathe (built-in clip, UNCHANGED)
//  0.20–0.32  rotate toward horizontal (UNCHANGED)
//  0.32–0.87  scabbard glides parallel — SLOWED to span the beats (only timing change)
//  0.87–1.00  full parallel held → unpin → normal scroll
const SETTLE_END = 0.87 // full parallel = last About beat lands
const CLIP = { in: 0.0, out: 0.2, backIn: 1.5, backOut: 1.6 } // unsheathe only — never resheathe
const POSE = { in: 0.2, out: 0.32, backIn: 1.5, backOut: 1.6 } // hold horizontal — never rotate back
const PART = { in: 0.32, out: SETTLE_END, backIn: 1.5, backOut: 1.6 } // SLOWED settle, no return
const FRAME = { in: 0.2, out: SETTLE_END, backIn: 1.5, backOut: 1.6 } // camera paced to the slow settle
const DRIFT = { a: 1.5, b: 1.6, c: 1.7, d: 1.8 } // drift bump disabled (was the dropped hold)

/* ---- Object motion -------------------------------------------------------- */
const SCAB_DROP = 0.32 // scabbard offset perpendicular to the blade (fraction of blade length)
const START_DRAWN = 0.12 // resting clip fraction at scroll 0 — opens mid-gesture, slightly drawn

/* ---- Clip plane: hides the blade portion still inside the sheath ----------- */
// Active during the unsheathe + resheathe (when the blade overlaps the bore); OFF
// during the display, where the blade is fully drawn and must be entirely visible.
const CLIP_DRAW_CLEAR = 0.3 // p ≤ this: clip ON (covers the unsheathe, blade clears by 0.2)
const CLIP_RESHEATHE = 1.5 // STAGE 1: resheathe dropped — blade stays drawn, never re-clipped

/* ---- PETAL FIELD (Stage 1: drifting field + scroll-gated presence) ---------
 * A camera-locked instanced field of sakura petals spanning the hero + about.
 * Petals fall / sway / tumble on their OWN continuous clock (time-driven, never
 * spawned by scroll); when one drifts off the bottom it recycles to the top.
 * SCROLL only gates PRESENCE — how many petals show + overall opacity — so the
 * field stays faint over the hero and breathes fuller across the about section.
 * Locked to the camera so it always fills the frame as the camera roams, and so
 * it reads as atmosphere around the sword without ever fighting it.
 */
const PETAL_URL = '/Cherry_Blossom_Petal_3D_Model.glb'
const PETAL_COUNT = 260 // instanced — a few hundred, cheap on the 25-tri model
const PETAL_FIELD_W = 5.6 // local half-width (camera-right) of the spawn box
const PETAL_FIELD_H = 4.2 // local half-height (camera-up); also the recycle band
const PETAL_DEPTH = { near: -4.0, far: -10.5 } // local z, in front of the camera
const PETAL_SIZE = { min: 0.11, max: 0.34 } // world units (closer/larger ↔ depth)
const PETAL_FALL = { min: 0.18, max: 0.5 } // downward drift, units/sec — unhurried
const PETAL_SWAY_AMP = { min: 0.12, max: 0.6 } // lateral sway, world units
const PETAL_SWAY_FREQ = { min: 0.18, max: 0.6 } // sway rate, rad/sec — slow
const PETAL_SPIN = { min: 0.1, max: 0.55 } // tumble rate per axis, rad/sec
const PETAL_MAX_OPACITY = 0.8
// Presence vs. scroll: faint in the hero, only a touch more in the about — kept
// light/unobtrusive there so the beats stay the focus.
const PETAL_PRESENCE = { hero: 0.16, about: 0.3, in: 0.16, out: 0.5 }
const PETAL_RANK_BAND = 0.18 // soft window each petal fades in/out across
const PETAL_RIM = '#d9b25a' // faint gold edge-light, tying petals to the sword's gold

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

// Perlin smootherstep — heavier, more weighted ease than smoothstep (slow in AND
// out). Drives the cinematic blur-to-sharp focus-pull so reveals never pop.
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

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

  const heroRef = useRef<THREE.Group>(null!)
  const poseRef = useRef<THREE.Group>(null!)
  const fitRef = useRef<THREE.Group>(null!)

  const axes = useMemo(() => deriveAxes(scene), [scene])
  axesRef.current = axes

  // Hero rest roll (blends to identity by HERO_BLEND.out — choreography untouched).
  const heroRollQuat = useMemo(
    () => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(HERO_ROLL_DEG)),
    []
  )

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

    // UNSHEATHE: clip time is a pure function of p. Rest (p=0) starts slightly drawn
    // (START_DRAWN); 0→0.2 draws fully out, held, 0.62→0.8 returns to the rest fraction.
    const ramp = plateau(p, CLIP.in, CLIP.out, CLIP.backIn, CLIP.backOut)
    const frac = START_DRAWN + (1 - START_DRAWN) * ramp
    cd.action.time = frac * cd.duration
    cd.mixer.update(0) // applies the blade pose for this clip time

    // SCABBARD: glide rest → parallel target (under the drawn blade + drop) by part(p).
    const part = plateau(p, PART.in, PART.out, PART.backIn, PART.backOut)
    scabbard.position.lerpVectors(scab0, cd.scabPos, part)
    scabbard.quaternion.slerpQuaternions(scabQuat0, cd.scabQuat, part)

    // POSE: diagonal hero → horizontal display, set directly from poseAmt(p).
    const poseAmt = plateau(p, POSE.in, POSE.out, POSE.backIn, POSE.backOut)
    poseRef.current.quaternion.slerpQuaternions(HERO_QUAT, cd.displayQuat, poseAmt)

    // HERO ROLL: at rest the whole assembly is rolled so the handle reads upper-right;
    // eases to identity as you scroll in, handing off to the untouched choreography.
    const heroAmt = 1 - smoothstep(HERO_BLEND.in, HERO_BLEND.out, p)
    heroRef.current.quaternion.slerpQuaternions(HERO_QUAT, heroRollQuat, heroAmt)

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
    <group ref={heroRef}>
      <group ref={poseRef}>
        <group ref={fitRef}>
          <primitive object={scene} />
        </group>
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
  const aim = useMemo(() => new THREE.Vector3(), [])
  const heroAim = useMemo(() => new THREE.Vector3(), [])
  const pa = useMemo(() => new THREE.Vector3(), [])
  const pb = useMemo(() => new THREE.Vector3(), [])
  const drawW = useMemo(() => new THREE.Vector3(), [])
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

    // HERO aim: target the guard/handle (scabbard mouth + a shift toward the handle),
    // pushed toward the UPPER-RIGHT of the frame. Blends out into the normal focus.
    const heroAmt = 1 - smoothstep(HERO_BLEND.in, HERO_BLEND.out, p)
    const sc = axes.scabbard
    sc.updateWorldMatrix(true, false)
    heroAim.copy(axes.mouthLocal).applyMatrix4(sc.matrixWorld)
    drawW.copy(axes.drawAxisLocal).transformDirection(sc.matrixWorld).normalize()
    heroAim.addScaledVector(drawW, HANDLE_SHIFT)
    // Aim BELOW-LEFT of the focal point so it lands UPPER-RIGHT in frame.
    heroAim.addScaledVector(WORLD_RIGHT, -HERO_AIM_X).addScaledVector(WORLD_UP, -HERO_AIM_Y)
    aim.copy(focus).lerp(heroAim, heroAmt)

    const frameAmt = plateau(p, FRAME.in, FRAME.out, FRAME.backIn, FRAME.backOut)
    const driftAmt = plateau(p, DRIFT.a, DRIFT.b, DRIFT.c, DRIFT.d)
    // Hero zoom: push IN at scroll 0, ease back to the normal offset as the draw starts.
    const zoom = THREE.MathUtils.lerp(HERO_ZOOM, 1, smoothstep(ZOOM.in, ZOOM.out, p))

    off.copy(HERO_OFF).lerp(DISPLAY_OFF, frameAmt).multiplyScalar(zoom).addScaledVector(DRIFT_DIR, driftAmt)
    camera.position.copy(aim).add(off)
    camera.lookAt(aim)
  })

  return null
}

/* ============================================================================
 *  PetalField — a camera-locked instanced sakura field across hero + about.
 *  Time-driven motion (fall/sway/tumble + recycle); scroll gates only presence.
 * ========================================================================== */

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

type Petal = {
  x: number // base local-x (sway oscillates around it)
  z: number // local depth in front of camera (perspective → depth + parallax)
  size: number
  fall: number // downward speed (units/sec)
  swayAmp: number
  swayFreq: number
  swayPhase: number
  spin: THREE.Vector3 // per-axis tumble rate
  spinPhase: THREE.Vector3 // per-axis starting angle
  yPhase: number // 0..1 offset into the fall loop so petals don't fall in sync
  rank: number // 0..1 presence threshold — low ranks show first (faint hero)
}

function PetalField({ progressRef }: { progressRef: React.MutableRefObject<number> }) {
  const { camera } = useThree()
  const { scene } = useGLTF(PETAL_URL)
  const meshRef = useRef<THREE.InstancedMesh>(null!)

  // Pull the petal geometry out of the GLB, then center + normalize it to ~1 unit
  // so per-instance `size` maps directly to world size (raw node rotations are
  // orthonormal — they only spin the shape, which the tumble hides anyway).
  const geometry = useMemo(() => {
    let src: THREE.BufferGeometry | undefined
    scene.traverse((o) => {
      if (!src && (o as THREE.Mesh).isMesh) src = (o as THREE.Mesh).geometry
    })
    const g = (src ?? new THREE.PlaneGeometry(1, 1)).clone()
    g.computeBoundingBox()
    const bb = g.boundingBox!
    const c = bb.getCenter(new THREE.Vector3())
    const s = bb.getSize(new THREE.Vector3())
    const maxDim = Math.max(s.x, s.y, s.z) || 1
    g.translate(-c.x, -c.y, -c.z)
    g.scale(1 / maxDim, 1 / maxDim, 1 / maxDim)
    return g
  }, [scene])

  // Soft, double-sided sakura material with a faint gold fresnel rim that ties the
  // petals to the sword's gold. depthWrite off so the translucent field layers
  // gently and the opaque sword still occludes petals behind it.
  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, // white base so per-instance colors read true
      roughness: 0.85,
      metalness: 0,
      transparent: true,
      opacity: PETAL_MAX_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uRim = { value: new THREE.Color(PETAL_RIM) }
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
           totalEmissiveRadiance += uRim * rim * 0.35;`
        )
    }
    return m
  }, [])

  // Per-petal params + colors — generated once. Sakura pink with variation: some
  // paler, some deeper, for depth.
  const petals = useMemo<Petal[]>(() => {
    const arr: Petal[] = []
    for (let i = 0; i < PETAL_COUNT; i++) {
      arr.push({
        x: rand(-PETAL_FIELD_W, PETAL_FIELD_W),
        z: rand(PETAL_DEPTH.far, PETAL_DEPTH.near),
        size: rand(PETAL_SIZE.min, PETAL_SIZE.max),
        fall: rand(PETAL_FALL.min, PETAL_FALL.max),
        swayAmp: rand(PETAL_SWAY_AMP.min, PETAL_SWAY_AMP.max),
        swayFreq: rand(PETAL_SWAY_FREQ.min, PETAL_SWAY_FREQ.max),
        swayPhase: rand(0, Math.PI * 2),
        spin: new THREE.Vector3(
          rand(PETAL_SPIN.min, PETAL_SPIN.max) * (Math.random() < 0.5 ? -1 : 1),
          rand(PETAL_SPIN.min, PETAL_SPIN.max) * (Math.random() < 0.5 ? -1 : 1),
          rand(PETAL_SPIN.min, PETAL_SPIN.max) * 0.5 * (Math.random() < 0.5 ? -1 : 1)
        ),
        spinPhase: new THREE.Vector3(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28)),
        yPhase: Math.random(),
        rank: Math.random(),
      })
    }
    return arr
  }, [])

  const dummy = useMemo(() => new THREE.Object3D(), [])

  // Paint per-instance sakura colors once (HSL around pink, varied saturation +
  // lightness so the field has paler and deeper petals).
  useLayoutEffect(() => {
    const mesh = meshRef.current
    const col = new THREE.Color()
    for (let i = 0; i < PETAL_COUNT; i++) {
      col.setHSL(0.91 + Math.random() * 0.06, 0.42 + Math.random() * 0.32, 0.7 + Math.random() * 0.2)
      mesh.setColorAt(i, col)
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [])

  useFrame((state) => {
    const mesh = meshRef.current
    if (!mesh) return

    // Lock the whole field to the camera so it always fills the frame and falls
    // straight down-screen no matter where the camera roams / zooms / aims.
    mesh.position.copy(camera.position)
    mesh.quaternion.copy(camera.quaternion)

    // Presence from scroll ONLY: faint over the hero, fuller across the about.
    const p = progressRef.current
    const presence = THREE.MathUtils.lerp(
      PETAL_PRESENCE.hero,
      PETAL_PRESENCE.about,
      smoothstep(PETAL_PRESENCE.in, PETAL_PRESENCE.out, p)
    )
    material.opacity = PETAL_MAX_OPACITY * presence

    const t = state.clock.elapsedTime
    const span = PETAL_FIELD_H * 2

    for (let i = 0; i < PETAL_COUNT; i++) {
      const pt = petals[i]
      // TIME-driven fall with modulo recycle — top → bottom → top, forever.
      const travelled = (t * pt.fall + pt.yPhase * span) % span
      const y = PETAL_FIELD_H - travelled
      const x = pt.x + pt.swayAmp * Math.sin(t * pt.swayFreq + pt.swayPhase)

      // Presence gate: each petal fades in (scale) once presence passes its rank.
      const vis = clamp01((presence - pt.rank) / PETAL_RANK_BAND)

      dummy.position.set(x, y, pt.z)
      dummy.rotation.set(
        pt.spinPhase.x + t * pt.spin.x,
        pt.spinPhase.y + t * pt.spin.y,
        pt.spinPhase.z + t * pt.spin.z
      )
      dummy.scale.setScalar(pt.size * vis)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  })

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, PETAL_COUNT]}
      frustumCulled={false}
      renderOrder={1}
    />
  )
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
      {/* Ambient sakura field — behind/around the sword, after Rig so it locks to
          the camera the Rig has already placed this frame. */}
      <PetalField progressRef={progressRef} />
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
// How far (in vh) the whole hero block rises per unit of progress. Sized so the
// overlay is fully off the top by the time the parallel layout begins (~p 0.3).
const HERO_RISE = 340

/* ---- ABOUT overlay (STAGE 1, placeholders) -------------------------------- */
// All NEW fixed layers — they fade/scale IN PLACE (they do NOT rise with the hero
// block), each driven by the same `progressRef`. Windows are plateau in/out ramps in
// progress space, sequenced so cues clear BEFORE "About", which clears BEFORE the
// beats, and only ONE beat is ever visible. Placeholders — typography comes later.
const CUE = { a: 0.13, b: 0.2, c: 0.25, d: 0.3 } // approach cues fill the emptied corners
const ABOUT = { a: 0.33, b: 0.38, c: 0.41, d: 0.45 } // "About" — blade fully drawn, still wide
// 6 beats across the slowed settle (0.46 → SETTLE_END). Each fades fully OUT before the
// next fades IN, and is PINNED in clear space: ABOVE/BELOW while the sword is still wide,
// LEFT/RIGHT once it narrows into parallel bars. The 6th holds until full parallel.
const BEATS = [
  { id: 1, zone: 'ABOVE', a: 0.46, b: 0.482, c: 0.515, d: 0.533,
    eyebrow: '01 — WHO', maxW: 'max-w-none', // ABOVE: full-spaced, no cap
    body: 'Abhayanth K. Artificial Intelligence & Computer Science at Rishihood University, graduating 2028.' },
  { id: 2, zone: 'BELOW', a: 0.54, b: 0.562, c: 0.589, d: 0.607,
    eyebrow: '02 — WHAT I BUILD', maxW: 'max-w-none', // BELOW: full-spaced, no cap
    body: 'Full-stack, AI-powered products, shipped end to end on Next.js, TypeScript, and Tailwind.' },
  { id: 3, zone: 'ABOVE', a: 0.614, b: 0.636, c: 0.662, d: 0.68,
    eyebrow: '03 — THE BUILDS', maxW: 'max-w-none', // ABOVE: full-spaced, no cap
    body: 'A multi-agent retention engine. An LLM API gateway. A productivity platform. And Nextflow — AI workflow automation on trigger.dev, DAG-orchestrated.' },
  { id: 4, zone: 'LEFT', a: 0.687, b: 0.709, c: 0.736, d: 0.753,
    eyebrow: '04 — THE EDGE', maxW: 'max-w-[min(36rem,84vw)]',
    body: 'Codeforces Specialist. 1600+ problems solved. Algorithms kept sharp, daily.' },
  { id: 5, zone: 'RIGHT', a: 0.76, b: 0.782, c: 0.809, d: 0.827,
    eyebrow: '05 — OFF THE CLOCK', maxW: 'max-w-[min(36rem,84vw)]',
    body: 'ICPC preliminary rounds. Chess at 1400+ — the same hunt for the cleanest line.' },
  { id: 6, zone: 'LEFT', a: 0.834, b: 0.86, c: 1.1, d: 1.2, // holds to full parallel
    eyebrow: '06', maxW: 'max-w-[min(36rem,84vw)]',
    body: 'Still sharpening.' },
] as const

// Placement wrapper per zone — flex-centers the beat so its driven child carries ONLY a
// scale transform (no positional transform to fight). Pinned: it never moves once placed.
const ZONE_WRAP: Record<string, string> = {
  ABOVE: 'absolute inset-x-0 top-[15vh] px-[6vw] flex justify-start',
  BELOW: 'absolute inset-x-0 bottom-[15vh] px-[6vw] flex justify-start',
  LEFT: 'absolute inset-y-0 left-[7vw] flex flex-col justify-center items-start',
  RIGHT: 'absolute inset-y-0 right-[7vw] flex flex-col justify-center items-end',
}

// Beat block layout per zone. ABOVE/BELOW span the FULL width and read left→right
// (full-spaced, never a centered column); LEFT/RIGHT stay edge-aligned narrow bars
// beside the parallel blade.
const ZONE_ALIGN: Record<string, string> = {
  ABOVE: 'w-full items-start text-left',
  BELOW: 'w-full items-start text-left',
  LEFT: 'items-start text-left',
  RIGHT: 'items-end text-right',
}

export default function App() {
  const axesRef = useRef<Axes | null>(null)
  const progressRef = useRef(0)

  const backdropRef = useRef<HTMLDivElement>(null) // sakura layer
  const nameLayerRef = useRef<HTMLDivElement>(null) // wordmark layer
  const hudRef = useRef<HTMLDivElement>(null) // tagline / nav / corners
  const pctRef = useRef<HTMLSpanElement>(null)
  const progressFillRef = useRef<HTMLSpanElement>(null) // live scroll rail fill

  // ABOUT overlay refs (STAGE 1) — fade/scale in place, driven below.
  const concentrateRef = useRef<HTMLDivElement>(null)
  const scrollCueRef = useRef<HTMLDivElement>(null)
  const aboutRef = useRef<HTMLDivElement>(null)
  const beatRefs = useRef<(HTMLDivElement | null)[]>([])

  // The ENTIRE hero overlay (tree + name + HUD) scrolls UP and out as ONE block,
  // tied to the shared progress so it matches the unsheathe pace. NOT fading in place.
  // The 3D sword lives on the fixed canvas and is untouched.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const p = progressRef.current
      const rise = `translateY(${-p * HERO_RISE}vh)`
      if (backdropRef.current) backdropRef.current.style.transform = rise
      if (nameLayerRef.current) nameLayerRef.current.style.transform = rise
      if (hudRef.current) hudRef.current.style.transform = rise
      if (pctRef.current) pctRef.current.textContent = `${Math.round(clamp01(p) * 100)}`.padStart(3, '0')
      if (progressFillRef.current) progressFillRef.current.style.height = `${clamp01(p) * 100}%`

      // ONE blur-to-sharp focus-pull — shared by EVERY About-section text (cues, title,
      // beats) so the whole section speaks one animation language. Weighted smootherstep
      // ties the resolve to scroll: heavy blur + ghosted → sharp + opaque, with a whisper
      // of push-in. Slow in/out, never an abrupt pop (StringTune's unhurried pace).
      const driveFocus = (el: HTMLElement | null | undefined, t: number) => {
        if (!el) return
        const e = smoother(clamp01(t))
        el.style.opacity = `${e}`
        el.style.filter = `blur(${(1 - e) * 14}px)`
        el.style.transform = `scale(${0.992 + 0.008 * e})`
      }
      const cue = plateau(p, CUE.a, CUE.b, CUE.c, CUE.d)
      driveFocus(concentrateRef.current, cue)
      driveFocus(scrollCueRef.current, cue)
      driveFocus(aboutRef.current, plateau(p, ABOUT.a, ABOUT.b, ABOUT.c, ABOUT.d))
      for (let i = 0; i < BEATS.length; i++) {
        const b = BEATS[i]
        driveFocus(beatRefs.current[i], plateau(p, b.a, b.b, b.c, b.d))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <>
      {/* Layer 0 — backdrop: sakura tree vignette, BEHIND the canvas. Scrolls up. */}
      <div ref={backdropRef} className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
        <div
          className="absolute left-1/2 top-[46%] -translate-x-1/2 -translate-y-1/2 w-[min(62vh,88vw)] h-[min(93vh,132vw)] bg-[url('/Sakura_tree_bg.png')] bg-contain bg-center bg-no-repeat mix-blend-screen"
          style={{ opacity: 0.55, ...HEX_MASK }}
        />
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

      {/* Layer 1.5 — anchor wordmark ABOVE the canvas so the blade weaves BEHIND the
          letters (stays readable until it scrolls away with the block). */}
      <div
        ref={nameLayerRef}
        className="fixed inset-0 z-[5] flex items-end justify-center pb-[14vh] pointer-events-none overflow-hidden"
      >
        <h1
          className="font-display font-black leading-[0.8] tracking-[-0.04em] whitespace-nowrap text-washi select-none text-[clamp(3.5rem,17.5vw,17rem)]"
          style={{ opacity: 0.92 }}
        >
          Abhayanth K
        </h1>
      </div>

      {/* Layer 2 — HUD instrument panel, ABOVE the canvas. Scrolls up with the block. */}
      <div ref={hudRef} className="fixed inset-0 z-10 pointer-events-none text-washi">
        {/* top-left — hero tagline (monogram now lives in the sticky top bar). Sits
            BELOW the bar so it clears it, then scrolls up/away with the hero block. */}
        <div className="absolute top-24 left-6 md:top-28 md:left-10 font-display font-bold leading-[1.06] tracking-[-0.015em] text-[clamp(1rem,1.65vw,1.5rem)]">
          Building software.
          <br />
          Sharpening algorithms.
        </div>

        {/* top-center — build tag */}
        <div className={`absolute top-6 md:top-10 left-1/2 -translate-x-1/2 ${MONO}`}>V_1.0.0</div>

        {/* (top-right nav → sticky top bar · live scroll % → instrument panel) */}

        {/* bottom-left — role descriptor */}
        <div className={`absolute bottom-6 left-6 md:bottom-10 md:left-10 ${MONO}`}>
          SDE / COMPETITIVE PROGRAMMER
        </div>

        {/* bottom-right — signature stat */}
        <div className={`absolute bottom-6 right-6 md:bottom-10 md:right-10 text-right ${MONO}`}>
          CODEFORCES SPECIALIST <span className="text-gold ml-1">鍛</span>
        </div>

        {/* bottom-center — scroll cue */}
        <div className="absolute bottom-6 md:bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
          <span className={MONO}>scroll</span>
          <span className="block w-px h-9 bg-linear-to-b from-washi/55 to-transparent" />
        </div>
      </div>

      {/* Layer 3 — ABOUT overlay (STAGE 1 placeholders). Fixed; fades/scales in place,
          driven by the shared progress. ABOVE the canvas, never rises. */}
      <div className="fixed inset-0 z-20 pointer-events-none text-washi">
        {/* APPROACH cues — fill the corners the HUD vacated as the blade draws */}
        <div
          ref={concentrateRef}
          style={{ opacity: 0 }}
          className="absolute top-[36vh] left-[10vw] font-display font-medium text-[clamp(0.95rem,1.9vw,1.6rem)] tracking-[0.4em] uppercase text-washi/45 leading-none"
        >
          Concentrate
        </div>
        <div
          ref={scrollCueRef}
          style={{ opacity: 0 }}
          className="absolute bottom-[34vh] right-[8vw] font-display font-medium text-[clamp(0.95rem,1.9vw,1.6rem)] tracking-[0.4em] uppercase text-washi/45 leading-none"
        >
          Scroll down
        </div>

        {/* ABOUT — arrives once the blade is fully drawn. Section title pinned near the
            TOP; the scroll indicator sits at the BOTTOM CENTER (clear vertical split). */}
        <div ref={aboutRef} style={{ opacity: 0 }} className="absolute inset-0">
          <span className="absolute top-[12vh] left-1/2 -translate-x-1/2 font-display font-black tracking-[-0.03em] leading-none text-[clamp(3rem,9vw,7rem)]">
            About
          </span>
          <div className="absolute bottom-[6vh] left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
            <span className="font-mono text-[0.62rem] tracking-[0.28em] uppercase text-washi/45">
              scroll down
            </span>
            <span className="block w-px h-9 bg-linear-to-b from-washi/55 to-transparent" />
          </div>
        </div>

        {/* BEATS — one at a time, each PINNED in clear space. Monospace instrument-panel
            eyebrow over a clean display body; reveal/placement unchanged. */}
        {BEATS.map((b, i) => (
          <div key={b.id} className={ZONE_WRAP[b.zone]}>
            <div
              ref={(el) => {
                beatRefs.current[i] = el
              }}
              style={{ opacity: 0 }}
              className={`flex flex-col gap-3 ${b.maxW} ${ZONE_ALIGN[b.zone]}`}
            >
              <span className="font-mono text-[0.72rem] tracking-[0.24em] uppercase text-gold/90">
                {b.eyebrow}
              </span>
              <p className="font-display font-medium leading-[1.14] tracking-[-0.01em] text-washi text-[clamp(1.35rem,2.9vw,2.5rem)]">
                {b.body}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Persistent instrument panel — quiet margin detail, FIXED, never scrolls, so the
          corners always carry low-contrast detail instead of bare black. Same monospace
          language as the hero corners: section label, faint vertical kanji, live scroll rail. */}
      <div className="fixed inset-0 z-[15] pointer-events-none font-mono text-washi/25 select-none">
        {/* left edge — section label + faint vertical kanji column */}
        <div className="absolute left-[1.6vw] top-1/2 -translate-y-1/2 flex items-center gap-4 [writing-mode:vertical-rl] rotate-180">
          <span className="text-[0.6rem] tracking-[0.5em] uppercase">Sec.01 — Forge</span>
          <span className="text-base tracking-[0.4em] text-gold/20">鍛 鍛 鍛</span>
        </div>
        {/* right edge — live scroll-progress rail + numeric readout */}
        <div className="absolute right-[1.7vw] top-1/2 -translate-y-1/2 flex flex-col items-center gap-3">
          <span className="text-[0.55rem] tracking-[0.4em] uppercase [writing-mode:vertical-rl]">Scroll</span>
          <span className="relative block w-px h-28 bg-washi/12 overflow-hidden">
            <span ref={progressFillRef} className="absolute inset-x-0 top-0 bg-gold/45" style={{ height: '0%' }} />
          </span>
          <span className="text-[0.58rem] tracking-[0.15em] tabular-nums">
            <span ref={pctRef}>000</span>%
          </span>
        </div>
      </div>

      {/* Sticky top bar — ONE element: monogram (LEFT) + nav (RIGHT). Fixed at the top
          across the ENTIRE scroll (hero → about → every section), like StringTune. The
          wordmark + tagline are NOT here — they live in the hero and scroll away. */}
      <header className="fixed top-0 inset-x-0 z-50 pointer-events-none">
        <div className="bg-linear-to-b from-ink/70 via-ink/25 to-transparent">
          <div className="flex items-center justify-between px-6 md:px-10 h-16 md:h-20">
            <span className="text-2xl leading-none text-gold pointer-events-auto select-none">鍛</span>
            <nav className="flex gap-1.5 pointer-events-auto">
              <span className={`${PILL} border-gold/50 text-gold`}>About</span>
              <span className={`${PILL} border-washi/15 text-washi/70`}>Projects</span>
              <span className={`${PILL} border-washi/15 text-washi/70`}>CP</span>
              <span className={`${PILL} border-washi/15 text-washi/70`}>Contact</span>
            </nav>
          </div>
        </div>
      </header>

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
useGLTF.preload(PETAL_URL)
