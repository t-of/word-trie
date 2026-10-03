// word-trie: 英単語の接頭辞木（トライ木）を宇宙に浮かぶ文字の木として 3D で見る。
// トライ木の組み立て（整形・構築）は trie.js にまとめてあり、node からも同じものを検査できる（test/trie.test.mjs）。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseCsv, buildWordEntries, buildTrie, pathWord, wordsWithPrefix, normalize, layoutRadial, layoutGrid, layoutGlobe, layoutCube } from './trie.js';
// サンバースト（輪）の角度は 2D と同じ layoutRadial をそのまま使う。重ならない・単語数に比例する
// ことは test/trie.test.mjs の「layoutRadial」の検査で既に見ている（新しい関数は作らない）。

WebAppKit.init({ title: 'word-trie', text: '英単語帳を宇宙に浮かぶ文字の木として 3D で見る' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// localStorage はほかのアプリと共有される。キーは 'word-trie.' で始める（RULES.md §3）
const STORE = 'word-trie.';
// 表示モード: '3d' | '2d' | 'grid' | 'globe' | 'sunburst' | 'cube' | 'cubeball'（立方と同じ配置で、立方体に収まる球）。
// ボタンを押すたびに 3d → 2d → grid → globe → sunburst → cube → cubeball → 3d と回す
const MODES = ['3d', '2d', 'grid', 'globe', 'sunburst', 'cube', 'cubeball'];
const NEXT_MODE = { '3d': '2d', '2d': 'grid', grid: 'globe', globe: 'sunburst', sunburst: 'cube', cube: 'cubeball', cubeball: '3d' };
const MODE_LABEL = { '3d': '3D', '2d': '2D', grid: '格子', globe: '地球', sunburst: '輪', cube: '立方', cubeball: '立方球' };
const isCubeMode = (m) => m === 'cube' || m === 'cubeball'; // 位置・大きさ・カメラは立方と共通
function loadView() {
  try {
    const v = localStorage.getItem(STORE + 'view');
    return MODES.includes(v) ? v : '3d'; // 古い '2d' / '3d' もそのまま読める
  } catch { return '3d'; }
}
function saveView(mode) {
  try { localStorage.setItem(STORE + 'view', mode); } catch { /* 保存できなくても遊べる */ }
}

const R = 1.9;          // 深さ 1 ごとの半径（殻の間かく。3D・2D 共通）
const RANDOM_TICK = 250; // ランダムな単語を 1 文字ずつ光らせる間かく（ms）

const sceneEl = document.getElementById('scene');
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
// layoutRadial（DOM に依らない。test/trie.test.mjs で検査）に任せ、ここでは角度を x, y 座標に変換する。
// 円の半径は深さ×R を基本に、その深さで一番近い隣どうしの角度差でも球（直径 2×NODE_R_2D）が
// 重ならない大きさまで広げる（外の円は内より必ず R 以上外）。12 時から時計回りに a→z と並ぶよう、角度を π/2 − angle に読み替える。
const NODE_R_2D = R * 0.035;
function layoutTree2D(root) {
  layoutRadial(root);
  const angles = [];
  (function collect(node) {
    if (node.depth) (angles[node.depth] ??= []).push(node.angle);
    for (const child of node.children.values()) collect(child);
  })(root);
  const radius = [0];
  for (let d = 1; d < angles.length; d++) {
    const a = angles[d].sort((x, y) => x - y);
    let minGap = a.length > 1 ? a[0] + Math.PI * 2 - a[a.length - 1] : Infinity;
    for (let i = 1; i < a.length; i++) minGap = Math.min(minGap, a[i] - a[i - 1]);
    radius[d] = Math.max(radius[d - 1] + R, (NODE_R_2D * 2 * 1.1) / minGap);
  }
  (function walk(node) {
    const a = Math.PI / 2 - node.angle;
    const r = radius[node.depth];
    node.pos2d = new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0);
    for (const child of node.children.values()) walk(child);
  })(root);
}

// 格子レイアウト。目盛りの配り方（重ならないこと）は trie.js の layoutGrid（DOM に依らない。
// test/trie.test.mjs で検査）に任せ、ここでは目盛り単位を世界の大きさに変換する。
// three.js は y が上向きなので、画面では y が下向きに伸びるよう符号を反転する。全体は中心が原点になるようずらす。
const GRID_CELL = Math.max(R * 0.5, NODE_R_2D * 2 * 1.4);
function layoutTreeGrid(root) {
  layoutGrid(root);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  (function bounds(node) {
    minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
    for (const child of node.children.values()) bounds(child);
  })(root);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  (function walk(node) {
    node.posGrid = new THREE.Vector3((node.x - cx) * GRID_CELL, -(node.y - cy) * GRID_CELL, 0);
    for (const child of node.children.values()) walk(child);
  })(root);
}

// 地球儀レイアウト。マスの配り方（重ならないこと）は trie.js の layoutGlobe（DOM に依らない。
// test/trie.test.mjs で検査）に任せ、ここでは z = sin(緯度)・経度を球面の座標に変換する（y が北）。
// 1 文字目が地表、深いほど GLOBE_STEP ずつ外に浮かせる（親子のマスの中心が重なっても高さで分かれる）。
// 地表の半径は、葉 1 枚あたりの面積がおよそ一定になるよう葉の数の平方根に比例させる。
const GLOBE_STEP = R * 0.15;
let globeR = R * 2;
function layoutTreeGlobe(root) {
  layoutGlobe(root);
  globeR = Math.max(R * 2, Math.sqrt(root.leafWeight) * 0.2);
  root.posGlobe = new THREE.Vector3(0, 0, 0);
  (function walk(node) {
    for (const child of node.children.values()) {
      const c = Math.sqrt(Math.max(0, 1 - child.z * child.z));
      child.dirGlobe = new THREE.Vector3(c * Math.cos(child.lon), child.z, -c * Math.sin(child.lon));
      child.posGlobe = child.dirGlobe.clone().multiplyScalar(globeR + (child.depth - 1) * GLOBE_STEP);
      walk(child);
    }
  })(root);
}

// サンバースト（輪）レイアウト。角度の配り方は trie.js の layoutRadial（2D と同じ、重ならない・
// 単語数に比例）に任せ、ここでは深さ 1 ごとに輪を 1 本広げて弧の内側・外側の半径を決め、
// three.js の RingGeometry の向き（+x から反時計回り）に角度を読み替える。
// node.posSunburst は弧の中心（ラベル・カメラ移動は他のモードと同じく node.pos をそのまま使えるように）。
const SUN_R0 = R * 0.6;  // 中心の穴の半径
const SUN_RW = R * 0.55; // 輪 1 本の太さ（半径方向）
function layoutTreeSunburst(root) {
  layoutRadial(root);
  root.posSunburst = new THREE.Vector3(0, 0, 0);
  (function walk(node) {
    for (const child of node.children.values()) {
      const innerR = SUN_R0 + (child.depth - 1) * SUN_RW;
      const outerR = innerR + SUN_RW;
      child.innerR = innerR;
      child.outerR = outerR;
      // layoutRadial の角度は 2D と同じ向き（12 時から時計回りに a→z）。RingGeometry は
      // +x から反時計回りに角度を取るので、向きが逆になる分だけ開始角をずらす（2D の a = π/2 − angle と同じ変換）。
      child.thetaStartRing = Math.PI / 2 - (child.angleStart + child.angleSpan);
      child.thetaLenRing = child.angleSpan;
      const mid = Math.PI / 2 - child.angle;
      const rMid = (innerR + outerR) / 2;
      child.posSunburst = new THREE.Vector3(Math.cos(mid) * rMid, Math.sin(mid) * rMid, 0);
      walk(child);
    }
  })(root);
}

// 入れ子立方体レイアウト。3×3×3 に分けて重ねる比率（重ならないこと）は trie.js の
// layoutCube（DOM に依らない。test/trie.test.mjs で検査）に任せ、ここでは一辺の長さ（CUBE_S0）を
// 掛けて world 座標に変換するだけ。node.cubeStep（自分の子の間隔）は立方体の大きさにも使う。
const CUBE_S0 = R * 3; // 全体の一辺。他のモードの広がり（R の数倍）に合わせた大きさ
function layoutTreeCube(root) {
  layoutCube(root);
  (function walk(node) {
    node.posCube = new THREE.Vector3(node.cubeX * CUBE_S0, node.cubeY * CUBE_S0, node.cubeZ * CUBE_S0);
    for (const child of node.children.values()) walk(child);
  })(root);
}

// 今の表示モードでのノードの位置
function posForMode(node, mode) {
  if (mode === '2d') return node.pos2d;
  if (mode === 'grid') return node.posGrid;
  if (mode === 'globe') return node.posGlobe;
  if (mode === 'sunburst') return node.posSunburst;
  if (isCubeMode(mode)) return node.posCube;
  return node.pos3d;
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

// ---- ノードの文字 ----

// a〜z を 8×4 のマスに並べた 1 枚の絵。細めの幾何学的な書体（端末に入っているもの）で、
// 縁を黒くして文字どうしが重なっても読めるようにする。
// 小文字は高さがまちまち（b・g など）なので、字の形そのものをマスの真ん中に置く
function makeLetterAtlas() {
  const cell = 128;
  const canvas = document.createElement('canvas');
  canvas.width = cell * 8;
  canvas.height = cell * 4;
  const ctx = canvas.getContext('2d');
  ctx.font = `500 ${cell * 0.7}px 'Avenir Next', Futura, 'Segoe UI', Roboto, system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = cell * 0.08;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(97 + i);
    const m = ctx.measureText(ch);
    const cx = (i % 8 + 0.5) * cell, cy = (Math.floor(i / 8) + 0.5) * cell;
    const x = cx - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
    const y = cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    ctx.strokeText(ch, x, y);
    ctx.fillText(ch, x, y);
  }
  return new THREE.CanvasTexture(canvas);
}
const letterAtlas = makeLetterAtlas();
const letterIndex = (node) => node.char.charCodeAt(0) - 97; // 'a' → 0

// 文字の板を InstancedMesh で描く材質。頂点シェーダーで、板をいつもカメラの正面に向ける
// （instanceMatrix からは位置と大きさだけ使う）。どの文字かは、板ごとの属性 aLetter（0〜25）で選ぶ。
// 色は MeshBasicMaterial の color のままなので、暗くする処理（setDimmed）もそのまま効く
function makeLetterMaterial(params) {
  const mat = new THREE.MeshBasicMaterial({ map: letterAtlas, alphaTest: 0.5, ...params });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLetter;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = (vMapUv + vec2(mod(aLetter, 8.0), 3.0 - floor(aLetter / 8.0))) / vec2(8.0, 4.0);')
      .replace('#include <project_vertex>', [
        'vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);',
        'mvPosition.xy += position.xy * length(instanceMatrix[0].xyz);',
        'gl_Position = projectionMatrix * mvPosition;',
      ].join('\n'));
  };
  return mat;
}

// 板 1 枚（一辺 2 ＝ 半径 1 の球と同じ scale で扱える）と、板ごとの文字の属性
function makeLetterGeometry(count) {
  const geo = new THREE.PlaneGeometry(2, 2);
  geo.setAttribute('aLetter', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  return geo;
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
  layoutTreeGrid(root); // 目盛りの配り方（重ならないこと）は trie.js の layoutGrid、node から検査できる
  layoutTreeGlobe(root); // マスの配り方（重ならないこと）は trie.js の layoutGlobe
  layoutTreeSunburst(root); // 角度は 2D と同じ layoutRadial（test/trie.test.mjs で検査済み）
  layoutTreeCube(root); // 入れ子の比率（重ならないこと）は trie.js の layoutCube
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
  const boundGridHalfX = Math.max(R, percentile(nodes.map((n) => Math.abs(n.posGrid.x)), 0.94));
  const boundGridHalfY = Math.max(R, percentile(nodes.map((n) => Math.abs(n.posGrid.y)), 0.94));
  // サンバーストはきれいな円なので、外側の輪の半径がそのまま広がり
  const sunburstOuterR = SUN_R0 + maxDepth * SUN_RW;

  // 3D / 2D / 格子 / サンバースト。選んだ方は localStorage に覚える。node.pos は今の表示モードの座標（切り替え時に書き換える）
  let mode = loadView();
  const isTopDown = () => mode === '2d' || mode === 'grid' || mode === 'sunburst'; // 2D・格子・サンバーストは真上から見る（3D・地球・立方は回せる）
  for (const n of nodes) n.pos = posForMode(n, mode).clone();
  btnView.textContent = MODE_LABEL[NEXT_MODE[mode]]; // ボタンには切り替え先のモードを出す

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
  // 地球は、一番外の殻がちょうど画面に収まる距離から、3D と同じ向きで見る
  const overviewDistGlobe = Math.max(8, ((globeR + maxDepth * GLOBE_STEP) / Math.sin(fovRad3D / 2)) * 1.1);
  const overviewPosGlobe = overviewPos3D.clone().setLength(overviewDistGlobe);
  // 立方は、全体の広がり（一辺の半分ほど、CUBE_R の幾何級数の収束先）がちょうど画面に収まる距離から、3D と同じ向きで見る
  const overviewDistCube = Math.max(8, ((CUBE_S0 * 0.5) / Math.sin(fovRad3D / 2)) * 1.1);
  const overviewPosCube = overviewPos3D.clone().setLength(overviewDistCube);
  // 2D・格子は真上から見る。実際の x, y の広がりに余白 8% を足した分が、画面の縦・横どちらにも
  // 収まる距離まで離れる（アスペクト比に応じて、縦・横のきつい方に合わせる）
  const MARGIN_2D = 1.08;
  function overviewDistFor(boundHalfX, boundHalfY) {
    const aspect = camera.aspect || 1;
    const distH = (boundHalfY * MARGIN_2D) / Math.tan(fovRad2D / 2);
    const distW = (boundHalfX * MARGIN_2D) / (Math.tan(fovRad2D / 2) * aspect);
    return Math.max(8, distH, distW);
  }
  const overviewDist2D = () => overviewDistFor(bound2DHalfX, bound2DHalfY);
  const overviewDistGrid = () => overviewDistFor(boundGridHalfX, boundGridHalfY);
  const overviewDistSunburst = () => overviewDistFor(sunburstOuterR, sunburstOuterR);
  const overviewPos2D = () => new THREE.Vector3(0, 0, overviewDist2D());
  const overviewPosGrid = () => new THREE.Vector3(0, 0, overviewDistGrid());
  const overviewPosSunburst = () => new THREE.Vector3(0, 0, overviewDistSunburst());
  const overviewPos = () => (mode === '2d' ? overviewPos2D() : mode === 'grid' ? overviewPosGrid() : mode === 'globe' ? overviewPosGlobe : mode === 'sunburst' ? overviewPosSunburst() : isCubeMode(mode) ? overviewPosCube : overviewPos3D);
  const overviewDist = () => (mode === '2d' ? overviewDist2D() : mode === 'grid' ? overviewDistGrid() : mode === 'globe' ? overviewDistGlobe : mode === 'sunburst' ? overviewDistSunburst() : isCubeMode(mode) ? overviewDistCube : overviewDist3D);
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
  controls.maxDistance = Math.max(overviewDist3D, overviewDist2D(), overviewDistGrid(), overviewDistGlobe, overviewDistSunburst(), overviewDistCube) * 1.5;
  controls.target.set(0, 0, 0);
  // 2D・格子の間は回転を切り、1 本指/左ドラッグをパンにする（拡大はホイール・ピンチのまま）。
  // 画角も望遠にして、真上から見た図に近づける
  function applyControlMode() {
    const top = isTopDown();
    controls.enableRotate = !top;
    camera.fov = top ? FOV_2D : FOV_3D;
    camera.updateProjectionMatrix();
    controls.mouseButtons = top
      ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.touches = top
      ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
      : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }
  applyControlMode();

  // ノード: 深さ 1 からはその文字（a〜z）の板、根（深さ 0）だけ小さい球。
  // 深さ・単語の終わりかどうかでまとめた InstancedMesh（色は材質ごとの固定色）。
  // instanceColor（ノードごとの色の書き換え）はブラウザによって描画されない個体があったため使わない。
  // 道を光らせるのは、同じ位置に重ねる InstancedMesh（highlightMesh）の表示・非表示で行う。
  // クリックの当たり判定は、同じ instanceMatrix を使う見えない球（pickMeshes）で取る（板は向きが変わるため）
  const sphereGeo = new THREE.SphereGeometry(1, 16, 12);
  const dummy = new THREE.Object3D();
  // 大きさはすべて同じ（深さ・単語の終わりで変えない）。2D・格子は重ならない大きさに広げる。
  // 立方は深さごとに縮むマスの間隔（node.cubeStep）に比例させる
  // （半分の幅が間隔の 0.28 倍。0.5 未満なら隣のマスとぶつからない）
  const CUBE_NODE_FACTOR = 0.28;
  const ROOT_FACTOR = 0.5; // 根の球はほかのノードより小さく
  const nodeScale = (node) => (node.id === 0 ? ROOT_FACTOR : 1)
    * (isCubeMode(mode) ? node.cubeStep * CUBE_S0 * CUBE_NODE_FACTOR : isTopDown() ? NODE_R_2D : R * 0.06);
  const bucketGroups = new Map(); // "深さ:終わりかどうか" → ノード一覧
  for (const node of nodes) {
    if (node.id === 0) continue;
    const key = `${node.depth}:${node.isEnd ? 1 : 0}`;
    if (!bucketGroups.has(key)) bucketGroups.set(key, []);
    bucketGroups.get(key).push(node);
  }
  const bucketMeshes = [];
  const pickMeshes = [];
  const pickMat = new THREE.MeshBasicMaterial();
  const dimmables = []; // { mat, color } の一覧。道を選んでいる間、これ以外の色を暗くする
  for (const [key, list] of bucketGroups) {
    const [depthStr, endStr] = key.split(':');
    const color = depthColor(Number(depthStr), maxDepth, endStr === '1');
    const mat = makeLetterMaterial({ color });
    const geo = makeLetterGeometry(list.length);
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const nodeIds = new Array(list.length);
    list.forEach((node, i) => {
      dummy.position.copy(node.pos);
      dummy.scale.setScalar(nodeScale(node));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      geo.attributes.aLetter.array[i] = letterIndex(node);
      nodeIds[i] = node.id;
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false; // 板の向きはシェーダーで変わるので、three.js の見える範囲の計算に任せない
    scene.add(mesh);
    bucketMeshes.push(mesh);
    const pick = new THREE.InstancedMesh(sphereGeo, pickMat, list.length);
    pick.instanceMatrix = mesh.instanceMatrix; // 位置・大きさは文字の板と共通
    mesh.userData.nodeIds = pick.userData.nodeIds = nodeIds;
    pick.visible = false; // 描かない（Raycaster は visible を見ないので当たり判定には使える）
    pickMeshes.push(pick);
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

  // 道を光らせるための、同じ文字を重ねる InstancedMesh（根からの道の長さぶん）
  const MAX_PATH = 80;
  const highlightMat = makeLetterMaterial({ color: 0xff53c8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const highlightGeo = makeLetterGeometry(MAX_PATH);
  const highlightMesh = new THREE.InstancedMesh(highlightGeo, highlightMat, MAX_PATH);
  highlightMesh.frustumCulled = false;
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
  const glowPoints = new THREE.Points(glowGeo, glowMat);
  scene.add(glowPoints);

  // ---- サンバースト: 輪の弧（1 文字 1 つの扇形）。開始・終わりの角度が弧ごとに違うので
  // InstancedMesh（アフィン変換だけ）には収まらない。RingGeometry で弧ごとに三角形を作り、
  // 1 つの BufferGeometry にまとめる（球以外の既存のメッシュと同じく、描画は 1 回ですむように）。
  // どの三角形がどのノードのものかは arcOwnerByTriangle（三角形の番号 → node.id）で覚えておき、
  // ピック・ハイライトに使う。弧の位置そのものは固定（モードを切り替えても動かないので作り直さない）。
  const arcOwnerByTriangle = [];
  const arcPositions = [];
  const arcColors = [];
  for (const node of nodes) {
    if (node.id === 0) continue;
    const segs = Math.max(3, Math.min(32, Math.round((node.angleSpan / (Math.PI * 2)) * 64)));
    const gap = Math.min(node.angleSpan * 0.08, 0.01); // 弧どうしの細いすき間
    const geo = new THREE.RingGeometry(
      node.innerR, node.outerR - SUN_RW * 0.04, segs, 1,
      node.thetaStartRing + gap / 2, Math.max(node.thetaLenRing - gap, 0.0001),
    );
    const pos = geo.attributes.position.array;
    const idx = geo.index.array;
    const color = baseColors[node.id];
    node.arcVertStart = arcColors.length / 3;
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i] * 3;
      arcPositions.push(pos[v], pos[v + 1], pos[v + 2]);
      arcColors.push(color.r, color.g, color.b);
      if (i % 3 === 0) arcOwnerByTriangle.push(node.id);
    }
    node.arcVertCount = arcColors.length / 3 - node.arcVertStart;
    geo.dispose();
  }
  const arcGeo = new THREE.BufferGeometry();
  arcGeo.setAttribute('position', new THREE.Float32BufferAttribute(arcPositions, 3));
  arcGeo.setAttribute('color', new THREE.Float32BufferAttribute(arcColors, 3));
  const arcMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const arcMesh = new THREE.Mesh(arcGeo, arcMat);
  scene.add(arcMesh);

  function setArcColor(id, color) {
    const node = nodes[id];
    if (node.arcVertCount == null) return;
    const arr = arcGeo.attributes.color.array;
    for (let v = node.arcVertStart; v < node.arcVertStart + node.arcVertCount; v++) {
      arr[v * 3] = color.r; arr[v * 3 + 1] = color.g; arr[v * 3 + 2] = color.b;
    }
  }
  function resetArcColor(id, factor = 1) {
    setArcColor(id, factor === 1 ? baseColors[id] : baseColors[id].clone().multiplyScalar(factor));
  }
  function highlightArcColor(id) { setArcColor(id, highlightColor); }

  function updateVisibility() {
    const sun = mode === 'sunburst';
    arcMesh.visible = sun;
    for (const mesh of bucketMeshes) mesh.visible = !sun;
    rootMesh.visible = !sun;
    edgeMesh.visible = !sun;
    pathLineMesh.visible = !sun;
    highlightMesh.visible = !sun;
    glowPoints.visible = !sun && !isCubeMode(mode); // 立方はにじみがノードより大きく白くつぶれるので出さない
  }
  updateVisibility();

  // ---- 選択・道の光らせ方 ----
  let selectedId = 0;
  let currentPath = []; // 根からの道（道を選んでいないときは空）

  function resetColors() {
    currentPath = [];
    setDimmed(false);
    for (const id of edgeNodeIds) resetEdgeColor(id);
    edgeGeo.attributes.color.needsUpdate = true;
    for (const n of nodes) if (n.id !== 0) resetArcColor(n.id);
    arcGeo.attributes.color.needsUpdate = true;
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
    for (const n of nodes) if (n.id !== 0) resetArcColor(n.id, DIM_FACTOR);
    const path = pathToRoot(nodes[targetId]);
    currentPath = path;
    let segCount = 0;
    path.forEach((node, i) => {
      highlightEdgeColor(node.id);
      highlightArcColor(node.id);
      if (i >= MAX_PATH) return;
      dummy.position.copy(node.pos);
      dummy.scale.setScalar(node.id === 0 ? 0 : nodeScale(node) * 1.3); // 根の球は光らせない
      dummy.updateMatrix();
      highlightMesh.setMatrixAt(i, dummy.matrix);
      if (node.id !== 0) highlightGeo.attributes.aLetter.array[i] = letterIndex(node);
      if (node.parent) {
        const p = node.parent.pos, q = node.pos;
        pathLinePositions.set([p.x, p.y, p.z, q.x, q.y, q.z], segCount * 6);
        segCount++;
      }
    });
    hideHighlightFrom(path.length);
    edgeGeo.attributes.color.needsUpdate = true;
    arcGeo.attributes.color.needsUpdate = true;
    highlightMesh.instanceMatrix.needsUpdate = true;
    highlightGeo.attributes.aLetter.needsUpdate = true;
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
    const dir = mode === 'globe' ? node?.dirGlobe : node?.dir3d; // 地球は真上（地表の外側）から見下ろす
    return (node && node.id !== 0 && dir) || new THREE.Vector3(0.5, 0.35, 0.8).normalize();
  }

  function frameNodes(nodeList) {
    const center = new THREE.Vector3();
    for (const n of nodeList) center.add(n.pos);
    center.divideScalar(nodeList.length);
    let spread = R * 0.5;
    for (const n of nodeList) spread = Math.max(spread, n.pos.distanceTo(center));
    const last = nodeList[nodeList.length - 1];
    const dist = (spread / Math.sin((isTopDown() ? fovRad2D : fovRad3D) / 2)) * 1.3 + R * 0.6;
    const dir = isTopDown() ? new THREE.Vector3(0, 0, 1) : cameraDir3D(last);
    const toPos = center.clone().add(dir.clone().multiplyScalar(dist));
    if (isTopDown()) { toPos.x = center.x; toPos.y = center.y; toPos.z = dist; } // 2D・格子は常に真上から
    return { toPos, toTarget: center };
  }

  // 1 球だけを選んだときの距離。根に近い（浅い）球はそもそも周りが詰まっているので、
  // 深さが浅いほど全体を見る距離に近づけ、深いほど寄る（根からの道の一部も見える）。
  function singleNodeDistance(node) {
    const t = maxDepth > 0 ? node.depth / maxDepth : 0;
    if (isTopDown()) {
      // 距離ではなく「画面の半分の高さ（ワールド単位）」で浅い⇔深いを補間し、そこから画角で距離を出す。
      // 2D・格子・サンバーストは画角がごく狭いので、3D と同じ「距離」をそのまま流用すると寄りすぎてしまう。
      const boundHalfY = mode === 'grid' ? boundGridHalfY : mode === 'sunburst' ? sunburstOuterR : bound2DHalfY;
      const farHalf = boundHalfY * MARGIN_2D * 0.55;
      const closeHalf = R * 1.7;
      const half = farHalf * (1 - t) + closeHalf * t;
      return half / Math.tan(fovRad2D / 2);
    }
    const far = (mode === 'globe' ? overviewDistGlobe : isCubeMode(mode) ? overviewDistCube : overviewDist3D) * 0.55;
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
    const dir = isTopDown() ? new THREE.Vector3(0, 0, 1) : cameraDir3D(node);
    const toPos = node.pos.clone().add(dir.clone().multiplyScalar(dist));
    animateCamera(toPos, node.pos.clone());
  }

  function goOverview() {
    selectedId = 0;
    resetColors();
    sheetEl.hidden = true;
    animateCamera(overviewPos(), new THREE.Vector3(0, 0, 0));
  }

  // 3D / 2D / 格子の切り替え。描き方（InstancedMesh・線・にじみ・道のハイライト・ラベル）はそのまま、
  // node.pos を書き換えて位置だけ作り直す。
  function rebuildPositions() {
    for (const n of nodes) n.pos.copy(posForMode(n, mode));
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
    for (const pick of pickMeshes) pick.computeBoundingSphere(); // 当たり判定の外枠を新しい位置に合わせる
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

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    saveView(mode);
    applyControlMode();
    updateVisibility();
    rebuildPositions();
    btnView.textContent = MODE_LABEL[NEXT_MODE[mode]];
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
    if (mode === 'sunburst') {
      const hit = raycaster.intersectObject(arcMesh)[0];
      if (!hit || hit.faceIndex == null) return null;
      const id = arcOwnerByTriangle[hit.faceIndex];
      return id == null ? null : nodes[id];
    }
    const hit = raycaster.intersectObjects(pickMeshes)[0];
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

  btnView.addEventListener('click', () => { setMode(NEXT_MODE[mode]); });

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
    // 2D・格子は必ず target の真上（パンのあとなどに角度がずれない念のための保険）
    if (isTopDown()) {
      camera.position.x = controls.target.x;
      camera.position.y = controls.target.y;
      camera.up.set(0, 1, 0);
      camera.lookAt(controls.target);
    }
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();
}

main();
