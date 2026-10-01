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
// 兄弟どうし・どの枝も角度が重ならない。
export function layoutRadial(root) {
  assign(root, 0, Math.PI * 2);
  function assign(node, angleStart, angleSpan) {
    node.angleStart = angleStart;
    node.angleSpan = angleSpan;
    node.angle = angleStart + angleSpan / 2;
    const children = [...node.children.values()];
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
