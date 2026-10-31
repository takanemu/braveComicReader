# Brave Comic Reader

Linux 向けのデスクトップコミックリーダーです。アーカイブ内の画像をページ送りで閲覧でき、サムネイル、見開き表示、しおりなどの機能を備えています。

> 現在開発中です。アーカイブ形式や画像形式は、ファイルの内容や圧縮方式によって読み込めない場合があります。

## 主な機能

- アーカイブ内の画像を閲覧
- PDFのページを閲覧
- 画面サイズとディスプレイ倍率に合わせたPDFページ描画（最大約3,300万画素）
- 開閉できるサムネイルサイドペインからのページ移動
- 1ページ表示と見開き表示
- ページ遷移アニメーションの設定
- 近隣ページのキャッシュ、またはアーカイブ全体の先読み
- ページ単位のしおりの保存、一覧表示、削除
- 読書位置と設定のローカル保存

## 対応環境

- Linux デスクトップ（Ubuntu を主な対象としています）
- x86_64 (`x86_64-unknown-linux-gnu`)
- Rust 1.85 以降
- Node.js と npm

## 対応形式

ファイル選択画面では、PDFと次のアーカイブ拡張子を選択できます。

- ZIP / CBZ
- 7Z / CB7
- RAR / CBR
- TAR
- GZ / TGZ / TAR.GZ
- BZ2 / TBZ / TBZ2 / TAR.BZ2
- XZ / TXZ / TAR.XZ
- ZST / TAR.ZST / TAR.ZSTD

アーカイブ内のページ画像として現在読み込む拡張子は次のとおりです。

- PNG
- JPG / JPEG
- WebP
- GIF
- BMP
- AVIF

ファイル選択画面に表示される形式でも、アーカイブの圧縮方式や内容によっては開けないことがあります。

## 開発環境のセットアップ

Rust、Node.js/npm、および Tauri v2 の Linux 開発用システム依存パッケージを事前にインストールしてください。必要なパッケージは、利用する Linux ディストリビューションの [Tauri v2 前提条件](https://v2.tauri.app/start/prerequisites/)を参照してください。

```bash
git clone https://github.com/takanemu/braveComicReader.git
cd braveComicReader
npm install
```

## 起動とビルド

開発モードで起動します。

```bash
npm run tauri:dev
```

インストーラーパッケージを含むリリースビルドを作成します。

```bash
npm run tauri:build
```

`.deb` パッケージは `src-tauri/target/release/bundle/deb/` に出力されます。実行ファイルのみをビルドする場合は、次のコマンドを使います。

```bash
npm run tauri:release
```

各 Tauri ビルドコマンドは、`archivefs` と PDFium 151.0.7881.0 のLinux x86_64バイナリを、SHA-256を検証して取得してからビルドします。PDFiumライブラリとライセンス文書はアプリに同梱されます。現在、これらのダウンロードスクリプトが対応しているのは `x86_64-unknown-linux-gnu` です。

## アーカイブを指定して起動

ビルド済みアプリにアーカイブのパスを渡して起動できます。パスに空白が含まれる場合は引用符で囲んでください。

```bash
./src-tauri/target/release/brave-comic-viewer-x86_64-unknown-linux-gnu "/path/to/comic.cbz"
```

## しおりと保存データ

アーカイブを開いた状態で **Bookmark this page** を選ぶと、現在のページをしおりに登録できます。**Show bookmarks** から登録済みのページへの移動や削除ができます。

しおりと読書位置はローカルの SQLite データベースに、表示設定は設定ファイルに保存されます。アーカイブの識別には、ファイルサイズと先頭・末尾各 4 KiB から計算したハッシュ値を使用します。そのため、ファイルサイズを変えずにサンプル範囲外だけが変更された場合、以前と同じアーカイブとして識別されることがあります。

## ライセンス

[MIT License](LICENSE)

PDFの描画には[PDFium](https://pdfium.googlesource.com/pdfium/)を使用し、描画ページは可逆WebPで表示します。PDFiumおよび配布バイナリに含まれるサードパーティライブラリのライセンス文書は、アプリのリソースに同梱しています。バイナリ配布版は [`bblanchon/pdfium-binaries`](https://github.com/bblanchon/pdfium-binaries) から取得します。
