// トライ木の組み立て（DOM に依らない）。ブラウザからも node の検査からも同じものを import する。

// 英単語を小文字にそろえる。前後の空白も取る。
export function normalize(word) {
  return String(word).trim().toLowerCase();
}

// a〜z だけ、1 文字以上かどうか
export function isValidWord(word) {
  return /^[a-z]+$/.test(word);
}

// CSV の文字列 → [{ word, meaning }]（まだ整形していない生のまま）
export function parseCsv(text) {
  return String(text)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const i = line.indexOf(',');
      const word = i === -1 ? line : line.slice(0, i);
      const meaning = i === -1 ? '' : line.slice(i + 1).trim();
      return { word, meaning };
    });
}

// 生の行 → 整形した単語一覧 + 読んだ数・取り除いた数
export function buildWordEntries(rawEntries) {
  const seen = new Set();
  const entries = [];
  let removedInvalid = 0;
  let removedDuplicate = 0;
  for (const { word, meaning } of rawEntries) {
    const w = normalize(word);
    if (!isValidWord(w)) { removedInvalid++; continue; }
    if (seen.has(w)) { removedDuplicate++; continue; }
    seen.add(w);
    entries.push({ word: w, meaning: meaning || '' });
  }
  return { entries, total: rawEntries.length, removedInvalid, removedDuplicate };
}

let nextId = 0;
function makeNode(char, depth, parent) {
  return { id: nextId++, char, depth, parent, children: new Map(), isEnd: false, meaning: '', leafWeight: 0 };
}

// 単語一覧 → トライ木。root.char は null、深さ 0
export function buildTrie(entries) {
  nextId = 0;
  const root = makeNode(null, 0, null);
  let nodeCount = 1;
  for (const { word, meaning } of entries) {
    let node = root;
    for (const ch of word) {
      let next = node.children.get(ch);
      if (!next) { next = makeNode(ch, node.depth + 1, node); node.children.set(ch, next); nodeCount++; }
      node = next;
    }
    node.isEnd = true;
    node.meaning = meaning;
  }
  computeLeafWeights(root);
  return { root, nodeCount, wordCount: entries.length };
}

// 枝ごとの「末端の単語数」。描画で兄弟の角度配分に使う
function computeLeafWeights(node) {
  let weight = node.isEnd ? 1 : 0;
  for (const child of node.children.values()) weight += computeLeafWeights(child);
  node.leafWeight = Math.max(weight, 1);
  return weight;
}

// 根からの道の文字をつなげた文字列
export function pathWord(node) {
  const chars = [];
  for (let n = node; n && n.char; n = n.parent) chars.push(n.char);
  return chars.reverse().join('');
}

// 木 → 木に入っている単語の集合（復元の検査に使う）
export function collectWords(root) {
  const out = [];
  (function walk(node) {
    if (node.isEnd) out.push(pathWord(node));
    for (const child of node.children.values()) walk(child);
  })(root);
  return out;
}

// 接頭辞をたどってそのノードを返す。途中で道が切れたら null
export function findNode(root, prefix) {
  let node = root;
  for (const ch of normalize(prefix)) {
    node = node.children.get(ch);
    if (!node) return null;
  }
  return node;
}

// 接頭辞から始まる単語一覧（{ word, meaning }）。五十音ならぬアルファベット順
export function wordsWithPrefix(root, prefix) {
  const start = findNode(root, prefix);
  if (!start) return [];
  const out = [];
  (function walk(node) {
    if (node.isEnd) out.push({ word: pathWord(node), meaning: node.meaning });
    for (const ch of [...node.children.keys()].sort()) walk(node.children.get(ch));
  })(start);
  return out;
}

// 2D の平面放射状レイアウト（DOM にも three.js にも依らない）。
// 各ノードに angleStart・angleSpan・angle（扇形の中心角, ラジアン）を書き込む。
// 親の持つ扇形 [angleStart, angleStart+angleSpan) を、子孫の葉の数（leafWeight）に
// 比例した幅で子にそのまま配り切る（先祖から受け継いだ分を超えて広げ直さない）ので、
// 兄弟どうし・どの枝も角度が重ならない。子はアルファベット順に、角度の小さい方から並べる。
export function layoutRadial(root) {
  assign(root, 0, Math.PI * 2);
  function assign(node, angleStart, angleSpan) {
    node.angleStart = angleStart;
    node.angleSpan = angleSpan;
    node.angle = angleStart + angleSpan / 2;
    const children = [...node.children.keys()].sort().map((ch) => node.children.get(ch));
    if (!children.length) return;
    const total = children.reduce((s, c) => s + c.leafWeight, 0);
    let a = angleStart;
    for (const child of children) {
      const span = (child.leafWeight / total) * angleSpan;
      assign(child, a, span);
      a += span;
    }
  }
}

// 格子レイアウト（DOM にも three.js にも依らない）。
// 深さ d のノードは、子を d が偶数なら x 方向、奇数なら y 方向に一列に並べる（親がその列の先頭、
// 子はアルファベット順）。根（深さ 0）の子 = 1 文字目は横に一列、2 文字目は縦、3 文字目は横…と交互になる。
// 部分木ごとの外枠（box）を下から求め、兄弟の部分木は外枠の分だけずらして重ならないようにする。
// ノードには x, y（格子の目盛り単位。1 目盛り = G）を書き込む。
export function layoutGrid(root) {
  const G = 1;
  const kids = (n) => [...n.children.keys()].sort().map((ch) => n.children.get(ch));
  function size(n) {
    const ax = n.depth % 2 === 0 ? 'x' : 'y', bx = ax === 'x' ? 'y' : 'x';
    const ks = kids(n);
    ks.forEach(size);
    n.box = { x: G, y: G };
    if (ks.length) {
      n.box[ax] = G + ks.reduce((s, k) => s + k.box[ax], 0);
      n.box[bx] = Math.max(G, ...ks.map((k) => k.box[bx]));
    }
  }
  function place(n, x, y) {
    n.x = x; n.y = y;
    const ax = n.depth % 2 === 0 ? 'x' : 'y';
    const p = { x, y }; p[ax] += G;
    for (const k of kids(n)) { place(k, p.x, p.y); p[ax] += k.box[ax]; }
  }
  size(root);
  place(root, 0, 0);
}

// 地球儀レイアウト（DOM にも three.js にも依らない）。
// 地表を「高さ z = sin(緯度)（-1〜1）× 経度 lon（0〜2π）」の長方形とみなし、親のマスを子に
// leafWeight に比例した幅でそのまま配り切る。z で割るので、極の近くでも帯の面積が単語数どおりになる。
// 割る向きは文字目で交互: 奇数文字目（深さ 0・2・4… の子）は緯度の方向（a が北）、偶数文字目は経度の方向。
// ノードには zStart・zSpan・lonStart・lonSpan（マス）と z・lon（マスの中心）を書き込む。
export function layoutGlobe(root) {
  assign(root, -1, 2, 0, Math.PI * 2);
  function assign(n, zStart, zSpan, lonStart, lonSpan) {
    Object.assign(n, { zStart, zSpan, lonStart, lonSpan, z: zStart + zSpan / 2, lon: lonStart + lonSpan / 2 });
    const ks = [...n.children.keys()].sort().map((ch) => n.children.get(ch));
    const total = ks.reduce((s, k) => s + k.leafWeight, 0);
    let top = zStart + zSpan, west = lonStart;
    for (const k of ks) {
      const f = k.leafWeight / total;
      if (n.depth % 2 === 0) { top -= f * zSpan; assign(k, top, f * zSpan, lonStart, lonSpan); }
      else { assign(k, zStart, zSpan, west, f * lonSpan); west += f * lonSpan; }
    }
  }
}

// 入れ子の立方体レイアウト（DOM にも three.js にも依らない）。親の立方体を 3×3×3 に分け、
// 中心に自分、周りの 26 マス（= 3^3 − 1）に子を置く。向きは {-1,0,1}^3 から (0,0,0) を除いた
// 26 方向（CUBE_DIRS）から、文字 a〜z の番号で選ぶ（同じ文字はいつも同じ向き）。
// 並びは電話のボタンのように、上の段（y=1）から: 段の中は奥（z=-1）の列から手前へ、列の中は左（x=-1）から右へ。
// 上の段 a〜i、真ん中の段 j〜q（中心は自分なので飛ばす）、下の段 r〜z。
export const CUBE_DIRS = (() => {
  const dirs = [];
  for (const y of [1, 0, -1]) for (const z of [-1, 0, 1]) for (const x of [-1, 0, 1]) {
    if (x || y || z) dirs.push([x, y, z]);
  }
  return dirs;
})();

// 子の一辺 = 親の一辺 × CUBE_R。隣のマス（間隔 = 親の一辺/3）と重ならないための十分条件:
// 部分木全体の、ある軸方向への伸び（同じ向きの子を再帰的にたどった極限）は
// Σ[k=1..∞] 親の一辺 × CUBE_R^k / 3 = 親の一辺/3 × CUBE_R/(1−CUBE_R) に収束する。
// これがマス半分の幅（親の一辺/6）を超えないためには CUBE_R ≤ 1/3 が必要（等号で一致、実際の木は
// 有限の深さなのでさらに余裕がある）。0.3 はこれより少し小さく、隙間が目で見てわかる値。
export const CUBE_R = 0.3;

export function layoutCube(root) {
  root.cubeX = 0; root.cubeY = 0; root.cubeZ = 0;
  root.cubeSize = 1; // 一辺の長さ（根の一辺を 1 とした比率）。world 単位への変換は呼び出し側で行う
  root.cubeStep = root.cubeSize / 3; // 自分の子が置かれる間隔（球の大きさの目安に使う）
  (function walk(node) {
    for (const [ch, child] of node.children) {
      const idx = ch.charCodeAt(0) - 97; // 'a' → 0 ... 'z' → 25
      const [dx, dy, dz] = CUBE_DIRS[idx];
      const step = node.cubeSize / 3;
      child.cubeX = node.cubeX + dx * step;
      child.cubeY = node.cubeY + dy * step;
      child.cubeZ = node.cubeZ + dz * step;
      child.cubeSize = node.cubeSize * CUBE_R;
      child.cubeStep = child.cubeSize / 3;
      walk(child);
    }
  })(root);
}
