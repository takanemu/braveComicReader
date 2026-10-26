# コミックビューワー
## 1. 概要
Tauri(Rust)を使用して軽量でメモリ安全なアプリです。
ブラウザエンジン(WebKitGTK)経由で、GPU(OpenGL/Vulkan/WebGL)を活用して軽快な画像表示を行います。

## 2. 技術スタック・環境
- **バックエンド**: Tauri v2(Rust)
- **フロントエンド**: React + TypeScript
- **フレームワーク**: Tailwind CSS + shadcn/ui + daisyUI

## 3. ディレクトリ構成
project-root/
├── ReadMe.md
├── AGENTS.md
├── PROJECT_DESIGN.md
├── 📁 .cargo/            # Rustのパッケージマネージャー(Cargo)の設定
├── 📁 .vscode/
├── 📁 src/               # 【フロントエンド】
│   ├── App.tsx
│   ├── main.tsx
│   └── styles.css
├── 📁 src-tauri/         # 【バックエンド】
│   ├── 📁 capabilities/ # Tauri v2の権限管理（パーミッション設定）
│   ├── 📁 icons/        # アプリのアイコン画像
│   ├── 📁 src/          # Rustのソースコード
│   │   ├── lib.rs       # Rust側のメイン処理・コマンド定義
│   │   └── main.rs      # アプリのエントリーポイント
│   ├── Cargo.toml       # Rustの依存関係やパッケージ設定
│   └── tauri.conf.json  # Tauri全体の環境設定（ウィンドウサイズ、識別子など）
├─ package.json            # フロントエンドの依存関係やビルドスクリプト
├─ tsconfig.json           # TypeScriptの設定
└─ vite.config.ts          # バンドラー（Viteなど）の設定

# 実装要件・仕様・機能
- 実行環境は、Ubuntu Desktop
- GPU活用したコミックビューワー
- スレッドを活用して画面がフリーズしない実装
- 作品の管理機能(お気に入り、フォルダの移動、タグ管理、検索機能)
- サポート画像フォーマット(JPG, JP2, JXR, JXL, PNG, APNG, AVIF, WEBP, GIF, SVG, BMP, ICO)
- サポート圧縮ファイルフォーマット(RAR, ZIP, 7Z, TAR, TAR.GZ, TAR.XZ, TAR.BZIP2, TAR.ZSTD, LZH, ACE, CBR, CBZ, CBA, CB7, CBT)
- サポートドキュメントフォーマット(PDF, EPUB)
- サムネイル表示
- ブックマーク
- 高速サムネイル表示(キャッシュファイル)
- Rustのimageクレートを使用して、anczos3による高品質な縮小・拡大表示

# コーディング規約・制約事項
- The Rust Style Guide (公式スタイルガイド)
- Rust API Guidelines (APIデザインガイドライン)
- Tauriガイドライン(https://v2.tauri.app/ja/start/)
