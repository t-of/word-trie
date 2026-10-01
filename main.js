// word-trie: 英単語の接頭辞木（トライ木）を宇宙に浮かぶ文字の木として 3D で見る。
// トライ木の組み立て（整形・構築）は trie.js にまとめてあり、node からも同じものを検査できる（test/trie.test.mjs）。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseCsv, buildWordEntries, buildTrie, pathWord, wordsWithPrefix, normalize } from './trie.js';

WebAppKit.init({ title: 'word-trie', text: '英単語帳を宇宙に浮かぶ文字の木として 3D で見る' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

const R = 1.7;          // 深さ 1 ごとの半径
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

function depthColor(depth, maxDepth, isEnd) {
  const t = maxDepth > 0 ? Math.min(depth / maxDepth, 1) : 0;
  const hue = ((0.58 - t * 0.52) % 1 + 1) % 1; // 青白 → 暖色
  const sat = 0.6 + t * 0.25;
  const light = (0.58 - t * 0.14) + (isEnd ? 0.16 : 0);
  return new THREE.Color().setHSL(hue, Math.min(sat, 1), Math.min(light, 0.92));
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
// （子孫の葉の数 = leafWeight に比例した角度を割り当て、重なりにくくする）
function layoutTree(root) {
  root.pos = new THREE.Vector3(0, 0, 0);
  const firstChildren = [...root.children.values()];
  const dirs = fibonacciSphere(firstChildren.length);
  firstChildren.forEach((child, i) => layoutSubtree(child, dirs[i], 1, 0, Math.PI * 2));
}

function layoutSubtree(node, dir, depth, azimuthStart, azimuthSpan) {
  node.dir = dir;
  node.pos = dir.clone().multiplyScalar(depth * R);
  const children = [...node.children.values()];
  if (!children.length) return;
  const totalWeight = children.reduce((s, c) => s + c.leafWeight, 0);
  const coneAngle = Math.max(0.16, 0.85 / Math.sqrt(depth + 1));
  const shrink = 0.82; // 孫の世代がさらに重ならないよう、渡す角度の幅を少し狭める
  let a = azimuthStart;
  for (const child of children) {
    const span = (child.leafWeight / totalWeight) * azimuthSpan;
    const mid = a + span / 2;
    const childDir = tiltDir(dir, coneAngle, mid);
    layoutSubtree(child, childDir, depth + 1, mid - (span * shrink) / 2, span * shrink);
    a += span;
  }
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
  layoutTree(root);
  const nodes = flattenNodes(root, nodeCount);
  const endNodes = nodes.filter((n) => n.isEnd);
  let maxDepth = 0;
  for (const n of nodes) if (n.depth > maxDepth) maxDepth = n.depth;

  statsEl.textContent = `読み込み ${total} 語 / 使用 ${wordCount} 語`
    + (removedInvalid || removedDuplicate ? `（除外: 不正 ${removedInvalid}・重複 ${removedDuplicate}）` : '');

  const baseColors = nodes.map((n) => depthColor(n.depth, maxDepth, n.isEnd));
  const highlightColor = new THREE.Color(0xffffff);

  // ---- three.js の下ごしらえ ----
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060d);
  buildBackground(scene);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
  const overviewDist = Math.max(8, (maxDepth || 1) * R * 1.9);
  const overviewPos = new THREE.Vector3(overviewDist * 0.5, overviewDist * 0.35, overviewDist * 0.8);
  camera.position.copy(overviewPos);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  sceneEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1;
  controls.maxDistance = overviewDist * 4;
  controls.target.set(0, 0, 0);

  // 球: 深さ・単語の終わりかどうかでまとめた InstancedMesh（色は材質ごとの固定色）。
  // instanceColor（球ごとの色の書き換え）はブラウザによって描画されない個体があったため使わない。
  // 道を光らせるのは、同じ位置に重ねる白い InstancedMesh（highlightMesh）の表示・非表示で行う。
  const sphereGeo = new THREE.IcosahedronGeometry(1, 1);
  const dummy = new THREE.Object3D();
  const sphereScale = (node) => {
    const base = node.id === 0 ? 0.1 : Math.max(0.1, 0.26 - node.depth * 0.008);
    return node.isEnd ? base * 1.7 : base;
  };
  const bucketGroups = new Map(); // "深さ:終わりかどうか" → ノード一覧
  for (const node of nodes) {
    if (node.id === 0) continue;
    const key = `${node.depth}:${node.isEnd ? 1 : 0}`;
    if (!bucketGroups.has(key)) bucketGroups.set(key, []);
    bucketGroups.get(key).push(node);
  }
  const bucketMeshes = [];
  for (const [key, list] of bucketGroups) {
    const [depthStr, endStr] = key.split(':');
    const mat = new THREE.MeshBasicMaterial({ color: depthColor(Number(depthStr), maxDepth, endStr === '1') });
    const mesh = new THREE.InstancedMesh(sphereGeo, mat, list.length);
    const nodeIds = new Array(list.length);
    list.forEach((node, i) => {
      dummy.position.copy(node.pos);
      dummy.scale.setScalar(sphereScale(node));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      nodeIds[i] = node.id;
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.nodeIds = nodeIds;
    scene.add(mesh);
    bucketMeshes.push(mesh);
  }
  const rootMesh = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0x33415a }));
  rootMesh.scale.setScalar(sphereScale(root));
  scene.add(rootMesh);

  // 道を光らせるための、白い球を重ねる InstancedMesh（根からの道の長さぶん）
  const MAX_PATH = 80;
  const highlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
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

  function resetEdgeColor(id) {
    const node = nodes[id];
    if (!node.parent) return;
    const i = edgeIndexByNodeId.get(id);
    const c1 = baseColors[node.parent.id], c2 = baseColors[id];
    edgeColors.set([c1.r, c1.g, c1.b, c2.r, c2.g, c2.b], i * 6);
  }
  function highlightEdgeColor(id) {
    const i = edgeIndexByNodeId.get(id);
    if (i == null) return;
    edgeColors.set([highlightColor.r, highlightColor.g, highlightColor.b, highlightColor.r, highlightColor.g, highlightColor.b], i * 6);
  }

  // 単語の終わり: 星のようなにじみ（加算合成の Points）を 1 つにまとめる
  const glowPositions = new Float32Array(endNodes.length * 3);
  endNodes.forEach((n, i) => { glowPositions[i * 3] = n.pos.x; glowPositions[i * 3 + 1] = n.pos.y; glowPositions[i * 3 + 2] = n.pos.z; });
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPositions, 3));
  const glowTex = makeGlowTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
  const glowMat = new THREE.PointsMaterial({ map: glowTex, size: 1.1, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85 });
  scene.add(new THREE.Points(glowGeo, glowMat));

  // ---- ラベル（文字）: プールを使い回す ----
  const labelPool = [];
  for (let i = 0; i < LABEL_COUNT + 1; i++) {
    const el = document.createElement('div');
    el.className = 'node-label';
    labelsEl.appendChild(el);
    labelPool.push(el);
  }

  function updateLabels() {
    const w = sceneEl.clientWidth, h = sceneEl.clientHeight;
    const scored = nodes.map((n) => ({ n, d: n.pos.distanceToSquared(camera.position) }));
    scored.sort((a, b) => a.d - b.d);
    const top = scored.slice(0, LABEL_COUNT).map((s) => s.n);
    if (hoverNode && !top.includes(hoverNode)) top[top.length - 1] = hoverNode;
    for (let i = 0; i < labelPool.length; i++) {
      const el = labelPool[i];
      const node = top[i];
      if (!node || node.id === 0) { el.classList.remove('is-visible'); continue; }
      const v = node.pos.clone().project(camera);
      if (v.z < -1 || v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) { el.classList.remove('is-visible'); continue; }
      el.style.left = `${(v.x * 0.5 + 0.5) * w}px`;
      el.style.top = `${(-v.y * 0.5 + 0.5) * h}px`;
      el.textContent = node.char.toUpperCase();
      el.classList.add('is-visible');
      el.classList.toggle('is-hover', node === hoverNode);
    }
  }

  // ---- 選択・道の光らせ方 ----
  let selectedId = 0;
  let hoverNode = null;

  function resetColors() {
    for (const id of edgeNodeIds) resetEdgeColor(id);
    edgeGeo.attributes.color.needsUpdate = true;
    hideHighlightFrom(0);
    highlightMesh.instanceMatrix.needsUpdate = true;
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
    for (const id of edgeNodeIds) resetEdgeColor(id);
    const path = pathToRoot(nodes[targetId]);
    path.forEach((node, i) => {
      highlightEdgeColor(node.id);
      if (i >= MAX_PATH) return;
      dummy.position.copy(node.pos);
      dummy.scale.setScalar(sphereScale(node) * 1.4);
      dummy.updateMatrix();
      highlightMesh.setMatrixAt(i, dummy.matrix);
    });
    hideHighlightFrom(path.length);
    edgeGeo.attributes.color.needsUpdate = true;
    highlightMesh.instanceMatrix.needsUpdate = true;
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

  function selectNode(id, { moveCamera = true } = {}) {
    selectedId = id;
    lightPath(id);
    showSheet(nodes[id]);
    if (moveCamera) {
      const node = nodes[id];
      const dist = Math.max(2, node.depth * R * 0.4 + 1.5);
      const dir = node.id === 0 ? new THREE.Vector3(0.5, 0.35, 0.8).normalize() : node.dir;
      const toPos = node.pos.clone().add(dir.clone().multiplyScalar(dist));
      animateCamera(toPos, node.pos.clone());
    }
  }

  function goOverview() {
    selectedId = 0;
    resetColors();
    sheetEl.hidden = true;
    animateCamera(overviewPos, new THREE.Vector3(0, 0, 0));
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
      selectNode(path[i - 1].id, { moveCamera: isLast });
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
    updateLabels();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();
}

main();
