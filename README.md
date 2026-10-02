# word-trie — 英単語の 3D トライ木

英単語帳を宇宙に浮かぶ文字の木（接頭辞木 / トライ木）として 3D で見る試作。

## 🔗 リンク

- 遊ぶ: https://t-of.github.io/word-trie/
- 制作: [T.OF...](https://t-of.github.io/)

## 遊び方

- 根（中心）から 1 文字目の球が放射状に伸び、各球から次の文字へ線が伸びる。根からの道が 1 つの単語（cat なら c→a→t）。単語の終わりの球は星のように光る。
- ドラッグで回転、ホイール / ピンチで拡大、右ドラッグで移動（OrbitControls）。
- 球をタップ/クリックすると、根からその球までの道が光り、その接頭辞で始まる単語が画面下に出る。
- 検索欄に打つと、1 文字ごとに道が伸びて光る。木にない文字まで来ると欄が赤くなる。
- 「ランダムな単語」で 1 語選び、1 文字ずつ順に光らせる。「全体を見る」で最初の視点に戻る。
- 表示ボタンで、宇宙に浮かぶ立体の木（3D）→ 平面の放射状の木（2D）→ 格子 → 地球儀（奇数文字目を緯度、偶数文字目を経度の方向に割る）と切り替えられる。
  選んだ方は端末に覚える。2D の間はドラッグが回転ではなく移動（パン）になる。

### 単語データ

- `words.csv`（1 行 1 語、`word,意味`。意味の列は無くてよい）を読む。無ければ `words.sample.csv`（仮の単語）を読む。
- 小文字にそろえ、a〜z 以外の文字を含む語と重複した語は取り除く（除いた件数は画面の隅に出る）。
- 今入っている `words.csv` は NGSL（New General Service List）の上位 1000 語。出典は下の「データの出典」。
  自分の単語帳に差し替えたいときは、同じ形（`word,意味`）の CSV で `words.csv` を上書きする。

## データの出典

このリポジトリは、コード以外に外部のデータ（`words.csv`）を含みます。

| 対象 | 出典 | ライセンス |
|---|---|---|
| 単語リストと頻度順（`words.csv`） | [New General Service List](https://www.newgeneralservicelist.com/new-general-service-list) — Browne, C., Culligan, B. & Phillips, J. | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| 日本語訳（`words.csv`） | `ngsl-vocab-quiz` 由来、本プロジェクトで付与 | CC BY-SA 4.0（下記） |

NGSL の表記（公式サイトのとおり）:
New General Service List by Browne, C., Culligan, B., and Phillips, J. is licensed under a
[Creative Commons Attribution-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-sa/4.0/).

**ShareAlike の範囲:** `words.csv` は NGSL の各行に訳を足したものなので、**ファイル全体を CC BY-SA 4.0** とします（訳も含む）。
アプリのコード（`trie.js`・`main.js` など）は NGSL を含まないので MIT のままです。
画面の下にも、この出典を出しています。

`words.csv` は NGSL の上位 1000 語を抜き出したものです（変更点）。

## アプリとして入れる（PWA）

- iPhone / iPad: Safari で開き、共有 → 「ホーム画面に追加」
- Android / PC の Chrome・Edge: 画面の「アプリにする」ボタン、またはアドレスバーのインストールボタン

## 開発

ビルド不要。フォルダをそのまま静的サーバで開く（`fetch` を使うため `file://` では動かない）。

```sh
python3 -m http.server 8000   # → http://localhost:8000/
```

トライ木の組み立て（CSV の整形・木の構築）は `trie.js` に、DOM に依らない形でまとめてある。

```sh
node test/trie.test.mjs   # assert だけの検査
```
