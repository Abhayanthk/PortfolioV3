import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Loader, ScrollControls, useAnimations, useGLTF, useScroll, useTexture } from '@react-three/drei'
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

/* ---- STAGE 2: ABOUT → PROJECTS transition (exact ordered sequence) ----------
 * PHASE 1  re-sheathe = EXACT REVERSE of the unsheathe, in two ordered steps:
 *   STEP 1  reverse the PARALLEL offset (PART) → blade + scabbard return to the clip's
 *           END pose (blade fully drawn but ALIGNED with the scabbard mouth); clip held.
 *   STEP 2  THEN reverse-scrub the clip (CLIP end→0) → blade slides cleanly back INSIDE
 *           the scabbard → one clean sheathed katana.
 *   Timed TOGETHER with the landscape glitch-IN so both finish at the SAME moment.
 * PHASE 2  the sheathed katana PIXELS OUT (chunky localized dissolve) → clean landscape.
 * PHASE 3  small "projects" label resolves with a clean blur-to-sharp.
 * PHASE 4  glitch-OUT: blocks of ONE bg color (#f4f1ea — the LIGHT projects paper)
 *          vanish into the projects section, so the hand-off lands on cream, not dark.
 * PHASE 5  light (#f4f1ea) PROJECTS section — reference redesign, click-accordion.
 */
const RESHEATHE_OFFSET = { in: 0.87, out: 0.905 } // STEP 1: reverse parallel offset → clip END pose
const RESHEATHE_CLIP = { in: 0.905, out: 0.935 } // STEP 2: reverse-scrub clip → blade slides INTO scabbard
const LAND_REVEAL = { in: 0.87, out: 0.935 } // glitch-in resolves the landscape — FINISHES with the sheathe
const TRANS_ZOOM = { in: 0.87, out: 0.935 } // dolly the camera IN over the re-sheathe (katana → large)
const TRANS_ZOOM_AMT = 0.5 // camera-offset multiplier when sheathed (smaller = closer ⇒ ~70% of frame)
const KDISS = { in: 0.945, out: 0.972 } // PHASE 2: katana pixel-dissolve (blade + sheath TOGETHER, gone after)
const KBLOCK_PX = 48 // uniform CHUNKY dissolve block size (device px)
const LABEL_IN = { in: 0.975, out: 0.987 } // PHASE 3: "projects" label clean blur-to-sharp
const LAND_VANISH = { in: 0.99, out: 1.0 } // PHASE 4: one-color glitch-out — label + landscape vanish
// PHASE 5: the LIGHT projects section. A cream BACKDROP (z-1) fades in EARLY — hidden behind
// the still-opaque landscape — so the glitch-out's vanishing blocks reveal cream, never the
// dark body. The interactive CONTENT (z-40, above the canvas so its buttons are clickable)
// resolves with the dissolve.
const PAPER_IN = { in: 0.95, out: 0.985 } // cream reveal target, ready before the vanish
const ROWS_IN = { in: 0.99, out: 1.0 } // projects content resolves as the landscape vanishes
const LAND_BLOCKS = 24 // landscape glitch block count (vertical)
const LAND_OUT_COLOR = '#f4f1ea' // glitch-out tone = LIGHT projects paper (reference redesign)
const PAN_STRENGTH = 0.95 // how far the mouse pans into the cropped image margin (1 = full)
const PETAL_FADE = { in: 0.87, out: 0.91 } // petals clear as the katana re-sheathes
const ABOUT_CLEAR = { in: 0.855, out: 0.885 } // about beats clear as the zone begins
const LANDSCAPE_URL = '/Ukiyo-e_Landscape_web.png' // web-sized (3600px); source PNG is 7660px/30MB → too big to upload
const LAND_IMG_ASPECT = 3600 / 1543

const CLIP = { in: 0.0, out: 0.2, backIn: RESHEATHE_CLIP.in, backOut: RESHEATHE_CLIP.out } // unsheathe → STEP 2 reverse-scrub
const POSE = { in: 0.2, out: 0.32, backIn: 1.5, backOut: 1.6 } // hold horizontal (clip-END pose orientation)
const PART = { in: 0.32, out: SETTLE_END, backIn: RESHEATHE_OFFSET.in, backOut: RESHEATHE_OFFSET.out } // settle → STEP 1 reverse offset
const FRAME = { in: 0.2, out: SETTLE_END, backIn: 1.5, backOut: 1.6 } // camera holds display framing
const DRIFT = { a: 1.5, b: 1.6, c: 1.7, d: 1.8 } // drift bump disabled (was the dropped hold)

/* ---- Object motion -------------------------------------------------------- */
const SCAB_DROP = 0.32 // scabbard offset perpendicular to the blade (fraction of blade length)
const START_DRAWN = 0.12 // resting clip fraction at scroll 0 — opens mid-gesture, slightly drawn

/* ---- Clip plane: hides the blade portion still inside the sheath ----------- */
// Active during the unsheathe + resheathe (when the blade overlaps the bore); OFF
// during the display, where the blade is fully drawn and must be entirely visible.
const CLIP_DRAW_CLEAR = 0.3 // p ≤ this: clip ON (covers the unsheathe, blade clears by 0.2)
const CLIP_RESHEATHE = RESHEATHE_CLIP.in // p ≥ this: clip ON again so the returning blade hides inside the sheath

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

// Scroll→progress remap: give the ABOUT → PROJECTS transition (p ≥ SETTLE_END) a LARGER
// share of the physical scroll than the about section — slower, weightier transition —
// without changing any about-section window (piecewise-linear, continuous at the split).
const SCROLL_SPLIT = 0.8 // fraction of total scroll spent on hero+about (p: 0 → SETTLE_END)
const remapScroll = (raw: number) =>
  raw <= SCROLL_SPLIT
    ? (raw / SCROLL_SPLIT) * SETTLE_END
    : SETTLE_END + ((raw - SCROLL_SPLIT) / (1 - SCROLL_SPLIT)) * (1 - SETTLE_END)

/* ---- PAGE / SCROLL BUDGET --------------------------------------------------
 * The katana arc (hero → about → about→projects transition) keeps its EXACT physical
 * scroll; the PROJECTS scroll-stack is APPENDED as extra pages. `KATANA_SCROLL` is the
 * fraction of the raw page-scroll the katana arc owns — feed `raw / KATANA_SCROLL` into
 * remapScroll so the existing choreography stays pixel-identical, and drive the stack
 * off the remaining raw 1 − KATANA_SCROLL. */
const HERO_PAGES = 8 // hero + about + transition (unchanged feel)
// Projects is now a CLICK-driven accordion (not a scroll-stack), so it needs no scroll
// budget of its own — 1 page leaves a small post-landing buffer. NB: the katana arc keeps
// EXACTLY (HERO_PAGES-1) pages of physical scroll regardless of this value, so the
// hero/about/transition feel is pixel-identical.
// Projects is a CLICK accordion — it needs NO scroll of its own, so no stack pages:
// the moment you scroll past the landing, the contact transition begins (no dead scroll).
const STACK_PAGES = 0
// STAGE 3 — CONTACT: appended scroll for the closing frame (projects → night → blade display).
const CONTACT_PAGES = 2
const TOTAL_PAGES = HERO_PAGES + STACK_PAGES + CONTACT_PAGES
const KATANA_SCROLL = (HERO_PAGES - 1) / (TOTAL_PAGES - 1)

// Map a katana-arc progress p to its RAW page-scroll fraction (inverse of remapScroll,
// scaled into the katana arc's share) — used by the nav to jump to sections.
const pToRaw = (p: number) =>
  (p <= SETTLE_END
    ? (p / SETTLE_END) * SCROLL_SPLIT
    : SCROLL_SPLIT + ((p - SETTLE_END) / (1 - SETTLE_END)) * (1 - SCROLL_SPLIT)) * KATANA_SCROLL

// Nav targets as raw scroll fractions. About lands where the "About" title is fully
// resolved; Projects at the landed accordion; Contact at the full close.
const NAV_RAW = { top: 0, about: pToRaw(0.395), projects: KATANA_SCROLL, contact: 1 } as const
type NavTarget = keyof typeof NAV_RAW

/* ---- STAGE 3: CONTACT — the bare blade, displayed --------------------------------
 * The closing frame, on its OWN dark tone (--color-night, a midnight indigo that
 * complements the blue-purple blade + gold — deliberately NOT the hero's #0A0A0A).
 * The projects rows clear off the cream, the night layer crossfades over it, and a
 * SHARP-EDGED hexagon of the sakura tree art fills the LEFT half; the persistent
 * katana re-materializes over it as the BARE BLADE — scabbard hidden, fully drawn,
 * tilted, slowly rotating about its own long axis. No settle choreography: the blade
 * simply fades in already displayed, spinning. The RIGHT half is the full contact
 * stack (email · socials · form). All windows below live in q — the damped stack
 * progress spanning the appended pages (raw KATANA_SCROLL → 1) — so contact
 * choreography never touches the katana arc. Windows start almost immediately — the
 * projects accordion is click-driven, so any scroll past the landing IS the exit
 * (no dead buffer scroll). */
const C_CLEAR = { in: 0.06, out: 0.2 } // projects rows clear off the cream
const C_NIGHT = { in: 0.1, out: 0.34 } // night layer + hexagon crossfade over the cream
// NO glitch, NO travel: while the blade is still invisible, camera/pose/draw SNAP to
// the final display state (C_SNAP), then the blade plain-fades in ALREADY in place
// over the hexagon (C_FADE). The pixel-dissolve is never reversed here.
const C_SNAP = 0.3 // snap point — everything invisible flips to the display state
const C_FADE = { in: 0.34, out: 0.52 } // plain opacity fade-in of the displayed blade
const C_HEAD = { in: 0.42, out: 0.58 } // eyebrow + "Contact" focus-pull
const C_BODY = { in: 0.5, out: 0.68 } // email / socials / form
const C_FOOT = { in: 0.62, out: 0.82 } // corners + footer line
const C_PETAL = { amt: 0.12, in: 0.36, out: 0.62 } // sparse petal drift over the close
// Final display framing: pull back and aim RIGHT of the blade so it sits over the
// left-side hexagon artwork, sized to fit inside it.
const CONTACT_OFF = new THREE.Vector3(0, 0, 9.0)
const CONTACT_SHIFT_X = 1.85 // world units the aim sits right of the blade's center
const CONTACT_TILT_DEG = -24 // in-plane diagonal of the displayed blade
const CONTACT_SPIN = 0.3 // slow idle roll about the blade's own long axis, rad/s

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

// Pixel-dissolve injected into the katana's materials (BOTH blade + scabbard, sharing the
// SAME uniforms) so the whole sheathed katana breaks into ONE uniform, chunky, even grid
// of screen-space blocks and discards them together as the dissolve grows.
const KDISS_GLSL_HEAD = `
uniform float uKDissolve;
uniform float uBlockPx;
float kdHash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`
const KDISS_GLSL_BODY = `
  if (uKDissolve > 0.0001) {
    vec2 kdCell = floor(gl_FragCoord.xy / uBlockPx);
    if (kdHash(kdCell) < uKDissolve) discard;
  }
`

// Data extracted from the built-in clip once it's loaded (sampled at its end pose).
type ClipData = {
  mixer: THREE.AnimationMixer
  action: THREE.AnimationAction
  duration: number
  displayQuat: THREE.Quaternion // lays the CLIP-drawn blade horizontal
  scabPos: THREE.Vector3 // scabbard target (concentric under the drawn blade + drop)
  scabQuat: THREE.Quaternion
}

function Katana({ axesRef, progressRef, stackProgressRef }: DriveProps) {
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

  // CONTACT display orientation: the drawn-blade display pose (cd.displayQuat) tipped
  // to a diagonal, then slowly rolled about the blade's own (tilted) long axis. The
  // display pose maps the blade's length onto world X, so the tilted X is the spin axis.
  const contactTiltQuat = useMemo(
    () => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(CONTACT_TILT_DEG)),
    []
  )
  const contactSpinAxis = useMemo(() => new THREE.Vector3(1, 0, 0).applyQuaternion(contactTiltQuat), [contactTiltQuat])
  const contactQuatTmp = useMemo(() => new THREE.Quaternion(), [])
  const contactSpinTmp = useMemo(() => new THREE.Quaternion(), [])

  // Clip plane: starts "open" (constant huge ⇒ nothing clipped) until driven each frame.
  const clipPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e9), [])

  // Shared uniforms for the katana's pixel-dissolve (mutated each frame; bound into BOTH
  // the blade's and the scabbard's material shaders so they dissolve as ONE.
  const dissolve = useMemo(
    () => ({
      uKDissolve: { value: 0 },
      uBlockPx: { value: KBLOCK_PX },
    }),
    []
  )

  // Built-in clip, sampled for its end pose + the derived display/scabbard targets.
  const clipRef = useRef<ClipData | null>(null)

  // The blade's cloned materials — collected so the CONTACT display can plain-fade
  // the bare blade in via opacity (no pixel-dissolve, no motion).
  const bladeMats = useRef<THREE.Material[]>([])

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
    // Inject the shared pixel-dissolve discard into a material clone.
    const addDissolve = (c: THREE.Material) => {
      c.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, dissolve)
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${KDISS_GLSL_HEAD}`)
          .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${KDISS_GLSL_BODY}`)
      }
    }
    // Bind every material on a node: BLADE also gets the clip plane (sheath-hiding); the
    // SCABBARD only gets the dissolve (never clipped). Both share `dissolve` ⇒ they pixel
    // out together as one.
    const bindNode = (node: THREE.Object3D, withClip: boolean) =>
      node.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const bind = (m: THREE.Material) => {
          const c = m.clone()
          if (withClip) {
            c.clippingPlanes = [clipPlane]
            c.clipShadows = true
            bladeMats.current.push(c) // blade clones — CONTACT fades these by opacity
          }
          addDissolve(c)
          return c
        }
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(bind) : bind(mesh.material)
      })
    bladeMats.current = []
    bindNode(axes.sword, true)
    bindNode(axes.scabbard, false)
  }, [axes, gl, clipPlane, dissolve])

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

  useFrame((state) => {
    const cd = clipRef.current
    if (!cd) return
    const p = progressRef.current // the ONE smoothed progress — no per-element damping
    const { scabbard, scab0, scabQuat0, mouthLocal, drawAxisLocal } = axes

    // UNSHEATHE: clip time is a pure function of p. Rest (p=0) starts slightly drawn
    // (START_DRAWN); 0→0.2 draws fully out, held, 0.62→0.8 returns to the rest fraction.
    // The forward unsheathe keeps its easing; the REVERSE re-sheathe uses the heavier
    // smootherstep so it feels SLOW + WEIGHTED (deliberate, not a snap).
    // STAGE 3 — CONTACT (driven by q, the appended stack progress): NO glitch, NO
    // travel. At C_SNAP — while everything is still fully dissolved/invisible — the
    // draw, pose, and scabbard flip straight to the final display state; the bare
    // blade then plain-fades in via material opacity, already in place, spinning.
    const cq = stackProgressRef?.current ?? 0
    const cOn = cq > C_SNAP
    const cFade = smoothstep(C_FADE.in, C_FADE.out, cq)
    scabbard.visible = !cOn // hidden for the whole contact display

    const ramp =
      smoothstep(CLIP.in, CLIP.out, p) - smoother(clamp01((p - CLIP.backIn) / (CLIP.backOut - CLIP.backIn)))
    const frac = cOn ? 1 : START_DRAWN + (1 - START_DRAWN) * ramp
    cd.action.time = frac * cd.duration
    cd.mixer.update(0) // applies the blade pose for this clip time

    // PHASE 2 — the sheathed katana PIXELS OUT (blade + scabbard share these uniforms, so
    // they dissolve TOGETHER). Hide once fully dissolved so nothing lingers over the rows.
    // CONTACT never reverses the dissolve — it zeroes it (while invisible) and fades the
    // blade's material opacity instead.
    const kdiss = cOn ? 0 : smoothstep(KDISS.in, KDISS.out, p)
    dissolve.uKDissolve.value = kdiss
    for (const m of bladeMats.current) {
      const fading = cOn && cFade < 1
      m.transparent = fading
      m.opacity = fading ? cFade : 1
    }
    heroRef.current.visible = cOn ? cFade > 0 : kdiss < 1

    // SCABBARD: glide rest → parallel target (forward), then weighted reverse on the
    // re-sheathe (STEP 1) — heavier smootherstep, same slow/deliberate feel as the blade.
    const part =
      smoothstep(PART.in, PART.out, p) - smoother(clamp01((p - PART.backIn) / (PART.backOut - PART.backIn)))
    scabbard.position.lerpVectors(scab0, cd.scabPos, part)
    scabbard.quaternion.slerpQuaternions(scabQuat0, cd.scabQuat, part)

    // POSE: diagonal hero → horizontal display, set directly from poseAmt(p). CONTACT
    // sets the tilted display pose + slow idle roll DIRECTLY (snapped while invisible).
    const poseAmt = plateau(p, POSE.in, POSE.out, POSE.backIn, POSE.backOut)
    poseRef.current.quaternion.slerpQuaternions(HERO_QUAT, cd.displayQuat, poseAmt)
    if (cOn) {
      contactSpinTmp.setFromAxisAngle(contactSpinAxis, state.clock.elapsedTime * CONTACT_SPIN)
      contactQuatTmp.copy(cd.displayQuat).premultiply(contactTiltQuat).premultiply(contactSpinTmp)
      poseRef.current.quaternion.copy(contactQuatTmp)
    }

    // HERO ROLL: at rest the whole assembly is rolled so the handle reads upper-right;
    // eases to identity as you scroll in, handing off to the untouched choreography.
    const heroAmt = 1 - smoothstep(HERO_BLEND.in, HERO_BLEND.out, p)
    heroRef.current.quaternion.slerpQuaternions(HERO_QUAT, heroRollQuat, heroAmt)

    // CLIP PLANE: hide the blade still inside the sheath. Sits at the scabbard mouth,
    // normal along the bore tangent; anchored in the scabbard's LOCAL frame so it
    // follows the scabbard. OFF during the fully-drawn display — and OFF for the whole
    // CONTACT display, where the scabbard is hidden and the bare blade must be whole.
    const clipOn = (p <= CLIP_DRAW_CLEAR || p >= CLIP_RESHEATHE) && !cOn
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

function Rig({ axesRef, progressRef, stackProgressRef }: DriveProps) {
  const { camera } = useThree()

  const focus = useMemo(() => new THREE.Vector3(), [])
  const aim = useMemo(() => new THREE.Vector3(), [])
  const heroAim = useMemo(() => new THREE.Vector3(), [])
  const contactAim = useMemo(() => new THREE.Vector3(), [])
  const box = useMemo(() => new THREE.Box3(), [])
  const boxCenter = useMemo(() => new THREE.Vector3(), [])
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

    // CENTER the katana in-frame during the transition: aim at the combined bounding-box
    // center (true visual center) instead of the node midpoint, blended in as we zoom.
    const tAmt = smoothstep(TRANS_ZOOM.in, TRANS_ZOOM.out, p)
    if (tAmt > 0.0001) {
      box.setFromObject(axes.sword)
      box.expandByObject(axes.scabbard)
      box.getCenter(boxCenter)
      aim.lerp(boxCenter, tAmt)
    }

    // CONTACT display: SNAPPED framing (no travel) — flips while the blade is still
    // invisible. Aim RIGHT of the BARE blade's own center (the scabbard is hidden
    // there) so the spinning blade sits over the left-side hexagon artwork.
    const cq = stackProgressRef?.current ?? 0
    const cAmt = cq > C_SNAP ? 1 : 0
    if (cAmt > 0) {
      box.setFromObject(axes.sword)
      box.getCenter(boxCenter)
      contactAim.copy(boxCenter).addScaledVector(WORLD_RIGHT, CONTACT_SHIFT_X)
      aim.lerp(contactAim, cAmt)
    }

    const frameAmt = plateau(p, FRAME.in, FRAME.out, FRAME.backIn, FRAME.backOut)
    const driftAmt = plateau(p, DRIFT.a, DRIFT.b, DRIFT.c, DRIFT.d)
    // Hero zoom: push IN at scroll 0, ease back to the normal offset as the draw starts.
    const zoom = THREE.MathUtils.lerp(HERO_ZOOM, 1, smoothstep(ZOOM.in, ZOOM.out, p))
    // TRANSITION zoom: dolly the camera IN over the re-sheathe (weighted) so the sheathed
    // katana grows to dominate the frame (~70%), then holds large through the pixel-out.
    const tzoom = THREE.MathUtils.lerp(
      1,
      TRANS_ZOOM_AMT,
      smoother(clamp01((p - TRANS_ZOOM.in) / (TRANS_ZOOM.out - TRANS_ZOOM.in)))
    )

    off.copy(HERO_OFF).lerp(DISPLAY_OFF, frameAmt).multiplyScalar(zoom * tzoom).addScaledVector(DRIFT_DIR, driftAmt)
    // CONTACT: ease the offset out to the final rest framing (pulled back, dead-on).
    off.lerp(CONTACT_OFF, cAmt)
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

function PetalField({
  progressRef,
  stackProgressRef,
}: {
  progressRef: React.MutableRefObject<number>
  stackProgressRef?: React.MutableRefObject<number>
}) {
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

    // Presence from scroll ONLY: faint over the hero, fuller across the about, then
    // faded out as the sword dissolves so the field clears off the clean landscape.
    // CONTACT: a sparse drift returns over the resting blade — nothing else moves.
    const p = progressRef.current
    const cq = stackProgressRef?.current ?? 0
    const presence =
      THREE.MathUtils.lerp(
        PETAL_PRESENCE.hero,
        PETAL_PRESENCE.about,
        smoothstep(PETAL_PRESENCE.in, PETAL_PRESENCE.out, p)
      ) *
        (1 - smoothstep(PETAL_FADE.in, PETAL_FADE.out, p)) +
      C_PETAL.amt * smoothstep(C_PETAL.in, C_PETAL.out, cq)
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
  stackProgressRef?: React.MutableRefObject<number> // only Scene/Progress use it
  scrollerRef?: React.MutableRefObject<HTMLElement | null> // exposes the ScrollControls scroller to the nav
}

// Runs FIRST each frame: damps the one shared progress `p` toward the RAW scroll
// (read straight off the DOM container, bypassing ScrollControls' own smoothing).
// Everything else reads progressRef.current, so all parts share a single timeline.
function Progress({
  progressRef,
  stackProgressRef,
  scrollerRef,
}: {
  progressRef: React.MutableRefObject<number>
  stackProgressRef: React.MutableRefObject<number>
  scrollerRef?: React.MutableRefObject<HTMLElement | null>
}) {
  const data = useScroll()
  useEffect(() => {
    if (scrollerRef) scrollerRef.current = data.el
  }, [data.el, scrollerRef])
  useFrame((_, dt) => {
    const el = data.el
    const raw = el ? el.scrollTop / (el.scrollHeight - el.clientHeight || 1) : 0
    // Katana arc owns raw 0 → KATANA_SCROLL (its physical scroll is unchanged); rescale so
    // remapScroll sees a full 0 → 1 across just that span.
    const katana = clamp01(remapScroll(clamp01(raw / KATANA_SCROLL)))
    progressRef.current = damp(progressRef.current, katana, PROGRESS_DAMP, dt)
    // The projects stack owns the remaining raw KATANA_SCROLL → 1.
    const stack = clamp01((raw - KATANA_SCROLL) / (1 - KATANA_SCROLL))
    stackProgressRef.current = damp(stackProgressRef.current, stack, PROGRESS_DAMP, dt)
  })
  return null
}

function Scene({ axesRef, progressRef, stackProgressRef, scrollerRef }: DriveProps) {
  return (
    <>
      {/* Two smoothed progress values (katana arc + projects stack) — updated before
          Katana & Rig read them. */}
      <Progress progressRef={progressRef} stackProgressRef={stackProgressRef!} scrollerRef={scrollerRef} />

      {/* Key light: hard, raking, defines the blade's edge. */}
      <directionalLight position={[4, 6, 5]} intensity={2.4} color="#fff6ea" />
      {/* Soft fill from the opposite side so shadows aren't crushed. */}
      <directionalLight position={[-6, 2, -3]} intensity={0.5} color="#9fb4ff" />
      {/* Gentle ambient floor. */}
      <hemisphereLight args={['#2a2a30', '#050505', 0.35]} />

      {/* Studio HDRI for real metal reflections — kept OUT of the background. */}
      <Environment preset="studio" background={false} />

      <Katana axesRef={axesRef} progressRef={progressRef} stackProgressRef={stackProgressRef} />
      <Rig axesRef={axesRef} progressRef={progressRef} stackProgressRef={stackProgressRef} />
      {/* Ambient sakura field — behind/around the sword, after Rig so it locks to
          the camera the Rig has already placed this frame. */}
      <PetalField progressRef={progressRef} stackProgressRef={stackProgressRef} />
    </>
  )
}

/* ============================================================================
 *  LandscapeLayer — the PROJECTS-zone ukiyo-e backdrop, on its OWN canvas behind
 *  the hero canvas. The image is shown CLEAN + vibrant (no glitch, no darken). It
 *  fades in behind the dissolving sword, holds, then — with a small "projects"
 *  label — does the SAME quick pixel-block dissolve to reveal the rows section.
 * ========================================================================== */

const LAND_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const LAND_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform sampler2D uLabel;
  uniform vec2 uRes;
  uniform float uImgAspect;
  uniform float uLabelAspect;
  uniform float uLabelH;   // label height (fraction of viewport)
  uniform float uReveal;   // PHASE 2: one-color glitch-IN (0 → clean landscape resolved)
  uniform float uLabelIn;  // PHASE 3: label clean blur-to-sharp
  uniform float uVanish;   // PHASE 4: one-color glitch-OUT (label + landscape vanish)
  uniform float uBlocks;   // block count (vertical)
  uniform vec3 uOutColor;  // single glitch-out tone (projects bg)
  uniform vec2 uPan;       // mouse pan offset into the cropped image margin
  varying vec2 vUv;

  float lHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float lSmoother(float t) { t = clamp(t, 0.0, 1.0); return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

  // 9-tap blur of the label texture → clean blur-to-sharp (never garbled).
  vec4 labelBlur(vec2 uv, float r) {
    vec4 s = texture2D(uLabel, uv);
    s += texture2D(uLabel, uv + vec2(r, 0.0));
    s += texture2D(uLabel, uv + vec2(-r, 0.0));
    s += texture2D(uLabel, uv + vec2(0.0, r));
    s += texture2D(uLabel, uv + vec2(0.0, -r));
    s += texture2D(uLabel, uv + vec2(r, r));
    s += texture2D(uLabel, uv + vec2(-r, -r));
    s += texture2D(uLabel, uv + vec2(r, -r));
    s += texture2D(uLabel, uv + vec2(-r, r));
    return s / 9.0;
  }

  void main() {
    float canvasAspect = uRes.x / uRes.y;
    // cover-fit the image (crop, never stretch) — CLEAN, full vibrancy.
    vec2 s = canvasAspect > uImgAspect
      ? vec2(1.0, uImgAspect / canvasAspect)
      : vec2(canvasAspect / uImgAspect, 1.0);
    // cover-fit + MOUSE PAN: slide the sampled window within the cropped margin so the
    // user can peek at the image portion cropped off each edge.
    vec2 uvc = (vUv - 0.5) * s + 0.5 + uPan;
    vec3 img = texture2D(uTex, clamp(uvc, 0.0001, 0.9999)).rgb;

    // Screen-space block grid (stable — pan doesn't move the blocks).
    vec2 cells = vec2(uBlocks * canvasAspect, uBlocks);
    vec2 cellId = floor(vUv * cells);

    // PHASE 2 glitch-IN: blocks of the IMAGE itself pop in directly (no solid-color
    // underlay) — the per-block alpha below IS the glitch.
    vec3 col = img;

    // PHASE 3 label — clean blur-to-sharp, aspect-preserved, centered.
    vec2 lsize = vec2(uLabelH * uLabelAspect / canvasAspect, uLabelH);
    vec2 luv = (vUv - 0.5) / lsize + 0.5;
    if (luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0) {
      float li = lSmoother(uLabelIn);
      vec4 lab = labelBlur(luv, (1.0 - li) * 0.03);
      col = mix(col, lab.rgb, lab.a * li);
    }

    // PHASE 4 glitch-OUT: each block flips to ONE bg color, then is removed → section.
    // vanishGate floors out the cells whose hash is ~0: without it those few cells satisfy
    // step(hash, 0) === 1 while the landscape is still clean, leaving stray frozen blocks
    // (a cream toBg square + a black gone-hole) parked on screen. Only let toBg/gone act
    // once the glitch-out is genuinely underway.
    float vanishGate = step(0.0008, uVanish);
    float toBg = step(lHash(cellId + 5.0), smoothstep(0.0, 0.85, uVanish)) * vanishGate;
    col = mix(col, uOutColor, toBg);

    // Per-block alpha: appears (in) blockwise, vanishes (out) blockwise.
    float appear = step(lHash(cellId + 3.0), smoothstep(0.0, 0.55, uReveal));
    float gone = step(lHash(cellId + 9.0), uVanish) * vanishGate;
    // Hard gate: the layer is FULLY hidden until the glitch-in actually starts, so no
    // stray hash==0 blocks leak the image over the hero / about sections.
    // (NB: do not name this var "active" — that is a reserved word in GLSL.)
    float gate = step(0.0008, uReveal);

    gl_FragColor = vec4(col, appear * (1.0 - gone) * gate);
  }
`

// Draw the "projects" intro wordmark to a canvas → texture, so it dissolves in the same
// pass as the landscape. Tight 4:1 canvas keeps the on-screen aspect correction simple.
// It reads over the BUSY dark landscape, so it is large, washi-white, and carries a soft
// baked dark halo (scrim) for legibility — and uses the SAME face as the light section's
// "Projects" header (Bricolage Grotesque). The face is web-loaded, so callers redraw once
// document.fonts is ready (see LandscapeQuad); a system fallback is used until then.
const LABEL_CANVAS_ASPECT = 2048 / 512
const LABEL_FONT = "700 320px 'Bricolage Grotesque', system-ui, -apple-system, sans-serif"
function drawLabel(c: HTMLCanvasElement, text: string) {
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = LABEL_FONT
  ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '6px'
  const x = c.width / 2
  const y = c.height / 2 + 8
  ctx.fillStyle = '#ECE8E1' // washi — light text against the dark mountains
  // ONE soft, tight scrim pass — enough to hold over the busy image without the
  // muddy blob a heavy double-pass halo left behind.
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = 22
  ctx.shadowOffsetY = 4
  ctx.fillText(text, x, y)
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0
  ctx.fillText(text, x, y) // crisp light text on top
}
function makeLabelTexture(text: string) {
  const c = document.createElement('canvas')
  c.width = 2048
  c.height = 512
  drawLabel(c, text)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace // raw passthrough — matches the landscape layer
  t.needsUpdate = true
  return t
}

function LandscapeQuad({ progressRef }: { progressRef: React.MutableRefObject<number> }) {
  const tex = useTexture(LANDSCAPE_URL)
  const { size } = useThree()

  useMemo(() => {
    // RAW passthrough: NoColorSpace ⇒ the GPU does NOT linearize on sample, and the raw
    // ShaderMaterial writes the value straight out ⇒ the canvas shows the EXACT file colors.
    tex.colorSpace = THREE.NoColorSpace
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.needsUpdate = true
  }, [tex])

  const labelTex = useMemo(() => makeLabelTexture('Projects'), [])

  // The label face (Bricolage Grotesque) is web-loaded; redraw the texture once it's ready
  // so the intro wordmark matches the light section's "Projects" header exactly.
  useEffect(() => {
    let alive = true
    const redraw = () => {
      if (!alive) return
      drawLabel(labelTex.image as HTMLCanvasElement, 'Projects')
      labelTex.needsUpdate = true
    }
    document.fonts.load("700 320px 'Bricolage Grotesque'").then(redraw, redraw)
  }, [labelTex])

  const uniforms = useMemo(
    () => ({
      uTex: { value: tex },
      uLabel: { value: labelTex },
      uRes: { value: new THREE.Vector2(1, 1) },
      uImgAspect: { value: LAND_IMG_ASPECT },
      uLabelAspect: { value: LABEL_CANVAS_ASPECT },
      uLabelH: { value: 0.18 }, // large, prominent centered intro label
      uReveal: { value: 0 },
      uLabelIn: { value: 0 },
      uVanish: { value: 0 },
      uBlocks: { value: LAND_BLOCKS },
      // raw sRGB value (LinearSRGBColorSpace = stored as-is) so the glitch-out tone
      // matches the #0A0A0A rows bg exactly.
      uOutColor: { value: new THREE.Color().setStyle(LAND_OUT_COLOR, THREE.LinearSRGBColorSpace) },
      uPan: { value: new THREE.Vector2(0, 0) },
    }),
    [tex, labelTex]
  )

  // Mouse position in [-1,1] (left/bottom = -1) — drives the pan toward the cropped edges.
  const mouse = useMemo(() => new THREE.Vector2(0, 0), [])
  const panTarget = useMemo(() => new THREE.Vector2(0, 0), [])
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mouse.set((e.clientX / window.innerWidth) * 2 - 1, 1 - (e.clientY / window.innerHeight) * 2)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [mouse])

  useFrame((_, dt) => {
    const p = progressRef.current
    uniforms.uRes.value.set(size.width, size.height)
    uniforms.uReveal.value = smoothstep(LAND_REVEAL.in, LAND_REVEAL.out, p)
    uniforms.uLabelIn.value = smoothstep(LABEL_IN.in, LABEL_IN.out, p)
    uniforms.uVanish.value = smoothstep(LAND_VANISH.in, LAND_VANISH.out, p)

    // Pan within the cropped margin only — and only while the clean landscape is up.
    const aspect = size.width / size.height
    const sx = aspect > LAND_IMG_ASPECT ? 1 : aspect / LAND_IMG_ASPECT
    const sy = aspect > LAND_IMG_ASPECT ? LAND_IMG_ASPECT / aspect : 1
    const marginX = (1 - sx) * 0.5 * PAN_STRENGTH
    const marginY = (1 - sy) * 0.5 * PAN_STRENGTH
    const live = uniforms.uReveal.value * (1 - uniforms.uVanish.value)
    panTarget.set(mouse.x * marginX * live, mouse.y * marginY * live)
    uniforms.uPan.value.lerp(panTarget, 1 - Math.exp(-6 * dt)) // frame-rate-independent ease
  })

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={LAND_VERT}
        fragmentShader={LAND_FRAG}
        transparent
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  )
}

function LandscapeLayer({ progressRef }: { progressRef: React.MutableRefObject<number> }) {
  return (
    <Canvas
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', zIndex: 2, pointerEvents: 'none' }}
      flat
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: false }}
      camera={{ position: [0, 0, 1] }}
    >
      <Suspense fallback={null}>
        <LandscapeQuad progressRef={progressRef} />
      </Suspense>
    </Canvas>
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

/* ---- PROJECTS (STAGE 2 — LIGHT click-accordion, reference redesign) ----------
 * A cream (#f4f1ea) section in the reference's minimal style. The list holds all four
 * projects in 01→04 order; exactly ONE is expanded at a time (an in-place accordion):
 * the open row shows the full card (description · stack · key features · media · live
 * demo), the rest stay as compact rows (number · name · tagline · View →). Clicking a
 * collapsed row opens it and the previously-open one folds back. Height animates with the
 * grid-template-rows 0fr↔1fr trick on the site's weighted easing. The whole section is
 * pointer-events-none so the wheel still drives the katana scroll; only the row buttons +
 * live-demo links opt back in. Driven by React state, not scroll. */
type Project = {
  num: string
  name: string
  tagline: string // one-line summary shown in the collapsed row
  status?: string // tiny mono badge in the row (e.g. LIVE) — gold, instrument-panel style
  description: string
  stack: string[]
  features: string[]
  href: string
  video?: string // looping demo clip; when set, replaces the striped placeholder
}

const PROJECTS: Project[] = [
  {
    num: '01',
    name: 'Retain AI',
    tagline: 'Multi-agent churn-retention engine',
    description:
      'A multi-agent retention engine that predicts churn and orchestrates win-back campaigns — an 18-node LangGraph pipeline running at zero inference cost.',
    stack: ['Python', 'LangGraph', 'ChromaDB', 'FastAPI', 'Gemini Flash', 'Groq'],
    features: [
      '18-node LangGraph multi-agent pipeline: churn prediction → intervention orchestration',
      'Cox proportional-hazards survival analysis for churn-risk modeling',
      'Monte Carlo simulation for campaign-outcome forecasting',
      'Signal-aware RAG over ChromaDB',
      '$0 inference cost via intelligent Gemini Flash / Groq routing',
    ],
    href: '#',
  },
  {
    num: '02',
    name: 'Nextflow',
    tagline: 'Visual node-based AI workflow builder',
    description:
      'A visual, node-based AI workflow builder with a custom DAG execution engine — wire nodes together and run distributed, durable workflows.',
    stack: ['Next.js', 'TypeScript', 'React Flow', 'Trigger.dev', 'PostgreSQL', 'Redis'],
    features: [
      'Custom DAG execution engine with topological scheduling (BFS/DFS)',
      'Visual node editor built on React Flow',
      'Distributed, durable execution on Trigger.dev',
      'Partial re-execution caching — only re-runs changed nodes',
      'Distributed state management across the graph',
    ],
    href: '#',
  },
  {
    num: '03',
    name: 'Orbyt',
    tagline: 'OpenAI-compatible multi-provider LLM gateway',
    description:
      'An OpenAI-compatible LLM gateway that unifies multiple providers behind one API, with Redis-backed key orchestration and a pluggable adapter layer.',
    stack: ['TypeScript', 'Node.js', 'Redis', 'PostgreSQL'],
    features: [
      'OpenAI-compatible API surface — drop-in replacement',
      'Redis-backed API-key orchestration & rotation',
      'Provider adapter layer built on the open/closed principle (add providers without touching core)',
      'Unified multi-provider routing',
    ],
    href: '#',
  },
  {
    num: '04',
    name: 'Archon',
    tagline: 'Gamified productivity & identity engine',
    status: 'LIVE',
    description:
      'A gamified productivity OS — notes, whiteboards, a VS Code sandbox, and deep-work timers fused into one Identity Engine that turns daily consistency into XP, levels, and live analytics.',
    stack: ['Next.js 16', 'TypeScript', 'PostgreSQL', 'Prisma 7', 'Python FastAPI', 'Gemini'],
    features: [
      'Identity Engine — sessions, problems, and tasks stream into XP + an 11-tier progression (Initiate → Legend)',
      'Universal ⌘K semantic search across 9 entity types — hand-rolled vector layer, no external DB',
      'Block editor + infinite whiteboards + physics-based knowledge graph',
      'Monaco (VS Code) sandbox with live Codeforces rating sync',
      'Polyglot core — Next.js 16 on Vercel + Python FastAPI analytics on Railway',
    ],
    href: 'https://achron.vercel.app',
    video: '/Achron.mp4',
  },
]

// Weighted expand/collapse easing — the same "heavy settle" used across the katana arc.
const ACC_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'

// The reference's media placeholder: a 135° hatched fill (utilities can't express the
// repeating-linear-gradient cleanly, so it's an inline style object per house rules).
const STRIPE_FILL: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(135deg, transparent, transparent 9px, #c4bca8 9px, #c4bca8 10px)',
  opacity: 0.5,
}

/* One accordion item. The header row (number · name · tagline · View) is always present
 * and clickable; the expanded body (description · stack · key features · media · live demo)
 * is height-animated via the grid-template-rows 0fr↔1fr trick so it expands/collapses on the
 * site's weighted easing without a JS height measure. */
function ProjectRow({ project, active, onOpen }: { project: Project; active: boolean; onOpen: () => void }) {
  return (
    <div className="border-b border-sumi/12 first:border-t first:border-sumi/12">
      {/* header row — always visible, the only scroll-blocking hit target is the button */}
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={active}
        className="group pointer-events-auto flex w-full items-center gap-5 py-[2.5vh] text-left"
      >
        <span
          className={`w-8 shrink-0 font-mono text-[0.82rem] font-semibold tabular-nums transition-colors duration-500 ${active ? 'text-workgold' : 'text-[#9a9488] group-hover:text-workgold'}`}
        >
          {project.num}
        </span>
        <h3
          className="shrink-0 font-grotesk font-semibold leading-none tracking-[-0.02em] text-sumi transition-[font-size,transform] duration-500 group-hover:translate-x-1"
          style={{ fontSize: active ? 'clamp(2rem,4.4vw,3.25rem)' : '1.6rem', transitionTimingFunction: ACC_EASE }}
        >
          {project.name}
        </h3>
        {project.status && (
          <span
            className={`shrink-0 rounded-full border border-workgold/45 px-2.5 py-0.5 font-mono text-[0.56rem] font-semibold tracking-[0.2em] text-workgold transition-opacity duration-300 ${active ? 'opacity-0' : 'opacity-100'}`}
          >
            {project.status}
          </span>
        )}
        <span
          className={`flex-1 truncate text-[0.92rem] text-[#8a8478] transition-colors duration-300 group-hover:text-[#5a564c] ${active ? 'opacity-0' : 'opacity-100'}`}
        >
          {project.tagline}
        </span>
        <span
          className={`shrink-0 font-mono text-[0.78rem] font-semibold text-workgold transition-opacity duration-300 ${active ? 'opacity-0' : 'opacity-100'}`}
        >
          View{' '}
          <span aria-hidden className="inline-block transition-transform duration-300 group-hover:translate-x-1">
            →
          </span>
        </span>
      </button>

      {/* expanded body — grid-rows trick: 0fr (collapsed) ↔ 1fr (open), always mounted */}
      <div
        className="grid transition-[grid-template-rows] duration-700"
        style={{ gridTemplateRows: active ? '1fr' : '0fr', transitionTimingFunction: ACC_EASE }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="grid grid-cols-1 gap-7 pb-[2.4vh] pt-0.5 md:grid-cols-[1fr_1.15fr] md:gap-10">
            {/* left — description · stack chips · key features · live demo */}
            <div className="flex flex-col">
              <p className="max-w-[460px] text-[clamp(0.9rem,1.1vw,1.02rem)] leading-[1.55] text-[#48443c]">
                {project.description}
              </p>

              <div className="mb-2 mt-4 font-mono text-[0.6rem] font-medium tracking-[0.22em] text-workgold">
                STACK
              </div>
              <div className="flex flex-wrap gap-2">
                {project.stack.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-sumi/5 px-3 py-1.5 font-hanken text-[0.72rem] font-medium text-[#5a564c]"
                  >
                    {t}
                  </span>
                ))}
              </div>

              <div className="mt-4 border-t border-sumi/12 pt-3.5">
                <div className="mb-2 font-mono text-[0.6rem] font-medium tracking-[0.22em] text-workgold">
                  KEY FEATURES
                </div>
                <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
                  {project.features.map((f) => (
                    <li key={f} className="flex gap-2 text-[0.78rem] leading-[1.45] text-[#5a564c]">
                      <span className="shrink-0 text-workgold/70">›</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <a
                href={project.href}
                target={project.href.startsWith('http') ? '_blank' : undefined}
                rel={project.href.startsWith('http') ? 'noreferrer' : undefined}
                className="group/demo pointer-events-auto mt-5 inline-flex w-fit items-center gap-2 rounded-full bg-sumi px-5 py-2.5 font-hanken text-[0.82rem] font-semibold text-paper transition-transform hover:-translate-y-0.5"
              >
                Live demo{' '}
                <span aria-hidden className="inline-block transition-transform duration-300 group-hover/demo:translate-x-1">
                  →
                </span>
              </a>
            </div>

            {/* right — demo media. A real looping clip when `project.video` is set;
                otherwise the striped "demo reel" placeholder (reference styling). */}
            <div className="relative aspect-[4/3] overflow-hidden rounded-[14px] bg-[#e7e2d6] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] md:aspect-auto md:h-[33vh]">
              {project.video ? (
                <video
                  className="absolute inset-0 h-full w-full object-cover"
                  src={project.video}
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              ) : (
                <>
                  <div className="absolute inset-0" style={STRIPE_FILL} />
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5">
                    <span className="grid h-[62px] w-[62px] place-items-center rounded-full bg-sumi">
                      <span className="ml-[3px] block h-0 w-0 border-y-[9px] border-l-[15px] border-y-transparent border-l-paper" />
                    </span>
                    <span className="rounded-md bg-paper/80 px-2.5 py-1 font-mono text-[0.62rem] tracking-[0.2em] text-[#8a8276]">
                      {project.num} — DEMO REEL
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* The LIGHT projects section (reference redesign). Rendered as TWO fixed layers:
 *   • paperRef — a cream BACKDROP at z-1. It fades in early (PAPER_IN), hidden behind the
 *     still-opaque landscape, so the glitch-out's vanishing blocks reveal cream, not the
 *     dark body. This is what the dissolve resolves into.
 *   • rowsRef — the interactive CONTENT at z-40, ABOVE the 3D canvas so its row buttons +
 *     live-demo links actually receive clicks (the canvas/ScrollControls scroller otherwise
 *     swallows them). It stays pointer-events-none so the wheel still drives the katana
 *     scroll; only the buttons/links opt back in. `headerRef` gets the blur-to-sharp focus
 *     pull. Both layers' opacity is driven by the App tick. */
function ProjectsSection({
  paperRef,
  rowsRef,
  headerRef,
}: {
  paperRef: React.RefObject<HTMLDivElement>
  rowsRef: React.RefObject<HTMLDivElement>
  headerRef: React.RefObject<HTMLDivElement>
}) {
  const [active, setActive] = useState(0) // exactly one open; project 01 starts expanded

  return (
    <>
      {/* cream reveal target — the dissolve resolves into this */}
      <div ref={paperRef} style={{ opacity: 0 }} className="fixed inset-0 z-[1] bg-paper pointer-events-none" />

      {/* interactive content — above the canvas so clicks land */}
      <div
        ref={rowsRef}
        style={{ opacity: 0 }}
        className="fixed inset-0 z-40 flex flex-col overflow-hidden px-[7vw] pb-[3vh] pt-20 md:pt-24 font-hanken text-sumi pointer-events-none"
      >
        {/* heading — eyebrow · Projects · right-aligned index blurb (sharpens in via headerRef) */}
        <div
          ref={headerRef}
          style={{ opacity: 0 }}
          className="flex shrink-0 flex-wrap items-end justify-between gap-6 border-t border-sumi/12 pt-5"
        >
          <div>
            <div className="mb-2.5 font-mono text-[0.72rem] font-semibold tracking-[0.22em] text-workgold">
              鍛 — SELECTED WORK / 2025
            </div>
            <h2 className="font-grotesk text-[clamp(2.4rem,6vw,4.4rem)] font-semibold leading-[0.92] tracking-[-0.03em]">
              Projects
            </h2>
          </div>
          <p className="max-w-[300px] pb-2 text-right text-[0.92rem] leading-[1.6] text-[#6f6a5f]">
            A short index of things I've designed, shipped, and forged — mostly AI systems built end-to-end.
          </p>
        </div>

        {/* accordion list — 01→04, exactly one expanded */}
        <div className="mt-[2vh] flex min-h-0 flex-1 flex-col">
          {PROJECTS.map((project, i) => (
            <ProjectRow key={project.num} project={project} active={i === active} onOpen={() => setActive(i)} />
          ))}
        </div>
      </div>
    </>
  )
}

/* ---- CONTACT (STAGE 3 — the bare blade, displayed) ----------------------------
 * The closing frame, on the dark night tone. TWO fixed layers driven by the App tick:
 *   • nightRef (z-2, behind the canvas) — the night backdrop + the SHARP-EDGED hexagon
 *     of the sakura tree art on the LEFT half, under the spinning blade.
 *   • layerRef (z-45, above the canvas) — the full contact stack on the RIGHT half, so
 *     the email button / social icons / form actually receive events;
 *     pointer-events-none at the layer, interactive elements opt back in.
 * headRef/bodyRef/footRef get the site's shared blur-to-sharp focus pull, sequenced
 * header → content → corners — all driven by the App tick off q. */
const CONTACT_EMAIL = 'hello@example.com' // PLACEHOLDER — real address supplied later

// Sharp hexagon crop for the sakura art (pointy-top). Utilities can't express the
// polygon cleanly, so it's an inline style object per house rules.
const HEX_CLIP: React.CSSProperties = {
  clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
}

// Social icons — inline SVG paths (simple-icons geometry), filled with currentColor.
const CONTACT_SOCIALS = [
  {
    label: 'GITHUB',
    href: '#', // PLACEHOLDER
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
  {
    label: 'LINKEDIN',
    href: '#', // PLACEHOLDER
    path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
  },
] // PLACEHOLDER hrefs — supplied later
const CONTACT_RESUME_HREF = '#' // PLACEHOLDER

const FIELD_LABEL = 'font-mono text-[0.62rem] tracking-[0.28em] uppercase text-washi/45'
const FIELD_INPUT =
  'pointer-events-auto mt-2 w-full rounded-none border-b border-washi/20 bg-transparent py-2 font-hanken text-[0.95rem] text-washi outline-none transition-colors duration-300 focus:border-gold'

type ContactRefs = {
  nightRef: React.RefObject<HTMLDivElement>
  layerRef: React.RefObject<HTMLDivElement>
  headRef: React.RefObject<HTMLDivElement>
  bodyRef: React.RefObject<HTMLDivElement>
  footRef: React.RefObject<HTMLDivElement>
}

function ContactSection({ nightRef, layerRef, headRef, bodyRef, footRef }: ContactRefs) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const copyEmail = () => {
    navigator.clipboard?.writeText(CONTACT_EMAIL).catch(() => {})
    setCopied(true)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <>
      {/* night backdrop + LEFT hexagon — behind the canvas, under the spinning blade */}
      <div ref={nightRef} style={{ opacity: 0 }} className="fixed inset-0 z-[2] bg-night pointer-events-none">
        <div
          className="absolute left-[7vw] top-1/2 -translate-y-1/2 w-[min(36vw,58vh)] aspect-[0.866]"
          style={HEX_CLIP}
        >
          <div className="absolute inset-0 bg-[url('/Sakura_tree_bg.png')] bg-cover bg-center" />
          {/* faint dark wash so the blade reads over the busy art */}
          <div className="absolute inset-0 bg-night/30" />
        </div>
      </div>

      {/* RIGHT — the full contact stack, above the canvas so events land */}
      <div
        ref={layerRef}
        style={{ visibility: 'hidden' }}
        className="fixed inset-0 z-[45] pointer-events-none font-hanken text-washi"
      >
        <div className="absolute inset-y-0 right-0 flex w-full flex-col justify-center gap-11 px-[7vw] md:w-[52vw] md:pl-0 md:pr-[6vw]">
          {/* header — same eyebrow/headline pattern as the other sections */}
          <div ref={headRef} style={{ opacity: 0 }}>
            <div className="font-mono text-[0.72rem] tracking-[0.24em] uppercase text-gold">
              結 — THE BLADE RESTS
            </div>
            <h2 className="mt-3 font-display font-black leading-[0.9] tracking-[-0.03em] text-washi text-[clamp(2.8rem,6.5vw,5.5rem)]">
              Contact
            </h2>
          </div>

          <div ref={bodyRef} style={{ opacity: 0 }} className="flex flex-col gap-10">
            {/* primary — email, click-to-copy */}
            <button type="button" onClick={copyEmail} className="pointer-events-auto group w-fit text-left">
              <span
                className={`block font-mono text-[0.62rem] tracking-[0.28em] uppercase transition-colors duration-300 ${copied ? 'text-gold' : 'text-washi/45'}`}
              >
                {copied ? 'COPIED ✓' : 'EMAIL — CLICK TO COPY'}
              </span>
              <span className="mt-2 block font-display font-bold tracking-[-0.02em] text-washi transition-colors duration-300 group-hover:text-gold text-[clamp(1.4rem,2.6vw,2.3rem)]">
                {CONTACT_EMAIL}
              </span>
            </button>

            {/* socials — icons + resume */}
            <div className="flex items-center gap-7">
              {CONTACT_SOCIALS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  aria-label={s.label}
                  className="pointer-events-auto text-washi/60 transition-colors duration-300 hover:text-gold"
                >
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden>
                    <path d={s.path} />
                  </svg>
                </a>
              ))}
              <a
                href={CONTACT_RESUME_HREF}
                className="pointer-events-auto font-mono text-[0.68rem] tracking-[0.22em] text-washi/60 transition-colors duration-300 hover:text-gold"
              >
                RESUME (PDF)
              </a>
            </div>

            <div className="h-px bg-washi/10" />

            {/* the form — visual only in this stage; wiring lands in Stage 2 */}
            <form className="flex flex-col gap-7" onSubmit={(e) => e.preventDefault()}>
              <div className="grid gap-7 sm:grid-cols-2">
                <label className="block">
                  <span className={FIELD_LABEL}>NAME</span>
                  <input type="text" name="name" autoComplete="name" className={FIELD_INPUT} />
                </label>
                <label className="block">
                  <span className={FIELD_LABEL}>EMAIL</span>
                  <input type="email" name="email" autoComplete="email" className={FIELD_INPUT} />
                </label>
              </div>
              <label className="block">
                <span className={FIELD_LABEL}>MESSAGE</span>
                <textarea name="message" rows={3} className={`${FIELD_INPUT} resize-none`} />
              </label>
              <button
                type="submit"
                className="pointer-events-auto mt-1 w-fit rounded-none border border-gold px-10 py-3 font-mono text-[0.68rem] tracking-[0.3em] uppercase text-gold transition-colors duration-300 hover:bg-gold hover:text-night"
              >
                SEND
              </button>
            </form>
          </div>
        </div>

        {/* corners + footer — the hero's instrument-panel language, closing the loop */}
        <div ref={footRef} style={{ opacity: 0 }} className="absolute inset-0">
          <div className={`absolute bottom-6 left-6 md:bottom-10 md:left-10 ${MONO}`}>SEC.04 — REST</div>
          <div className={`absolute bottom-6 right-6 md:bottom-10 md:right-10 text-right ${MONO}`}>
            BLADE AT REST <span className="text-gold ml-1">結</span>
          </div>
          <div className="absolute bottom-[2.5vh] left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[0.56rem] tracking-[0.2em] uppercase text-washi/35">
            © 2026 ABHAYANTH K · FORGED WITH NEXT.JS + R3F
          </div>
        </div>
      </div>
    </>
  )
}

/* One copy of the sticky top bar in a given theme. Three are stacked + crossfaded so the
 * bar reads on the dark hero/about, the cream projects section, AND the dark contact
 * close — each copy highlighting its own section's pill. Pills navigate: they TELEPORT
 * the scroller to their section (all copies share the handler, so whichever copy is on
 * top catches the click). */
function TopBarInner({
  tone,
  active,
  onNav,
}: {
  tone: 'dark' | 'light'
  active: 'about' | 'projects' | 'contact'
  onNav: (target: NavTarget) => void
}) {
  const dark = tone === 'dark'
  const grad = dark ? 'from-ink/70 via-ink/25' : 'from-paper/80 via-paper/30'
  const mark = dark ? 'text-gold' : 'text-workgold'
  const idle = dark ? 'border-washi/15 text-washi/70' : 'border-sumi/15 text-sumi/70'
  const hot = dark ? 'border-gold/50 text-gold' : 'border-workgold/60 text-workgold'
  const pill = (name: typeof active) => `${PILL} cursor-pointer ${active === name ? hot : idle}`
  return (
    <div className={`bg-linear-to-b ${grad} to-transparent`}>
      <div className="flex items-center justify-between px-6 md:px-10 h-16 md:h-20">
        <button
          type="button"
          onClick={() => onNav('top')}
          className={`text-2xl leading-none ${mark} pointer-events-auto select-none cursor-pointer`}
        >
          鍛
        </button>
        <nav className="flex gap-1.5 pointer-events-auto">
          <button type="button" onClick={() => onNav('about')} className={pill('about')}>
            About
          </button>
          <button type="button" onClick={() => onNav('projects')} className={pill('projects')}>
            Projects
          </button>
          <button type="button" onClick={() => onNav('contact')} className={pill('contact')}>
            Contact
          </button>
        </nav>
      </div>
    </div>
  )
}

export default function App() {
  const axesRef = useRef<Axes | null>(null)
  const progressRef = useRef(0)
  const stackProgressRef = useRef(0) // damped projects scroll-stack progress (q)
  const scrollerRef = useRef<HTMLElement | null>(null) // ScrollControls scroller (set by Progress)

  // NAV: TELEPORT to a section — snap the scroller to its raw fraction AND snap the two
  // damped progress values to the exact state that fraction maps to, so the section
  // appears instantly with no scroll-through / catch-up animation. Mirrors the damping
  // math in <Progress/> (its next frame then damps from an already-correct value ⇒ no move).
  const navTo = (target: NavTarget) => {
    const el = scrollerRef.current
    if (!el) return
    const raw = NAV_RAW[target]
    el.scrollTop = raw * (el.scrollHeight - el.clientHeight)
    progressRef.current = clamp01(remapScroll(clamp01(raw / KATANA_SCROLL)))
    stackProgressRef.current = clamp01((raw - KATANA_SCROLL) / (1 - KATANA_SCROLL))
  }

  const backdropRef = useRef<HTMLDivElement>(null) // sakura layer
  const nameLayerRef = useRef<HTMLDivElement>(null) // wordmark layer
  const hudRef = useRef<HTMLDivElement>(null) // tagline / nav / corners
  const pctRef = useRef<HTMLSpanElement>(null)
  const progressFillRef = useRef<HTMLSpanElement>(null) // live scroll rail fill
  const instrumentRef = useRef<HTMLDivElement>(null) // persistent panel — theme-aware ink
  const railTrackRef = useRef<HTMLSpanElement>(null) // scroll rail track — theme-aware

  // ABOUT overlay refs (STAGE 1) — fade/scale in place, driven below.
  const concentrateRef = useRef<HTMLDivElement>(null)
  const scrollCueRef = useRef<HTMLDivElement>(null)
  const aboutRef = useRef<HTMLDivElement>(null)
  const beatRefs = useRef<(HTMLDivElement | null)[]>([])

  // STAGE 2 transition + projects refs.
  const aboutLayerRef = useRef<HTMLDivElement>(null) // about overlay, faded out as the zone begins
  const paperRef = useRef<HTMLDivElement>(null) // cream backdrop (z-1) — the dissolve's reveal target
  const rowsRef = useRef<HTMLDivElement>(null) // LIGHT projects content (z-40), revealed as the landscape dissolves
  const projectsHeaderRef = useRef<HTMLDivElement>(null) // section heading — shared blur-to-sharp focus pull
  // Top bar crossfade: a dark copy (hero/about), a light copy (cream projects), and a
  // dark CONTACT copy — opacity-swapped as each section lands so the bar stays legible.
  const barDarkRef = useRef<HTMLDivElement>(null)
  const barLightRef = useRef<HTMLDivElement>(null)
  const barContactRef = useRef<HTMLDivElement>(null)

  // STAGE 3 — CONTACT refs (night backdrop + hexagon, and the contact stack).
  const contactNightRef = useRef<HTMLDivElement>(null)
  const contactLayerRef = useRef<HTMLDivElement>(null)
  const contactHeadRef = useRef<HTMLDivElement>(null)
  const contactBodyRef = useRef<HTMLDivElement>(null)
  const contactFootRef = useRef<HTMLDivElement>(null)

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
      // Scroll readout tracks the WHOLE page (hero → contact), not just the katana arc —
      // read straight off the scroller so 100% means the actual end of the site.
      const scrollEl = scrollerRef.current
      const rawAll = scrollEl ? scrollEl.scrollTop / (scrollEl.scrollHeight - scrollEl.clientHeight || 1) : 0
      if (pctRef.current) pctRef.current.textContent = `${Math.round(clamp01(rawAll) * 100)}`.padStart(3, '0')
      if (progressFillRef.current) progressFillRef.current.style.height = `${clamp01(rawAll) * 100}%`

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

      // STAGE 2 — about beats clear as the zone begins; the LIGHT projects section is
      // revealed (fades in BEHIND the landscape) as the landscape pixel-dissolves away.
      if (aboutLayerRef.current)
        aboutLayerRef.current.style.opacity = `${1 - smoothstep(ABOUT_CLEAR.in, ABOUT_CLEAR.out, p)}`
      // STAGE 3 — CONTACT (driven by q, the appended stack progress): the projects rows
      // clear off the cream, the NIGHT layer + hexagon crossfade over it, then the
      // contact content focus-pulls in sequence (header → body → corners).
      const q = stackProgressRef.current
      const cClear = smoothstep(C_CLEAR.in, C_CLEAR.out, q)

      // Cream backdrop fills in early (hidden behind the opaque landscape) so the glitch-out
      // reveals cream — it holds; the night layer simply crossfades OVER it for contact.
      if (paperRef.current) paperRef.current.style.opacity = `${smoothstep(PAPER_IN.in, PAPER_IN.out, p)}`
      if (contactNightRef.current)
        contactNightRef.current.style.opacity = `${smoothstep(C_NIGHT.in, C_NIGHT.out, q)}`
      if (rowsRef.current) {
        rowsRef.current.style.opacity = `${smoothstep(ROWS_IN.in, ROWS_IN.out, p) * (1 - cClear)}`
        // Gate interactivity: visibility:hidden also blocks the z-40 buttons from swallowing
        // wheel/clicks over the hero/about (where the section is invisible), so the katana
        // scroll stays intact until the projects section has actually landed — and again
        // once the contact zone has taken over.
        rowsRef.current.style.visibility = p > 0.985 && cClear < 0.5 ? 'visible' : 'hidden'
      }

      // Section heading sharpens in with the section (same blur-to-sharp focus pull as About).
      driveFocus(projectsHeaderRef.current, smoothstep(ROWS_IN.in, ROWS_IN.out, p))

      // CONTACT content: sequenced focus-pulls over the held paper.
      driveFocus(contactHeadRef.current, smoothstep(C_HEAD.in, C_HEAD.out, q))
      driveFocus(contactBodyRef.current, smoothstep(C_BODY.in, C_BODY.out, q))
      driveFocus(contactFootRef.current, smoothstep(C_FOOT.in, C_FOOT.out, q))
      // Same interactivity gate as the projects rows: the z-45 layer only exists once
      // the contact zone is actually on screen.
      if (contactLayerRef.current)
        contactLayerRef.current.style.visibility = q > 0.38 ? 'visible' : 'hidden'

      // Top bar theme: dark (hero/about) → light (projects) → dark again with the
      // Contact pill hot (night contact) — copies crossfaded per section. The light
      // copy waits for the glitch-out (LAND_VANISH) so its paper gradient NEVER shows
      // as a white band over the dark landscape/label moment.
      const lit = smoothstep(LAND_VANISH.in, ROWS_IN.out, p)
      const nightIn = smoothstep(C_NIGHT.in, C_NIGHT.out, q)
      if (barDarkRef.current) barDarkRef.current.style.opacity = `${1 - lit}`
      if (barLightRef.current) barLightRef.current.style.opacity = `${lit * (1 - nightIn)}`
      if (barContactRef.current) barContactRef.current.style.opacity = `${lit * nightIn}`

      // Instrument panel ink follows the section theme (washi on dark, sumi on cream) so
      // the scroll rail stays visible over the light projects section too.
      const panelLight = lit * (1 - nightIn) > 0.5
      if (instrumentRef.current)
        instrumentRef.current.style.color = panelLight ? 'rgba(28,26,22,0.5)' : 'rgba(236,232,225,0.25)'
      if (railTrackRef.current)
        railTrackRef.current.style.backgroundColor = panelLight ? 'rgba(28,26,22,0.16)' : 'rgba(236,232,225,0.12)'

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

      {/* Layer 1 — LIGHT PROJECTS section (reference redesign), revealed BEHIND the landscape
          as it pixel-dissolves to cream. Click-accordion; z-1 so the dissolve reveals it
          cleanly; pointer-events-none so the wheel still drives the katana scroll (only the
          row buttons + live-demo links opt back in). */}
      <ProjectsSection paperRef={paperRef} rowsRef={rowsRef} headerRef={projectsHeaderRef} />

      {/* Layer 1.2 — CONTACT (STAGE 3): the night close. Backdrop + hexagon at z-2 (under
          the spinning blade on the canvas, z-3); the contact stack at z-45. */}
      <ContactSection
        nightRef={contactNightRef}
        layerRef={contactLayerRef}
        headRef={contactHeadRef}
        bodyRef={contactBodyRef}
        footRef={contactFootRef}
      />

      {/* Layer 2 — CLEAN, vibrant PROJECTS landscape (own canvas). Transparent until
          the zone; fades in behind the dissolving sword, then pixel-dissolves itself. */}
      <LandscapeLayer progressRef={progressRef} />

      {/* Layer 3 — the 3D scene (transparent so what's behind shows through). The sword
          pixel-dissolves in its own band to reveal the clean landscape behind it. */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 3 }}>
        <Canvas
          style={{ width: '100%', height: '100%' }}
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
            <ScrollControls pages={TOTAL_PAGES}>
              <Scene
                axesRef={axesRef}
                progressRef={progressRef}
                stackProgressRef={stackProgressRef}
                scrollerRef={scrollerRef}
              />
            </ScrollControls>
          </Suspense>
        </Canvas>
      </div>

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
          driven by the shared progress. ABOVE the canvas, never rises. The whole layer
          fades out as the pixel zone begins (handing off to Projects). */}
      <div ref={aboutLayerRef} className="fixed inset-0 z-20 pointer-events-none text-washi">
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
          corners always carry low-contrast detail instead of bare black. THEME-AWARE: its
          ink swaps washi ↔ sumi (driven by the tick) so it stays visible on the cream
          projects section as well as the dark hero/contact. */}
      <div
        ref={instrumentRef}
        className="fixed inset-0 z-[15] pointer-events-none font-mono select-none transition-colors duration-500"
        style={{ color: 'rgba(236,232,225,0.25)' }}
      >
        {/* left edge — section label + faint vertical kanji column */}
        <div className="absolute left-[1.6vw] top-1/2 -translate-y-1/2 flex items-center gap-4 [writing-mode:vertical-rl] rotate-180">
          <span className="text-[0.6rem] tracking-[0.5em] uppercase">Sec.01 — Forge</span>
          <span className="text-base tracking-[0.4em] text-gold/20">鍛 鍛 鍛</span>
        </div>
        {/* right edge — live scroll-progress rail + numeric readout */}
        <div className="absolute right-[1.7vw] top-1/2 -translate-y-1/2 flex flex-col items-center gap-3">
          <span className="text-[0.55rem] tracking-[0.4em] uppercase [writing-mode:vertical-rl]">Scroll</span>
          <span
            ref={railTrackRef}
            className="relative block w-px h-28 overflow-hidden transition-colors duration-500"
            style={{ backgroundColor: 'rgba(236,232,225,0.12)' }}
          >
            <span ref={progressFillRef} className="absolute inset-x-0 top-0 bg-gold/45" style={{ height: '0%' }} />
          </span>
          <span className="text-[0.58rem] tracking-[0.15em] tabular-nums">
            <span ref={pctRef}>000</span>%
          </span>
        </div>
      </div>

      {/* Sticky top bar — monogram (LEFT) + nav (RIGHT). Fixed across the ENTIRE scroll
          (hero → about → projects). Two stacked copies — a DARK one (default) and a LIGHT
          one — crossfade as the cream projects section lands, so the bar stays legible on
          either theme. The wordmark + tagline live in the hero and scroll away. */}
      <header className="fixed top-0 inset-x-0 z-50 pointer-events-none">
        <div ref={barDarkRef} className="absolute inset-x-0 top-0">
          <TopBarInner tone="dark" active="about" onNav={navTo} />
        </div>
        <div ref={barLightRef} className="absolute inset-x-0 top-0" style={{ opacity: 0 }}>
          <TopBarInner tone="light" active="projects" onNav={navTo} />
        </div>
        <div ref={barContactRef} className="absolute inset-x-0 top-0" style={{ opacity: 0 }}>
          <TopBarInner tone="dark" active="contact" onNav={navTo} />
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
