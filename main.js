// word-trie: 英単語の接頭辞木（トライ木）を宇宙に浮かぶ文字の木として 3D で見る。
// トライ木の組み立て（整形・構築）は trie.js にまとめてあり、node からも同じものを検査できる（test/trie.test.mjs）。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseCsv, buildWordEntries, buildTrie, pathWord, wordsWithPrefix, normalize, layoutRadial } from './trie.js';

WebAppKit.init({ title: 'word-trie', text: '英単語帳を宇宙に浮かぶ文字の木として 3D で見る' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// localStorage はほかのアプリと共有される。キーは 'word-trie.' で始める（RULES.md §3）
const STORE = 'word-trie.';
function loadView() {
  try { return localStorage.getItem(STORE + 'view') === '2d'; } catch { return false; }
}
function saveView(is2D) {
  try { localStorage.setItem(STORE + 'view', is2D ? '2d' : '3d'); } catch { /* 保存できなくても遊べる */ }
}

const R = 1.9;          // 深さ 1 ごとの半径（殻の間かく。3D・2D 共通）
const LABEL_COUNT = 40; // ラベルを出す球の数（+ マウスが乗った球）
const RANDOM_TICK = 250; // ランダムな単語を 1 文字ずつ光らせる間かく（ms）

const sceneEl = document.getElementById('scene');
const labelsEl = document.getElementById('labels');
const statsEl = document.getElementById('stats');
const searchInput = document.getElementById('search-input');
const searchMsg = document.getElementById('search-msg');
const sheetEl = document.getElementById('sheet');
const sheetPathEl = document.getElementById('sheet-path');
const sheetListEl = document.getElementById('sheet-list');
const btnRandom = document.getElementById('btn-random');
const btnReset = document.getElementById('btn-reset');
const btnView = document.getElementById('btn-view');
const sheetClose = document.getElementById('sheet-close');

// ---- データの読み込み ----

async function loadCsvText() {
  try {
    const res = await fetch('./words.csv', { cache: 'no-cache' });
    if (res.ok) return await res.text();
  } catch { /* words.csv がない・読めない */ }
  const res = await fetch('./words.sample.csv', { cache: 'no-cache' });
  return res.text();
}

// 深さの色: 1 文字目は青白い恒星、奥ほど暖かい色（青白 → 白 → 黄 → 橙 → 赤）。
// HSL を素通しで混ぜると緑（色相 0.33 あたり）を通ってしまうので、決めた色を段階的に混ぜる。
const COLOR_STOPS = [
  [0.00, new THREE.Color(0xbfe0ff)], // 青白い恒星
  [0.22, new THREE.Color(0xffffff)], // 白
  [0.48, new THREE.Color(0xffe9a8)], // 淡い黄
  [0.72, new THREE.Color(0xffb257)], // 橙
  [1.00, new THREE.Color(0xff5a46)], // 赤
];
function colorAtT(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [t0, c0] = COLOR_STOPS[i - 1];
    const [t1, c1] = COLOR_STOPS[i];
    if (t <= t1) {
      const local = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return c0.clone().lerp(c1, local);
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1][1].clone();
}
function depthColor(depth, maxDepth, isEnd) {
  const t = maxDepth > 0 ? Math.min(depth / maxDepth, 1) : 0;
  const c = colorAtT(t);
  if (isEnd) return c.clone().lerp(new THREE.Color(0xffffff), 0.35); // 単語の終わりは、はっきり明るく
  return c.clone().multiplyScalar(0.62); // 普通の球は少し暗めに
}

function fibonacciSphere(n) {
  const pts = [];
  if (n <= 0) return pts;
  if (n === 1) { pts.push(new THREE.Vector3(0, 1, 0)); return pts; }
  const offset = 2 / n;
  const increment = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = (i * offset - 1) + offset / 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * increment;
    pts.push(new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r));
  }
  return pts;
}

function perpBasis(dir) {
  const arbitrary = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(arbitrary, dir).normalize();
  const v = new THREE.Vector3().crossVectors(dir, u).normalize();
  return [u, v];
}

function tiltDir(dir, angle, azimuth) {
  const [u, v] = perpBasis(dir);
  const perp = u.clone().multiplyScalar(Math.cos(azimuth)).add(v.clone().multiplyScalar(Math.sin(azimuth)));
  return dir.clone().multiplyScalar(Math.cos(angle)).add(perp.multiplyScalar(Math.sin(angle))).normalize();
}

// 根からの放射状の配置。深さ d の球は半径 d×R の殻の上、兄弟は親の向きのまわりに円すい状に広げる
// （子孫の葉の数 = leafWeight に比例した角度を割り当て、重なりにくくする）。
// 子の azimuth（円すいの中の向き）は、常にその場で 0〜2π をまるごと配り直す。
// 先祖から受け継いだ細い範囲をさらに割っていく作りだと、深いノードほど範囲が指数的に狭まり、
// 枝が同じ方向に折り重なってしまう（2026-10 に発見）。
function layoutTree3D(root) {
  root.pos3d = new THREE.Vector3(0, 0, 0);
  const firstChildren = [...root.children.values()];
  const dirs = fibonacciSphere(firstChildren.length);
  firstChildren.forEach((child, i) => layoutSubtree3D(child, dirs[i], 1));
}

function layoutSubtree3D(node, dir, depth) {
  node.dir3d = dir;
  node.pos3d = dir.clone().multiplyScalar(depth * R);
  const children = [...node.children.values()];
  if (!children.length) return;
  const totalWeight = children.reduce((s, c) => s + c.leafWeight, 0);
  // 枝分かれが多いほど広く開く。深いほど殻が大きくなり同じ角度でも実際の間隔は広がるので、少しだけ狭める
  const coneAngle = Math.min(1.25, Math.max(0.35, 0.3 + 0.16 * Math.sqrt(children.length))) / Math.pow(depth, 0.18);
  const FULL = Math.PI * 2 * 0.94; // 一周ぴったりだと最初と最後が重なるので少し余らせる
  let a = 0;
  for (const child of children) {
    const span = (child.leafWeight / totalWeight) * FULL;
    const mid = a + span / 2;
    const childDir = tiltDir(dir, coneAngle, mid);
    layoutSubtree3D(child, childDir, depth + 1);
    a += span;
  }
}

// 2D の平面放射状レイアウト。角度の配り方そのもの（重ならないこと）は trie.js の
// layoutRadial（DOM に依らない。test/trie.test.mjs で検査）に任せ、ここでは
// 角度 + 深さ×R を x, y 座標に変換するだけ。12 時から時計回りに a→z と並ぶよう、角度を π/2 − angle に読み替える。
function layoutTree2D(root) {
  layoutRadial(root);
  (function walk(node) {
    const a = Math.PI / 2 - node.angle;
    node.pos2d = node.depth === 0
      ? new THREE.Vector3(0, 0, 0)
      : new THREE.Vector3(Math.cos(a) * node.depth * R, Math.sin(a) * node.depth * R, 0);
    for (const child of node.children.values()) walk(child);
  })(root);
}

function flattenNodes(root, nodeCount) {
  const nodes = new Array(nodeCount);
  (function walk(node) {
    nodes[node.id] = node;
    for (const child of node.children.values()) walk(child);
  })(root);
  return nodes;
}

function pathToRoot(node) {
  const path = [];
  for (let n = node; n; n = n.parent) path.unshift(n);
  return path;
}

// ---- 背景（星と星雲） ----

function makeGlowTexture(inner, outer) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function buildBackground(scene) {
  const starCount = 2200;
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 60 + Math.random() * 260;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.9, sizeAttenuation: true, transparent: true, opacity: 0.8 });
  scene.add(new THREE.Points(starGeo, starMat));

  const nebulaTex = makeGlowTexture('rgba(90,110,255,0.35)', 'rgba(90,110,255,0)');
  const nebulaTex2 = makeGlowTexture('rgba(255,120,90,0.28)', 'rgba(255,120,90,0)');
  const spots = [
    [nebulaTex, -140, 40, -180, 260],
    [nebulaTex2, 160, -60, 120, 220],
  ];
  for (const [tex, x, y, z, scale] of spots) {
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(x, y, z);
    sprite.scale.set(scale, scale, 1);
    scene.add(sprite);
  }
}

// ---- 本体 ----

async function main() {
  const text = await loadCsvText();
  const raw = parseCsv(text);
  const { entries, total, removedInvalid, removedDuplicate } = buildWordEntries(raw);
  const { root, nodeCount, wordCount } = buildTrie(entries);
  layoutTree3D(root);
  layoutTree2D(root); // 角度の配り方（重ならないこと）は trie.js の layoutRadial、node から検査できる
  const nodes = flattenNodes(root, nodeCount);
  const endNodes = nodes.filter((n) => n.isEnd);
  let maxDepth = 0;
  for (const n of nodes) if (n.depth > maxDepth) maxDepth = n.depth;

  statsEl.textContent = `読み込み ${total} 語 / 使用 ${wordCount} 語`
    + (removedInvalid || removedDuplicate ? `（除外: 不正 ${removedInvalid}・重複 ${removedDuplicate}）` : '');

  const baseColors = nodes.map((n) => depthColor(n.depth, maxDepth, n.isEnd));
  const highlightColor = new THREE.Color(0xff53c8); // 他の深さの色と混同しない、はっきりした色

  // 2D の実際の広がり（円とは限らない）。1〜2 語だけ飛び抜けて長い、といった外れ値に
  // 合わせて全体を引きすぎないよう、97 パーセンタイルに合わせる（ごく一部の長い語の先は
  // 「全体を見る」では画面の外に出ることがあるが、見た目の大きな塊はちょうど画面に収まる）
  function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }
  const bound2DHalfX = Math.max(R, percentile(nodes.map((n) => Math.abs(n.pos2d.x)), 0.94));
  const bound2DHalfY = Math.max(R, percentile(nodes.map((n) => Math.abs(n.pos2d.y)), 0.94));

  // 2D ⇔ 3D。選んだ方は localStorage に覚える。node.pos は今の表示モードの座標（切り替え時に書き換える）
  let is2D = loadView();
  for (const n of nodes) n.pos = (is2D ? n.pos2d : n.pos3d).clone();
  btnView.textContent = is2D ? '3D' : '2D'; // ボタンには切り替え先のモードを出す

  // ---- three.js の下ごしらえ ----
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060d);
  buildBackground(scene);

  // 2D はごく狭い画角（望遠）にして遠くから見る。パースの「手前が大きく奥が小さく」が
  // ほぼ消え、真上から見た図に近づく（画角 θ での中心と端の大きさの比はおよそ cos(θ/2) だけで決まり、
  // 距離によらない。55° だと ~0.89、9° だと ~0.997 とほぼ 1 になる）。
  const FOV_3D = 55;
  const FOV_2D = 9;
  const camera = new THREE.PerspectiveCamera(FOV_3D, 1, 0.1, 8000);
  const fovRad3D = (FOV_3D * Math.PI) / 180;
  const fovRad2D = (FOV_2D * Math.PI) / 180;
  const overviewDist3D = Math.max(8, (maxDepth || 1) * R * 1.9);
  const overviewPos3D = new THREE.Vector3(overviewDist3D * 0.5, overviewDist3D * 0.35, overviewDist3D * 0.8);
  // 2D は真上から見る。実際の x, y の広がりに余白 8% を足した分が、画面の縦・横どちらにも
  // 収まる距離まで離れる（アスペクト比に応じて、縦・横のきつい方に合わせる）
  const MARGIN_2D = 1.08;
  function overviewDist2D() {
    const aspect = camera.aspect || 1;
    const distH = (bound2DHalfY * MARGIN_2D) / Math.tan(fovRad2D / 2);
    const distW = (bound2DHalfX * MARGIN_2D) / (Math.tan(fovRad2D / 2) * aspect);
    return Math.max(8, distH, distW);
  }
  const overviewPos2D = () => new THREE.Vector3(0, 0, overviewDist2D());
  const overviewPos = () => (is2D ? overviewPos2D() : overviewPos3D);
  const overviewDist = () => (is2D ? overviewDist2D() : overviewDist3D);
  // #scene の大きさは CSS で決まっていて、canvas を作る前でも読める
  camera.aspect = sceneEl.clientWidth / sceneEl.clientHeight || 1;
  camera.updateProjectionMatrix();
  camera.position.copy(overviewPos());

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  sceneEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1;
  controls.maxDistance = Math.max(overviewDist3D, overviewDist2D()) * 1.5;
  controls.target.set(0, 0, 0);
  // 2D の間は回転を切り、1 本指/左ドラッグをパンにする（拡大はホイール・ピンチのまま）。
  // 画角も望遠にして、真上から見た図に近づける
  function applyControlMode() {
    controls.enableRotate = !is2D;
    camera.fov = is2D ? FOV_2D : FOV_3D;
    camera.updateProjectionMatrix();
    controls.mouseButtons = is2D
      ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.touches = is2D
      ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
      : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }
  applyControlMode();

  // 球: 深さ・単語の終わりかどうかでまとめた InstancedMesh（色は材質ごとの固定色）。
  // instanceColor（球ごとの色の書き換え）はブラウザによって描画されない個体があったため使わない。
  // 道を光らせるのは、同じ位置に重ねる白い InstancedMesh（highlightMesh）の表示・非表示で行う。
  const sphereGeo = new THREE.SphereGeometry(1, 16, 12);
  const dummy = new THREE.Object3D();
  // 球は文字数目（深さ）が進むほど小さく。単語の終わりかどうかでは変えない。2D は外周が詰まるので 3D より少し小さく
  const nodeScale = (node) => (is2D ? R * 0.045 : R * 0.075) * Math.max(0.3, Math.pow(0.85, node.depth));
  const bucketGroups = new Map(); // "深さ:終わりかどうか" → ノード一覧
  for (const node of nodes) {
    if (node.id === 0) continue;
    const key = `${node.depth}:${node.isEnd ? 1 : 0}`;
    if (!bucketGroups.has(key)) bucketGroups.set(key, []);
    bucketGroups.get(key).push(node);
  }
  const bucketMeshes = [];
  const dimmables = []; // { mat, color } の一覧。道を選んでいる間、これ以外の色を暗くする
  for (const [key, list] of bucketGroups) {
    const [depthStr, endStr] = key.split(':');
    const color = depthColor(Number(depthStr), maxDepth, endStr === '1');
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.InstancedMesh(sphereGeo, mat, list.length);
    const nodeIds = new Array(list.length);
    list.forEach((node, i) => {
      dummy.position.copy(node.pos);
      dummy.scale.setScalar(nodeScale(node));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      nodeIds[i] = node.id;
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.nodeIds = nodeIds;
    scene.add(mesh);
    bucketMeshes.push(mesh);
    dimmables.push({ mat, color });
  }
  const rootColor = new THREE.Color(0x33415a);
  const rootMat = new THREE.MeshBasicMaterial({ color: rootColor });
  const rootMesh = new THREE.Mesh(sphereGeo, rootMat);
  rootMesh.scale.setScalar(nodeScale(root));
  scene.add(rootMesh);
  dimmables.push({ mat: rootMat, color: rootColor });

  // 道を選んでいる間、道以外の球・にじみを暗くして、道をはっきり見せる
  const DIM_FACTOR = 0.22;
  function setDimmed(active) {
    const f = active ? DIM_FACTOR : 1;
    for (const { mat, color } of dimmables) mat.color.copy(color).multiplyScalar(f);
    glowMat.opacity = active ? 0.8 * DIM_FACTOR : 0.8;
  }

  // 道を光らせるための、白い球を重ねる InstancedMesh（根からの道の長さぶん）
  const MAX_PATH = 80;
  const highlightMat = new THREE.MeshBasicMaterial({ color: 0xff53c8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const highlightMesh = new THREE.InstancedMesh(sphereGeo, highlightMat, MAX_PATH);
  function hideHighlightFrom(start) {
    for (let i = start; i < MAX_PATH; i++) {
      dummy.position.set(0, 0, 0);
      dummy.scale.setScalar(0);
      dummy.updateMatrix();
      highlightMesh.setMatrixAt(i, dummy.matrix);
    }
  }
  hideHighlightFrom(0);
  highlightMesh.instanceMatrix.needsUpdate = true;
  scene.add(highlightMesh);

  // 線: 1 つの LineSegments。頂点色で光らせる。子ノード 1 つにつき 1 本（根向きの辺）
  const edgeNodeIds = nodes.filter((n) => n.parent).map((n) => n.id);
  const edgePositions = new Float32Array(edgeNodeIds.length * 2 * 3);
  const edgeColors = new Float32Array(edgeNodeIds.length * 2 * 3);
  const edgeIndexByNodeId = new Map();
  edgeNodeIds.forEach((id, i) => {
    edgeIndexByNodeId.set(id, i);
    const node = nodes[id];
    const p = node.parent.pos, q = node.pos;
    edgePositions.set([p.x, p.y, p.z, q.x, q.y, q.z], i * 6);
    const c1 = baseColors[node.parent.id], c2 = baseColors[id];
    edgeColors.set([c1.r, c1.g, c1.b, c2.r, c2.g, c2.b], i * 6);
  });
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3));
  edgeGeo.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3));
  const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
  const edgeMesh = new THREE.LineSegments(edgeGeo, edgeMat);
  scene.add(edgeMesh);

  function resetEdgeColor(id, factor = 1) {
    const node = nodes[id];
    if (!node.parent) return;
    const i = edgeIndexByNodeId.get(id);
    const c1 = baseColors[node.parent.id], c2 = baseColors[id];
    edgeColors.set([c1.r * factor, c1.g * factor, c1.b * factor, c2.r * factor, c2.g * factor, c2.b * factor], i * 6);
  }
  function highlightEdgeColor(id) {
    const i = edgeIndexByNodeId.get(id);
    if (i == null) return;
    edgeColors.set([highlightColor.r, highlightColor.g, highlightColor.b, highlightColor.r, highlightColor.g, highlightColor.b], i * 6);
  }

  // 道だけを重ねて描く、明るい LineSegments（線を太く見せたいので別に用意する）
  const pathLinePositions = new Float32Array(MAX_PATH * 2 * 3);
  const pathLineGeo = new THREE.BufferGeometry();
  pathLineGeo.setAttribute('position', new THREE.BufferAttribute(pathLinePositions, 3));
  pathLineGeo.setDrawRange(0, 0);
  const pathLineMat = new THREE.LineBasicMaterial({ color: 0xff53c8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const pathLineMesh = new THREE.LineSegments(pathLineGeo, pathLineMat);
  scene.add(pathLineMesh);

  // 単語の終わり: 星のようなにじみ（加算合成の Points）を 1 つにまとめる
  const glowPositions = new Float32Array(endNodes.length * 3);
  endNodes.forEach((n, i) => { glowPositions[i * 3] = n.pos.x; glowPositions[i * 3 + 1] = n.pos.y; glowPositions[i * 3 + 2] = n.pos.z; });
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPositions, 3));
  const glowTex = makeGlowTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
  // 単語の終わりはよくあるので、にじみは球より少し大きい程度にとどめる（大きすぎると密集した場所が真っ白につぶれる）
  const glowMat = new THREE.PointsMaterial({ map: glowTex, size: R * 0.34, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 });
  scene.add(new THREE.Points(glowGeo, glowMat));

  // ---- ラベル（文字）: プールを使い回す ----
  // 道 → ホバー → 近い順、の優先度で置く。既に置いたラベルから 14px 以内に来るものは出さない
  // （外周で団子にならないように）。
  const LABEL_MIN_GAP = 14;
  const labelPool = [];
  for (let i = 0; i < LABEL_COUNT + MAX_PATH + 1; i++) {
    const el = document.createElement('div');
    el.className = 'node-label';
    labelsEl.appendChild(el);
    labelPool.push(el);
  }
  let currentPath = []; // 根からの道（道を選んでいないときは空）

  function updateLabels() {
    const w = sceneEl.clientWidth, h = sceneEl.clientHeight;
    const pathIds = new Set(currentPath.map((n) => n.id));
    const candidates = [];
    for (const n of currentPath) if (n.id !== 0) candidates.push({ node: n, kind: 'path' });
    if (hoverNode && hoverNode.id !== 0 && !pathIds.has(hoverNode.id)) candidates.push({ node: hoverNode, kind: 'hover' });
    const scored = nodes
      .filter((n) => n.id !== 0 && !pathIds.has(n.id) && n !== hoverNode)
      .map((n) => ({ n, d: n.pos.distanceToSquared(camera.position) }));
    scored.sort((a, b) => a.d - b.d);
    for (const { n } of scored.slice(0, LABEL_COUNT)) candidates.push({ node: n, kind: 'near' });

    const placed = []; // 画面に出した位置 [x, y]
    let used = 0;
    for (const { node, kind } of candidates) {
      if (used >= labelPool.length) break;
      const v = node.pos.clone().project(camera);
      if (v.z < -1 || v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) continue;
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      if (placed.some(([px, py]) => Math.hypot(px - x, py - y) < LABEL_MIN_GAP)) continue;
      placed.push([x, y]);
      const el = labelPool[used++];
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.textContent = node.char.toUpperCase();
      el.classList.add('is-visible');
      el.classList.toggle('is-path', kind === 'path');
      el.classList.toggle('is-hover', kind === 'hover');
    }
    for (let i = used; i < labelPool.length; i++) labelPool[i].classList.remove('is-visible');
  }

  // ---- 選択・道の光らせ方 ----
  let selectedId = 0;
  let hoverNode = null;

  function resetColors() {
    currentPath = [];
    setDimmed(false);
    for (const id of edgeNodeIds) resetEdgeColor(id);
    edgeGeo.attributes.color.needsUpdate = true;
    hideHighlightFrom(0);
    highlightMesh.instanceMatrix.needsUpdate = true;
    pathLineGeo.setDrawRange(0, 0);
  }

  function showSheet(node) {
    const word = pathWord(node);
    sheetPathEl.textContent = word || '（根）';
    const list = wordsWithPrefix(root, word).slice(0, 200);
    sheetListEl.innerHTML = '';
    for (const { word: w, meaning } of list) {
      const li = document.createElement('li');
      const wordSpan = document.createElement('span');
      wordSpan.textContent = w;
      li.appendChild(wordSpan);
      if (meaning) {
        const m = document.createElement('span');
        m.className = 'meaning';
        m.textContent = meaning;
        li.appendChild(m);
      }
      sheetListEl.appendChild(li);
    }
    if (!list.length) {
      const li = document.createElement('li');
      li.textContent = 'この先に単語はありません';
      sheetListEl.appendChild(li);
    }
    sheetEl.hidden = false;
  }

  function lightPath(targetId) {
    setDimmed(true);
    for (const id of edgeNodeIds) resetEdgeColor(id, DIM_FACTOR);
    const path = pathToRoot(nodes[targetId]);
    currentPath = path;
    let segCount = 0;
    path.forEach((node, i) => {
      highlightEdgeColor(node.id);
      if (i >= MAX_PATH) return;
      dummy.position.copy(node.pos);
      dummy.scale.setScalar(nodeScale(node) * 1.3);
      dummy.updateMatrix();
      highlightMesh.setMatrixAt(i, dummy.matrix);
      if (node.parent) {
        const p = node.parent.pos, q = node.pos;
        pathLinePositions.set([p.x, p.y, p.z, q.x, q.y, q.z], segCount * 6);
        segCount++;
      }
    });
    hideHighlightFrom(path.length);
    edgeGeo.attributes.color.needsUpdate = true;
    highlightMesh.instanceMatrix.needsUpdate = true;
    pathLineGeo.attributes.position.needsUpdate = true;
    pathLineGeo.setDrawRange(0, segCount * 2);
  }

  function animateCamera(toPos, toTarget, duration = 700) {
    const fromPos = camera.position.clone();
    const fromTarget = controls.target.clone();
    const t0 = performance.now();
    controls.enabled = false;
    function step(now) {
      const t = Math.min(1, (now - t0) / duration);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
      camera.position.lerpVectors(fromPos, toPos, e);
      controls.target.lerpVectors(fromTarget, toTarget, e);
      controls.update();
      if (t < 1) requestAnimationFrame(step); else controls.enabled = true;
    }
    requestAnimationFrame(step);
  }

  // 球の一覧をちょうど収める位置を計算する（中心を見て、全部が視野に入る距離まで下がる）。
  // ランダム再生の最後（道の全体を見せたいとき）に使う。
  function cameraDir3D(node) {
    return (node && node.id !== 0 && node.dir3d) || new THREE.Vector3(0.5, 0.35, 0.8).normalize();
  }

  function frameNodes(nodeList) {
    const center = new THREE.Vector3();
    for (const n of nodeList) center.add(n.pos);
    center.divideScalar(nodeList.length);
    let spread = R * 0.5;
    for (const n of nodeList) spread = Math.max(spread, n.pos.distanceTo(center));
    const last = nodeList[nodeList.length - 1];
    const dist = (spread / Math.sin((is2D ? fovRad2D : fovRad3D) / 2)) * 1.3 + R * 0.6;
    const dir = is2D ? new THREE.Vector3(0, 0, 1) : cameraDir3D(last);
    const toPos = center.clone().add(dir.clone().multiplyScalar(dist));
    if (is2D) { toPos.x = center.x; toPos.y = center.y; toPos.z = dist; } // 2D は常に真上から
    return { toPos, toTarget: center };
  }

  // 1 球だけを選んだときの距離。根に近い（浅い）球はそもそも周りが詰まっているので、
  // 深さが浅いほど全体を見る距離に近づけ、深いほど寄る（根からの道の一部も見える）。
  function singleNodeDistance(node) {
    const t = maxDepth > 0 ? node.depth / maxDepth : 0;
    if (is2D) {
      // 距離ではなく「画面の半分の高さ（ワールド単位）」で浅い⇔深いを補間し、そこから画角で距離を出す。
      // 2D は画角がごく狭いので、3D と同じ「距離」をそのまま流用すると寄りすぎてしまう。
      const farHalf = bound2DHalfY * MARGIN_2D * 0.55;
      const closeHalf = R * 1.7;
      const half = farHalf * (1 - t) + closeHalf * t;
      return half / Math.tan(fovRad2D / 2);
    }
    const far = overviewDist3D * 0.55;
    const close = R * 3.2;
    return far * (1 - t) + close * t;
  }

  function selectNode(id, { moveCamera = true, frameWhole = false } = {}) {
    selectedId = id;
    lightPath(id);
    showSheet(nodes[id]);
    if (!moveCamera) return;
    const node = nodes[id];
    if (frameWhole) {
      const { toPos, toTarget } = frameNodes(pathToRoot(node));
      animateCamera(toPos, toTarget);
      return;
    }
    const dist = singleNodeDistance(node);
    const dir = is2D ? new THREE.Vector3(0, 0, 1) : cameraDir3D(node);
    const toPos = node.pos.clone().add(dir.clone().multiplyScalar(dist));
    animateCamera(toPos, node.pos.clone());
  }

  function goOverview() {
    selectedId = 0;
    resetColors();
    sheetEl.hidden = true;
    animateCamera(overviewPos(), new THREE.Vector3(0, 0, 0));
  }

  // 2D ⇔ 3D の切り替え。描き方（InstancedMesh・線・にじみ・道のハイライト・ラベル）はそのまま、
  // node.pos を書き換えて位置だけ作り直す。
  function rebuildPositions() {
    for (const n of nodes) n.pos.copy(is2D ? n.pos2d : n.pos3d);
    for (const mesh of bucketMeshes) {
      const ids = mesh.userData.nodeIds;
      for (let i = 0; i < ids.length; i++) {
        const node = nodes[ids[i]];
        dummy.position.copy(node.pos);
        dummy.scale.setScalar(nodeScale(node));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    rootMesh.scale.setScalar(nodeScale(root));
    edgeNodeIds.forEach((id, i) => {
      const node = nodes[id];
      const p = node.parent.pos, q = node.pos;
      edgePositions.set([p.x, p.y, p.z, q.x, q.y, q.z], i * 6);
    });
    edgeGeo.attributes.position.needsUpdate = true;
    endNodes.forEach((n, i) => { glowPositions[i * 3] = n.pos.x; glowPositions[i * 3 + 1] = n.pos.y; glowPositions[i * 3 + 2] = n.pos.z; });
    glowGeo.attributes.position.needsUpdate = true;
    if (currentPath.length) lightPath(selectedId); // 道のハイライト・にじみの位置も作り直す
  }

  function setMode(next2D) {
    if (next2D === is2D) return;
    is2D = next2D;
    saveView(is2D);
    applyControlMode();
    rebuildPositions();
    btnView.textContent = is2D ? '3D' : '2D';
    if (selectedId !== 0) selectNode(selectedId, { moveCamera: true });
    else animateCamera(overviewPos(), new THREE.Vector3(0, 0, 0), 600);
  }

  // ---- 操作: クリック/タップで選択、ホバーでラベル ----
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  let downPos = null;

  function setPointerFromEvent(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pickNode() {
    raycaster.setFromCamera(pointerNdc, camera);
    const hit = raycaster.intersectObjects(bucketMeshes)[0];
    if (!hit || hit.instanceId == null) return null;
    const id = hit.object.userData.nodeIds[hit.instanceId];
    return nodes[id];
  }

  renderer.domElement.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved > 6) return; // ドラッグはクリック扱いしない
    setPointerFromEvent(e);
    const node = pickNode();
    if (node && node.id !== 0) selectNode(node.id);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    setPointerFromEvent(e);
    const node = pickNode();
    hoverNode = node && node.id !== 0 ? node : null;
  });
  renderer.domElement.addEventListener('pointerleave', () => { hoverNode = null; });

  // ---- 検索欄: 1 文字打つごとに道が伸びて光る ----
  searchInput.addEventListener('input', () => {
    const value = normalize(searchInput.value);
    let node = root;
    let reached = 0;
    for (const ch of value) {
      const next = node.children.get(ch);
      if (!next) break;
      node = next;
      reached++;
    }
    const ok = reached === value.length;
    searchInput.classList.toggle('is-invalid', !ok && value.length > 0);
    if (!ok && value.length > 0) {
      searchMsg.hidden = false;
      searchMsg.textContent = `"${value}" の先はありません（"${value.slice(0, reached)}" までは見つかりました）`;
    } else {
      searchMsg.hidden = true;
    }
    if (value.length === 0) { goOverview(); return; }
    selectNode(node.id);
  });

  // ---- ボタン ----
  let randomTimer = null;
  btnRandom.addEventListener('click', () => {
    if (!endNodes.length) return;
    clearTimeout(randomTimer);
    const target = endNodes[Math.floor(Math.random() * endNodes.length)];
    const path = pathToRoot(target).filter((n) => n.id !== 0);
    searchInput.value = '';
    searchMsg.hidden = true;
    searchInput.classList.remove('is-invalid');
    let i = 0;
    const step = () => {
      i++;
      const isLast = i >= path.length;
      selectNode(path[i - 1].id, { moveCamera: isLast, frameWhole: isLast });
      if (!isLast) randomTimer = setTimeout(step, RANDOM_TICK);
    };
    step();
  });

  btnReset.addEventListener('click', () => {
    clearTimeout(randomTimer);
    searchInput.value = '';
    searchMsg.hidden = true;
    searchInput.classList.remove('is-invalid');
    goOverview();
  });

  sheetClose.addEventListener('click', () => { sheetEl.hidden = true; });

  btnView.addEventListener('click', () => { setMode(!is2D); });

  // ---- 描画ループ・リサイズ ----
  function resize() {
    const w = sceneEl.clientWidth, h = sceneEl.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  function tick() {
    controls.update();
    // 2D は必ず target の真上（パンのあとなどに角度がずれない念のための保険）
    if (is2D) {
      camera.position.x = controls.target.x;
      camera.position.y = controls.target.y;
      camera.up.set(0, 1, 0);
      camera.lookAt(controls.target);
    }
    updateLabels();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();
}

main();
