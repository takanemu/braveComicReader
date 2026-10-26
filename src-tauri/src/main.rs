#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use brave_comic_reader::run;

/// アプリケーションの起動エントリーポイントです。
///
/// ここでは、Tauri 側の初期化やコマンド登録を行う `run` 関数を呼び出して
/// デスクトップアプリ本体を開始します。
fn main() {
  // バックエンド/フロントエンドを含む Tauri アプリの実行処理へ処理を委譲します。
  run();
}
