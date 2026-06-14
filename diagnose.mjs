import { readFileSync } from 'node:fs'

// --- Parse GLB container -> JSON chunk -------------------------------------
const buf = readFileSync('./public/katana.glb')
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
const magic = dv.getUint32(0, true)
if (magic !== 0x46546c67) throw new Error('not a glb')
let off = 12
let json = null
while (off < buf.byteLength) {
  const len = dv.getUint32(off, true)
  const type = dv.getUint32(off + 4, true)
  const start = off + 8
  if (type === 0x4e4f534a) {
    json = JSON.parse(Buffer.from(buf.buffer, buf.byteOffset + start, len).toString('utf8'))
  }
  off = start + len
}

const nodes = json.nodes || []
const meshes = json.meshes || []
const accessors = json.accessors || []
const scenes = json.scenes || []
const animations = json.animations || []

// --- Compose local matrix for a node (T * R * S) ----------------------------
function mul(a, b) {
  const o = new Array(16).fill(0)
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}
const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
function localMatrix(n) {
  if (n.matrix) return n.matrix.slice()
  const [tx,ty,tz] = n.translation || [0,0,0]
  const [qx,qy,qz,qw] = n.rotation || [0,0,0,1]
  const [sx,sy,sz] = n.scale || [1,1,1]
  const x2=qx+qx,y2=qy+qy,z2=qz+qz
  const xx=qx*x2,xy=qx*y2,xz=qx*z2,yy=qy*y2,yz=qy*z2,zz=qz*z2,wx=qw*x2,wy=qw*y2,wz=qw*z2
  const R=[
    (1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0,
    (xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0,
    (xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0,
    tx,ty,tz,1]
  return R
}
function apply(m, v) {
  const [x,y,z] = v
  return [
    m[0]*x+m[4]*y+m[8]*z+m[12],
    m[1]*x+m[5]*y+m[9]*z+m[13],
    m[2]*x+m[6]*y+m[10]*z+m[14],
  ]
}

// parent map + world matrices
const parent = new Array(nodes.length).fill(-1)
nodes.forEach((n,i)=>(n.children||[]).forEach(c=>parent[c]=i))
const world = new Array(nodes.length)
function worldMatrix(i){
  if (world[i]) return world[i]
  const lm = localMatrix(nodes[i])
  world[i] = parent[i] === -1 ? lm : mul(worldMatrix(parent[i]), lm)
  return world[i]
}

function accBox(meshIndex){
  // union of POSITION accessor min/max across primitives (LOCAL space)
  const m = meshes[meshIndex]
  let mn=[Infinity,Infinity,Infinity], mx=[-Infinity,-Infinity,-Infinity]
  for (const p of m.primitives){
    const a = accessors[p.attributes.POSITION]
    if (!a || !a.min) continue
    for (let k=0;k<3;k++){ mn[k]=Math.min(mn[k],a.min[k]); mx[k]=Math.max(mx[k],a.max[k]) }
  }
  return {mn,mx}
}

const f = (n)=> (n>=0?' ':'') + n.toFixed(3)
const v3 = (a)=>`[${f(a[0])},${f(a[1])},${f(a[2])}]`

console.log('=== ANIMATIONS (built-in clip, NOT used) ===')
animations.forEach(a=>console.log(`  clip "${a.name}"  channels=${a.channels.length}`))

console.log('\n=== NODES (name | worldPos | mesh) ===')
const sword=[], scabbard=[], other=[]
nodes.forEach((n,i)=>{
  const wp = apply(worldMatrix(i), [0,0,0])
  const meshName = n.mesh!=null ? meshes[n.mesh].name : '—'
  console.log(`  [${i}] "${n.name??''}"  world=${v3(wp)}  mesh="${meshName}"  parent=[${parent[i]}] children=${(n.children||[]).length}`)
})

console.log('\n=== MESH-BEARING NODES: world bbox center + size + classification ===')
nodes.forEach((n,i)=>{
  if (n.mesh==null) return
  const name = (meshes[n.mesh].name||'').toLowerCase()
  const {mn,mx} = accBox(n.mesh)
  // transform 8 corners to world, rebuild aabb
  const corners=[]
  for(const X of [mn[0],mx[0]]) for(const Y of [mn[1],mx[1]]) for(const Z of [mn[2],mx[2]]) corners.push(apply(worldMatrix(i),[X,Y,Z]))
  let wmn=[Infinity,Infinity,Infinity], wmx=[-Infinity,-Infinity,-Infinity]
  corners.forEach(c=>{for(let k=0;k<3;k++){wmn[k]=Math.min(wmn[k],c[k]);wmx[k]=Math.max(wmx[k],c[k])}})
  const ctr=[(wmn[0]+wmx[0])/2,(wmn[1]+wmx[1])/2,(wmn[2]+wmx[2])/2]
  const sz=[wmx[0]-wmn[0],wmx[1]-wmn[1],wmx[2]-wmn[2]]
  let cls='other'
  if (name.startsWith('katana blade')){cls='SWORD'; sword.push(i)}
  else if (name.startsWith('katana cover')){cls='SCABBARD'; scabbard.push(i)}
  else other.push(i)
  console.log(`  [${i}] ${cls.padEnd(8)} "${meshes[n.mesh].name}"  ctr=${v3(ctr)}  size=${v3(sz)}`)
})

// --- Whole-group world AABBs + derived draw axis ---------------------------
function groupBox(indices){
  let mn=[Infinity,Infinity,Infinity], mx=[-Infinity,-Infinity,-Infinity]
  indices.forEach(i=>{
    const {mn:lmn,mx:lmx}=accBox(nodes[i].mesh)
    for(const X of [lmn[0],lmx[0]]) for(const Y of [lmn[1],lmx[1]]) for(const Z of [lmn[2],lmx[2]]){
      const w=apply(worldMatrix(i),[X,Y,Z])
      for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],w[k]);mx[k]=Math.max(mx[k],w[k])}
    }
  })
  return {mn,mx,ctr:[ (mn[0]+mx[0])/2,(mn[1]+mx[1])/2,(mn[2]+mx[2])/2 ], sz:[mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2]]}
}

console.log('\n=== GROUP SUMMARY (world space) ===')
const sb=groupBox(sword), cb=groupBox(scabbard)
console.log(`  SWORD    nodes=${sword.length}  ctr=${v3(sb.ctr)}  size=${v3(sb.sz)}`)
console.log(`  SCABBARD nodes=${scabbard.length}  ctr=${v3(cb.ctr)}  size=${v3(cb.sz)}`)
console.log(`  OTHER    nodes=${other.length}`)

const dir=[cb.ctr[0]-sb.ctr[0], cb.ctr[1]-sb.ctr[1], cb.ctr[2]-sb.ctr[2]]
const sword_diag=Math.hypot(sb.sz[0],sb.sz[1],sb.sz[2])
console.log(`\n  scabbardCtr - swordCtr = ${v3(dir)}  (near zero ⇒ sheathed/concentric)`)
console.log(`  SWORD bbox diagonal length ≈ ${sword_diag.toFixed(3)}`)
console.log(`  SWORD aabb longest-axis = ${['X','Y','Z'][sb.sz.indexOf(Math.max(...sb.sz))]} (AABB only — true blade axis is diagonal, must use PCA)`)
