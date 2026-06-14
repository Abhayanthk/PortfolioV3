import { Suspense, useLayoutEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Loader, ScrollControls, useGLTF, useScroll } from '@react-three/drei'
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

/* ---- Framing (tight & cinematic — katana fills most of the frame) --------- */
const FOV = 32 // degrees. Long lens = flatter, more filmic.
const TARGET_FILL = 0.82 // model fills ~82% of the smaller viewport axis at hero
const HERO_OFF = new THREE.Vector3(0.0, 0.05, 5.2) // camera offset from focus — close
const DISPLAY_OFF = new THREE.Vector3(0.0, -0.1, 7.4) // pulled back to reveal the parallel layout
const DRIFT_DIR = new THREE.Vector3(1.25, 0.0, 0.0) // lateral camera drift across the blade (hold)

/* ---- Scroll breakpoints (progress 0 → 1) ---------------------------------- */
//  0.00–0.20  unsheathe        |  0.20–0.32  rotate toward horizontal
//  0.32–0.48  scabbard parallel|  0.48–0.62  hold + camera drift
//  0.62–0.80  resheathe         |  0.80–1.00  camera returns to hero
const DRAW = { in: 0.0, out: 0.2, backIn: 0.7, backOut: 0.8 } // sword draw ramp edges
const POSE = { in: 0.2, out: 0.32, backIn: 0.8, backOut: 1.0 } // diagonal→horizontal ramp
const PART = { in: 0.32, out: 0.48, backIn: 0.62, backOut: 0.7 } // scabbard parallel ramp
const FRAME = { in: 0.2, out: 0.48, backIn: 0.8, backOut: 1.0 } // hero→display camera ramp
const DRIFT = { a: 0.46, b: 0.52, c: 0.58, d: 0.64 } // hold drift bump

/* ---- Object motion (as FRACTIONS of blade length, so they self-scale) ----- */
const DRAW_DIST = 0.95 // arc length of the full draw, as a fraction of blade length
const SCAB_DROP = 0.32 // scabbard offset perpendicular to the blade (drops it below)
const SAYA_BIKI = 0.45 // sheath pull-back during the draw, as a fraction of the blade's draw angle

/* ---- Clip plane: hides the blade portion still inside the sheath ----------- */
// Active during the draw + resheathe (when the blade overlaps the bore); OFF during
// the display layout, where the blade is fully drawn and must be entirely visible.
const CLIP_DRAW_CLEAR = 0.3 // p ≤ this: clip ON (covers the unsheathe, blade clears by 0.2)
const CLIP_RESHEATHE = 0.7 // p ≥ this: clip ON again (scabbard back home, blade slides in)

/* ---- Damping (higher = snappier, lower = floatier). The soul of the feel. - */
const OBJ_DAMP = 3.4 // sword / scabbard position easing
const POSE_DAMP = 3.0 // rotation easing
const CAM_DAMP = 2.4 // camera position easing
const LOOK_DAMP = 2.8 // look-target easing

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
  sword: THREE.Object3D
  scabbard: THREE.Object3D
  sword0: THREE.Vector3 // authored (sheathed) node positions, in node-parent (root) space
  scab0: THREE.Vector3
  swordQuat0: THREE.Quaternion // authored blade orientation — arc rotation composes onto this
  scabQuat0: THREE.Quaternion // authored scabbard orientation — co-rotation composes onto this
  pivot: THREE.Vector3 // centre of curvature (root space) — the blade sweeps about this
  rotAxis: THREE.Vector3 // unit; +angle about it draws the blade OUT along its arc
  radius: number // sori curvature radius (root space) — arc length = angle × radius
  drawAxis: THREE.Vector3 // unit, points OUT through the scabbard mouth (toward handle)
  perpAxis: THREE.Vector3 // unit, perpendicular — drops scabbard below blade in the display
  displayQuat: THREE.Quaternion // orientation that lays the blade horizontal, flat to camera
  len: number // blade length in NODE/root space — the unit for all motion distances
  center: THREE.Vector3 // model center in SCENE space — for framing
  maxDim: number // model size in SCENE space — for framing
  mouthLocal: THREE.Vector3 // mouth point in the scabbard node's LOCAL frame (clip anchor)
  drawAxisLocal: THREE.Vector3 // bore tangent at the mouth, in the scabbard's LOCAL frame
}

/* ----------------------------------------------------------------------------
 *  Derive the draw axis + display orientation straight from the mesh geometry.
 *  Robust to the model's diagonal pose; uses no world-axis assumptions.
 * -------------------------------------------------------------------------- */
// Solve a 3×3 linear system M·x = r by Cramer's rule (for the circle fit).
function solve3(
  a: number, b: number, c: number,
  d: number, e: number, f: number,
  g: number, h: number, i: number,
  j: number, k: number, l: number
): [number, number, number] {
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-9) return [0, 0, 0]
  const x = j * (e * i - f * h) - b * (k * i - f * l) + c * (k * h - e * l)
  const y = a * (k * i - f * l) - j * (d * i - f * g) + c * (d * l - k * g)
  const z = a * (e * l - k * h) - b * (d * l - k * g) + j * (d * h - e * g)
  return [x / det, y / det, z / det]
}

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
  // The sori curves in the broad plane, so the draw is a rotation about this axis.
  const ex = smx.x - smn.x, ey = smx.y - smn.y, ez = smx.z - smn.z
  const faceNormal = new THREE.Vector3(
    ex <= ey && ex <= ez ? 1 : 0,
    ey <= ex && ey <= ez ? 1 : 0,
    !(ex <= ey && ex <= ez) && !(ey <= ex && ey <= ez) ? 1 : 0
  )
  if (faceNormal.dot(new THREE.Vector3(0, 0, 1)) < 0) faceNormal.negate()

  // --- Sori (curvature): fit a circular arc to the bore centerline -----------
  // Sample the centerline by binning scabbard verts along the rough axis and
  // taking each slice's centroid → a polyline that follows the curve.
  const NB = 16
  const binSum = Array.from({ length: NB }, () => new THREE.Vector3())
  const binCnt = new Array<number>(NB).fill(0)
  const span = cMax - cMin || 1
  eachVertex(scabbard, (p) => {
    let k = Math.floor(((p.dot(boreRough) - cMin) / span) * NB)
    k = Math.max(0, Math.min(NB - 1, k))
    binSum[k].add(p); binCnt[k]++
  })
  const centerline: THREE.Vector3[] = []
  for (let k = 0; k < NB; k++) if (binCnt[k] > 0) centerline.push(binSum[k].multiplyScalar(1 / binCnt[k]))

  // Fit a circle in the curve plane (u = along bore, v = in-plane perpendicular).
  const cOrigin = new THREE.Vector3()
  centerline.forEach((p) => cOrigin.add(p))
  cOrigin.multiplyScalar(1 / centerline.length)
  const u = boreRough.clone().addScaledVector(faceNormal, -boreRough.dot(faceNormal)).normalize()
  const vv = new THREE.Vector3().crossVectors(faceNormal, u).normalize()
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0
  for (const p of centerline) {
    const x = p.clone().sub(cOrigin).dot(u)
    const y = p.clone().sub(cOrigin).dot(vv)
    const z = x * x + y * y
    Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y
    Sxz += x * z; Syz += y * z; Sz += z
  }
  const [Dc, Ec, Fc] = solve3(Sxx, Sxy, Sx, Sxy, Syy, Sy, Sx, Sy, centerline.length, Sxz, Syz, Sz)
  const ca = Dc / 2, cb = Ec / 2
  let radius = Math.sqrt(Math.max(1e-4, Fc + ca * ca + cb * cb))
  if (!isFinite(radius) || radius < 0.5 * swordLen) radius = 50 * swordLen // degenerate ⇒ ~straight
  const pivot = cOrigin.clone().addScaledVector(u, ca).addScaledVector(vv, cb)

  // Rotation axis = face normal, signed so a POSITIVE angle sweeps OUT the mouth.
  const rotAxis = faceNormal.clone()
  const tan = new THREE.Vector3().crossVectors(rotAxis, mouth.clone().sub(pivot))
  if (tan.dot(drawAxis) < 0) rotAxis.negate()
  console.log('[katana:arc]', JSON.stringify({ radius: +radius.toFixed(2), len: +swordLen.toFixed(2), ratio: +(radius / swordLen).toFixed(2), drawAngleDeg: +(THREE.MathUtils.radToDeg(DRAW_DIST * swordLen / radius)).toFixed(1) }))

  // Rest blade basis: e1=along blade, e3=face normal. perpAxis (screen-DOWN) is
  // rotated into the drawn frame at runtime to drop the scabbard below the blade.
  const e1 = drawAxis.clone()
  const e3 = faceNormal.clone().addScaledVector(e1, -faceNormal.dot(e1)).normalize()
  const perpAxis = new THREE.Vector3().crossVectors(e1, e3).normalize()

  // displayQuat lays the DRAWN blade horizontal. During the display the blade is
  // rotated by the full draw angle, so build the basis from the drawn long-axis.
  const fullAngle = (DRAW_DIST * swordLen) / radius
  const e1d = drawAxis.clone().applyAxisAngle(rotAxis, fullAngle)
  const e2d = new THREE.Vector3().crossVectors(e3, e1d).normalize()
  const basis = new THREE.Matrix4().makeBasis(e1d, e2d, e3).transpose()
  const displayQuat = new THREE.Quaternion().setFromRotationMatrix(basis)

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

  // Capture the AUTHORED rest pose ONCE and stash it on the node, so re-deriving
  // (StrictMode / HMR) after the blade has animated can never drift the rest pose.
  type Rest = { p: THREE.Vector3; q: THREE.Quaternion }
  const restOf = (o: THREE.Object3D): Rest => {
    if (!o.userData.rest) o.userData.rest = { p: o.position.clone(), q: o.quaternion.clone() }
    return o.userData.rest as Rest
  }
  const swordRest = restOf(sword)
  const scabRest = restOf(scabbard)

  // Express the mouth point + bore tangent in the scabbard node's LOCAL frame, so the
  // clip plane follows the scabbard's full transform (incl. the saya-biki rotation).
  const scabRestInv = new THREE.Matrix4().compose(scabRest.p, scabRest.q, scabbard.scale).invert()
  const mouthLocal = mouth.clone().applyMatrix4(scabRestInv)
  const drawAxisLocal = drawAxis.clone().transformDirection(scabRestInv).normalize()

  return {
    sword,
    scabbard,
    sword0: swordRest.p.clone(),
    scab0: scabRest.p.clone(),
    swordQuat0: swordRest.q.clone(),
    scabQuat0: scabRest.q.clone(),
    pivot,
    rotAxis,
    radius,
    drawAxis,
    perpAxis,
    displayQuat,
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

function Katana({ axesRef }: { axesRef: React.MutableRefObject<Axes | null> }) {
  const { scene } = useGLTF(MODEL_URL)
  const scroll = useScroll()
  const { size, gl } = useThree()

  const poseRef = useRef<THREE.Group>(null!)
  const fitRef = useRef<THREE.Group>(null!)

  const axes = useMemo(() => deriveAxes(scene), [scene])
  axesRef.current = axes

  // Clip plane: starts "open" (constant huge ⇒ nothing clipped) until driven each frame.
  const clipPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e9), [])

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

  const scabDrop = useMemo(() => new THREE.Vector3(), [])
  const qTarget = useMemo(() => new THREE.Quaternion(), [])
  const rotQ = useMemo(() => new THREE.Quaternion(), [])
  const rotQ2 = useMemo(() => new THREE.Quaternion(), [])
  const bladeAngle = useRef(0)
  const scabPart = useRef(0)
  const scabAngle = useRef(0)
  const mouthWorld = useMemo(() => new THREE.Vector3(), [])
  const axisWorld = useMemo(() => new THREE.Vector3(), [])

  useFrame((_, dt) => {
    const p = scroll.offset
    const { sword, scabbard, sword0, scab0, swordQuat0, scabQuat0, pivot, rotAxis, radius } = axes
    const { perpAxis, displayQuat, len, mouthLocal, drawAxisLocal } = axes

    const slideOut = plateau(p, DRAW.in, DRAW.out, DRAW.backIn, DRAW.backOut)
    const part = plateau(p, PART.in, PART.out, PART.backIn, PART.backOut)
    const poseAmt = plateau(p, POSE.in, POSE.out, POSE.backIn, POSE.backOut)
    const fullAngle = (DRAW_DIST * len) / radius

    // SWORD: sweep out along the blade's CURVE by rotating the group about the sori
    // pivot (centre of curvature). Damp the ANGLE so it follows the curve. Rigid:
    // angle=0 ⇒ exactly the authored sheathed pose (position + orientation).
    bladeAngle.current = damp(bladeAngle.current, slideOut * fullAngle, OBJ_DAMP, dt)
    rotQ.setFromAxisAngle(rotAxis, bladeAngle.current)
    sword.position.copy(sword0).sub(pivot).applyQuaternion(rotQ).add(pivot)
    sword.quaternion.copy(rotQ).multiply(swordQuat0)

    // SCABBARD rotation about the SAME pivot, two complementary terms:
    //  • parallel co-rotation (part): glides up the arc to sit collinear with the
    //    drawn blade, reaching its angle at part=1 ⇒ concentric, then drops below.
    //  • SAYA BIKI (saya-biki): during the draw/resheathe (part≈0) the sheath is
    //    pulled BACK opposite the blade so the mouth tracks the blade's exit and the
    //    two stay one continuous curve. It is gated by (1-part), so it fades out as
    //    the parallel layout takes over and is zero at rest and in the display.
    const scabTarget = part * fullAngle - slideOut * (1 - part) * SAYA_BIKI * fullAngle
    scabAngle.current = damp(scabAngle.current, scabTarget, OBJ_DAMP, dt)
    scabPart.current = damp(scabPart.current, part, OBJ_DAMP, dt)
    rotQ2.setFromAxisAngle(rotAxis, scabAngle.current)
    scabbard.position.copy(scab0).sub(pivot).applyQuaternion(rotQ2).add(pivot)
    scabDrop.copy(perpAxis).applyQuaternion(rotQ2).multiplyScalar(SCAB_DROP * len * scabPart.current)
    scabbard.position.add(scabDrop)
    scabbard.quaternion.copy(rotQ2).multiply(scabQuat0)

    // POSE: rotate the whole assembly from diagonal hero toward horizontal display.
    qTarget.slerpQuaternions(HERO_QUAT, displayQuat, poseAmt)
    poseRef.current.quaternion.slerp(qTarget, 1 - Math.exp(-POSE_DAMP * dt))

    // CLIP: hide the blade still inside the sheath. The plane sits at the scabbard
    // mouth with its normal along the bore tangent, so the in-bore half-space is
    // clipped. Anchored in the scabbard's LOCAL frame ⇒ it follows the scabbard's
    // full transform (translation + saya-biki rotation). OFF during the display.
    const clipOn = p <= CLIP_DRAW_CLEAR || p >= CLIP_RESHEATHE
    if (clipOn) {
      scabbard.updateWorldMatrix(true, false) // sync after this frame's transform
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

function Rig({ axesRef }: { axesRef: React.MutableRefObject<Axes | null> }) {
  const scroll = useScroll()
  const { camera } = useThree()

  const focus = useMemo(() => new THREE.Vector3(), [])
  const pa = useMemo(() => new THREE.Vector3(), [])
  const pb = useMemo(() => new THREE.Vector3(), [])
  const off = useMemo(() => new THREE.Vector3(), [])
  const camTarget = useMemo(() => new THREE.Vector3(), [])
  const look = useMemo(() => new THREE.Vector3(), [])

  useFrame((_, dt) => {
    const axes = axesRef.current
    if (!axes) return
    const p = scroll.offset

    // Live focus = midpoint of sword & scabbard → frame stays centered as they move.
    axes.sword.getWorldPosition(pa)
    axes.scabbard.getWorldPosition(pb)
    focus.copy(pa).add(pb).multiplyScalar(0.5)

    const frameAmt = plateau(p, FRAME.in, FRAME.out, FRAME.backIn, FRAME.backOut)
    const driftAmt = plateau(p, DRIFT.a, DRIFT.b, DRIFT.c, DRIFT.d)

    off.copy(HERO_OFF).lerp(DISPLAY_OFF, frameAmt).addScaledVector(DRIFT_DIR, driftAmt)
    camTarget.copy(focus).add(off)

    camera.position.x = damp(camera.position.x, camTarget.x, CAM_DAMP, dt)
    camera.position.y = damp(camera.position.y, camTarget.y, CAM_DAMP, dt)
    camera.position.z = damp(camera.position.z, camTarget.z, CAM_DAMP, dt)

    look.x = damp(look.x, focus.x, LOOK_DAMP, dt)
    look.y = damp(look.y, focus.y, LOOK_DAMP, dt)
    look.z = damp(look.z, focus.z, LOOK_DAMP, dt)
    camera.lookAt(look)
  })

  return null
}

/* ============================================================================
 *  Scene — lights, environment reflections (UNCHANGED), the katana, the rig
 * ========================================================================== */

function Scene({ axesRef }: { axesRef: React.MutableRefObject<Axes | null> }) {
  return (
    <>
      {/* Key light: hard, raking, defines the blade's edge. */}
      <directionalLight position={[4, 6, 5]} intensity={2.4} color="#fff6ea" />
      {/* Soft fill from the opposite side so shadows aren't crushed. */}
      <directionalLight position={[-6, 2, -3]} intensity={0.5} color="#9fb4ff" />
      {/* Gentle ambient floor. */}
      <hemisphereLight args={['#2a2a30', '#050505', 0.35]} />

      {/* Studio HDRI for real metal reflections — kept OUT of the background. */}
      <Environment preset="studio" background={false} />

      <Katana axesRef={axesRef} />
      <Rig axesRef={axesRef} />
    </>
  )
}

/* ============================================================================
 *  App — Canvas, tone mapping (UNCHANGED), scroll container
 * ========================================================================== */

export default function App() {
  const axesRef = useRef<Axes | null>(null)

  return (
    <>
      <Canvas
        dpr={[1, 2]}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
        camera={{ position: HERO_OFF.toArray(), fov: FOV, near: 0.1, far: 100 }}
      >
        <color attach="background" args={['#0a0a0a']} />

        <Suspense fallback={null}>
          {/* pages = scroll length. 4 gives the choreography room to breathe. */}
          <ScrollControls pages={4} damping={0.25}>
            <Scene axesRef={axesRef} />
          </ScrollControls>
        </Suspense>
      </Canvas>

      {/* Simple loading state (DOM overlay, fades out when the model is ready). */}
      <Loader
        containerStyles={{ background: '#0a0a0a' }}
        barStyles={{ background: '#c9a25e', height: '2px' }}
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
