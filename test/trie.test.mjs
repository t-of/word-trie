// トライ木の組み立てを確かめる: node test/trie.test.mjs
import assert from 'node:assert/strict';
import {
  normalize, isValidWord, parseCsv, buildWordEntries, buildTrie, collectWords, wordsWithPrefix,
} from '../trie.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 整形: 大文字→小文字、a〜z 以外・重複を除く
check('整形: 大文字をそろえ、不正な語と重複を除く', () => {
  const raw = parseCsv('Cat,ねこ\nCAR,車\ncat,ねこ（重複）\nca-t,壊れた語\n123,数字\n   \ndog,犬');
  const { entries, total, removedInvalid, removedDuplicate } = buildWordEntries(raw);
  assert.equal(total, 6); // 空行は parseCsv で既に除かれる
  assert.deepEqual(entries.map((e) => e.word), ['cat', 'car', 'dog']);
  assert.equal(entries[0].meaning, 'ねこ');
  assert.equal(removedInvalid, 2); // ca-t, 123
  assert.equal(removedDuplicate, 1); // cat の重複
});

check('normalize / isValidWord', () => {
  assert.equal(normalize('  CAT '), 'cat');
  assert.equal(isValidWord('cat'), true);
  assert.equal(isValidWord('Cat'), false); // 呼ぶ前に normalize する前提
  assert.equal(isValidWord('c-a-t'), false);
  assert.equal(isValidWord(''), false);
});

// 共通の接頭辞が 1 本の道にまとまる
check('共通の接頭辞 (cat/car/card) が 1 本の道にまとまる', () => {
  const { entries } = buildWordEntries(parseCsv('cat,\ncar,\ncard,'));
  const { root, nodeCount, wordCount } = buildTrie(entries);
  // root -(c)-> c -(a)-> ca -(t)-> cat*
  //                          -(r)-> car* -(d)-> card*
  assert.equal(wordCount, 3);
  assert.equal(root.children.size, 1);
  const c = root.children.get('c');
  assert.ok(c && !c.isEnd);
  const ca = c.children.get('a');
  assert.ok(ca && !ca.isEnd);
  assert.equal(ca.children.size, 2); // t, r
  const cat = ca.children.get('t');
  assert.equal(cat.isEnd, true);
  const car = ca.children.get('r');
  assert.equal(car.isEnd, true);
  const card = car.children.get('d');
  assert.equal(card.isEnd, true);
  // ノード数: root, c, ca, cat, car, card = 6
  assert.equal(nodeCount, 6);
});

// 全単語が木から復元できる。単語の終わりの印の数が単語数と同じ
check('全単語が復元できる。単語数と終わりの印の数が一致する', () => {
  const words = ['cat', 'car', 'card', 'care', 'cart', 'dog', 'do', 'doge'];
  const { entries } = buildWordEntries(words.map((word) => ({ word, meaning: '' })));
  const { root, wordCount } = buildTrie(entries);
  const restored = collectWords(root).sort();
  assert.deepEqual(restored, [...words].sort());
  assert.equal(wordCount, words.length);

  let endCount = 0;
  (function walk(node) { if (node.isEnd) endCount++; for (const c of node.children.values()) walk(c); })(root);
  assert.equal(endCount, words.length);
});

check('wordsWithPrefix: 接頭辞で絞り込める', () => {
  const words = [['cat', 'ねこ'], ['car', '車'], ['card', 'カード'], ['dog', '犬']];
  const { entries } = buildWordEntries(words.map(([word, meaning]) => ({ word, meaning })));
  const { root } = buildTrie(entries);
  assert.deepEqual(wordsWithPrefix(root, 'ca').map((e) => e.word), ['car', 'card', 'cat']);
  assert.deepEqual(wordsWithPrefix(root, 'ca').find((e) => e.word === 'car').meaning, '車');
  assert.deepEqual(wordsWithPrefix(root, 'xx'), []);
  assert.deepEqual(wordsWithPrefix(root, '').map((e) => e.word), ['car', 'card', 'cat', 'dog']);
});

// でたらめな 1000 語でも復元できて、ノード数が妥当な範囲に収まる
check('でたらめな 1000 語: 復元とノード数', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const words = new Set();
  while (words.size < 1000) {
    const len = 3 + Math.floor(rand() * 6); // 3〜8 文字
    let w = '';
    for (let i = 0; i < len; i++) w += letters[Math.floor(rand() * 26)];
    words.add(w);
  }
  const list = [...words];
  const { entries } = buildWordEntries(list.map((word) => ({ word, meaning: '' })));
  const { root, nodeCount, wordCount } = buildTrie(entries);
  assert.equal(wordCount, list.length);
  assert.deepEqual(collectWords(root).sort(), [...list].sort());
  // ランダムな短い語なので接頭辞がよく重なり、単語数よりだいぶ少ないノード数になる
  assert.ok(nodeCount > list.length, `nodeCount=${nodeCount}`);
  assert.ok(nodeCount < list.length * 6, `nodeCount=${nodeCount}（重なりが少なすぎる）`);
  console.log(`  (でたらめ 1000 語: ノード数 ${nodeCount})`);
});

console.log(`\n${passed} 件すべて通過`);
