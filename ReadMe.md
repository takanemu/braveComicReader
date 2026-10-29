# デバック起動
npm run tauri:dev

# ブックマーク
アーカイブを開いた状態でメニューから「Bookmark this page」を選ぶと、現在のページをしおりとして保存できます。「Show bookmarks」から一覧表示、該当ページへの移動、削除ができます。

しおりはローカルの SQLite データベースに保存されます。アーカイブの識別には、ファイルサイズと先頭・末尾各 4 KiB から計算したハッシュ値を使用します。そのため、サイズを変えずにサンプル範囲外だけが変更されたファイルは、同じアーカイブと判定される場合があります。

# リリースビルド
npm run tauri:build

# archivefsバイナリの取得
npm run download:archivefs

# アイコン生成
npx tauri icon app-icon.png

# アーカイブを指定して起動（パスに空白がある場合は引用符で囲む）
./src-tauri/target/release/brave-comic-viewer-x86_64-unknown-linux-gnu "/path/to/comic.cbz"

# Antigravity IDE起動
antigravity . --no-sandbox

# 画像縦横比
横幅：2093px
縦幅：3000px
0.69
サムネイル画像
88px x 128px / 0.6875:1.0
