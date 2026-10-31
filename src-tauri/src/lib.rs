mod archive;
mod bookmarks;
mod pdf;

use archive::ArchiveError;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{Emitter, Manager};
use thiserror::Error;
//use chrono::Local;

#[derive(Clone, Serialize)]
pub struct ArchiveProgress {
  pub loaded: usize,
  pub total: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheMode {
  Nearby,
  FullArchive,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PageTransition {
  Cut,
  CrossDissolve,
}

impl Default for PageTransition {
  fn default() -> Self {
    Self::CrossDissolve
  }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
  pub cache_mode: CacheMode,
  pub spread_mode: bool,
  pub page_transition: PageTransition,
}

impl Default for AppSettings {
  fn default() -> Self {
    Self {
      cache_mode: CacheMode::Nearby,
      spread_mode: false,
      page_transition: PageTransition::default(),
    }
  }
}

#[derive(Debug, Error, Serialize)]
pub enum AppError {
  #[error("Invalid archive path")]
  InvalidArchivePath,
  #[error("Page index out of range")]
  PageIndexOutOfRange,
  #[error("Archive error: {0}")]
  Archive(String),
  #[error("Internal error: {0}")]
  Internal(String),
}

impl From<ArchiveError> for AppError {
  fn from(value: ArchiveError) -> Self {
    Self::Archive(value.to_string())
  }
}

#[derive(Serialize)]
pub struct ArchiveInfo {
  pub page_count: usize,
  pub page_names: Vec<String>,
}

#[derive(Serialize)]
pub struct PagePayload {
  pub name: String,
  pub data: Vec<u8>,
  pub mime_type: String,
}

#[derive(Clone, Serialize)]
pub struct ArchivePageThumbnail {
  pub index: usize,
  pub name: String,
  pub data: Vec<u8>,
  pub mime_type: String,
}

#[derive(Clone, Serialize)]
pub struct ArchivePageThumbnailBatch {
  pub thumbnails: Vec<ArchivePageThumbnail>,
}

#[derive(Clone, Serialize)]
pub struct ExtractedZipThumbnail {
  pub name: String,
  pub path: String,
  pub mime_type: String,
}

static APP_START: OnceLock<Instant> = OnceLock::new();

/// アプリ起動からの経過時間をミリ秒で返します。
///
/// ログに相対時刻を付けるために使い、処理の前後関係を追いやすくします。
fn app_elapsed_ms() -> u128 {
  APP_START.get().map(|start| start.elapsed().as_millis()).unwrap_or(0)
}

fn format_duration(duration: std::time::Duration) -> String {
  let total_millis = duration.as_millis();
  let minutes = total_millis / 60_000;
  let seconds = (total_millis % 60_000) / 1_000;
  let millis = total_millis % 1_000;
  format!("{:02}:{:02}.{:03}", minutes, seconds, millis)
}

pub mod commands {
  use super::{AppError, AppSettings, ArchiveInfo, ArchivePageThumbnail, ArchivePageThumbnailBatch, ArchiveProgress, PagePayload};
  use crate::archive::{
    get_archive_info as read_archive_info, get_archive_info_with_progress as read_archive_info_with_progress, prefetch_archive_page_range_at_resolution, preload_archive_cache,
    read_archive_page_thumbnails_range,
  };
  use crate::bookmarks::{self, ArchiveIdentity, Bookmark, LastReadPage};
  use crate::{app_elapsed_ms, extract_archive_thumbnails_to_memory, format_duration};
  use chrono::Local;
  use std::fs;
  use tauri::{Emitter, Manager};

  fn bookmark_database_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    let data_dir = app.path().app_data_dir().map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(data_dir.join("bookmarks.sqlite"))
  }

  fn settings_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    let config_dir = app.path().app_config_dir().map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(config_dir.join("settings.json"))
  }

  #[tauri::command]
  pub fn load_settings(app: tauri::AppHandle) -> Result<AppSettings, AppError> {
    let path = settings_file(&app)?;
    match fs::read(path) {
      Ok(contents) => Ok(serde_json::from_slice(&contents).unwrap_or_default()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AppSettings::default()),
      Err(error) => Err(AppError::Internal(error.to_string())),
    }
  }

  #[tauri::command]
  pub fn save_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), AppError> {
    let path = settings_file(&app)?;
    let config_dir = path.parent().ok_or_else(|| AppError::Internal("settings path has no parent directory".into()))?;
    fs::create_dir_all(config_dir).map_err(|error| AppError::Internal(error.to_string()))?;

    let temporary_path = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(&settings).map_err(|error| AppError::Internal(error.to_string()))?;
    fs::write(&temporary_path, contents).map_err(|error| AppError::Internal(error.to_string()))?;
    fs::rename(temporary_path, path).map_err(|error| AppError::Internal(error.to_string()))
  }

  #[tauri::command]
  /// 動作確認用の疎通コマンドです。
  ///
  /// フロントエンドから呼び出して、バックエンドが応答できるかを簡単に確認します。
  pub fn ping() -> Result<String, AppError> {
    Ok("pong".into())
  }

  #[tauri::command]
  pub fn get_startup_archive_path() -> Result<Option<String>, AppError> {
    std::env::args_os().nth(1).map(|path| path.into_string().map_err(|_| AppError::InvalidArchivePath)).transpose()
  }

  #[tauri::command]
  /// アーカイブ内ページの基本情報（ページ数とファイル名一覧）を取得します。
  pub fn get_archive_info(path: String) -> Result<ArchiveInfo, AppError> {
    // 空文字パスは不正入力として早期にエラーを返します。
    if path.is_empty() {
      return Err(AppError::InvalidArchivePath);
    }

    // 実際の読み取り処理は archive モジュールに委譲します。
    let archive_path = std::path::Path::new(&path);
    let (page_count, page_names) = read_archive_info(archive_path)?;
    Ok(ArchiveInfo { page_count, page_names })
  }

  #[tauri::command]
  pub async fn identify_archive(path: String, app: tauri::AppHandle) -> Result<ArchiveIdentity, AppError> {
    if path.is_empty() {
      return Err(AppError::InvalidArchivePath);
    }

    let database_path = bookmark_database_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || bookmarks::identify_archive(&database_path, std::path::Path::new(&path)))
      .await
      .map_err(|error| AppError::Internal(error.to_string()))?
  }

  #[tauri::command]
  pub async fn create_bookmark(path: String, page_index: usize, app: tauri::AppHandle) -> Result<Bookmark, AppError> {
    if path.is_empty() {
      return Err(AppError::InvalidArchivePath);
    }

    let database_path = bookmark_database_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
      let archive_path = std::path::Path::new(&path);
      let (_, page_names) = read_archive_info(archive_path)?;
      let page_name = page_names.get(page_index).ok_or(AppError::PageIndexOutOfRange)?;
      let archive = bookmarks::identify_archive(&database_path, archive_path)?;
      bookmarks::add_bookmark(&database_path, &archive.id, page_index, page_name)
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
  }

  #[tauri::command]
  pub fn list_bookmarks(archive_id: String, app: tauri::AppHandle) -> Result<Vec<Bookmark>, AppError> {
    if uuid::Uuid::parse_str(&archive_id).is_err() {
      return Err(AppError::Internal("Invalid archive ID".into()));
    }

    bookmarks::list_bookmarks(&bookmark_database_file(&app)?, &archive_id)
  }

  #[tauri::command]
  pub fn get_last_read_page(archive_id: String, app: tauri::AppHandle) -> Result<Option<LastReadPage>, AppError> {
    if uuid::Uuid::parse_str(&archive_id).is_err() {
      return Err(AppError::Internal("Invalid archive ID".into()));
    }

    bookmarks::get_last_read_page(&bookmark_database_file(&app)?, &archive_id)
  }

  #[tauri::command]
  pub fn save_last_read_page(archive_id: String, page_index: usize, page_name: String, app: tauri::AppHandle) -> Result<(), AppError> {
    if uuid::Uuid::parse_str(&archive_id).is_err() {
      return Err(AppError::Internal("Invalid archive ID".into()));
    }
    if page_name.is_empty() {
      return Err(AppError::Internal("Invalid page name".into()));
    }

    bookmarks::save_last_read_page(&bookmark_database_file(&app)?, &archive_id, page_index, &page_name)
  }

  #[tauri::command]
  pub fn delete_bookmark(bookmark_id: String, app: tauri::AppHandle) -> Result<(), AppError> {
    if uuid::Uuid::parse_str(&bookmark_id).is_err() {
      return Err(AppError::Internal("Invalid bookmark ID".into()));
    }

    bookmarks::delete_bookmark(&bookmark_database_file(&app)?, &bookmark_id)
  }

  #[tauri::command]
  /// 指定ページの画像データを取得します。
  pub async fn get_page(path: String, page_index: usize, max_width: u32, max_height: u32) -> Result<PagePayload, AppError> {
    // 入力値チェック: パスが空なら処理を続けません。
    if path.is_empty() {
      return Err(AppError::InvalidArchivePath);
    }

    tauri::async_runtime::spawn_blocking(move || {
      let archive_path = std::path::Path::new(&path);
      println!("[{}] [archive] get_page start page_index={}", Local::now().format("%Y/%m/%d %H:%M:%S%.3f"), page_index);
      let page = crate::archive::read_archive_page_at_resolution(archive_path, page_index, max_width, max_height);

      match &page {
        Ok(page) => {
          println!(
            "[{}] [archive] get_page completed page_index={} name={} cached_via_read_archive_page",
            Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
            page_index,
            page.name
          );
        }
        Err(err) => {
          eprintln!("[{}] [archive] get_page failed page_index={} err={}", Local::now().format("%Y/%m/%d %H:%M:%S%.3f"), page_index, err);
        }
      }

      let page = page?;
      Ok(PagePayload {
        name: page.name,
        data: page.data,
        mime_type: page.mime_type,
      })
    })
    .await
    .map_err(|err| AppError::Internal(format!("Page loading task failed: {err}")))?
  }

  #[tauri::command]
  /// アーカイブの事前読み込み（スキャン）を行い、進捗をイベントで通知します。
  pub async fn preload_archive(path: String, app: tauri::AppHandle) -> Result<ArchiveInfo, AppError> {
    // 不正な入力を先に弾いて、以降の処理を安全にします。
    if path.is_empty() {
      return Err(AppError::InvalidArchivePath);
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<ArchiveInfo, AppError> {
      println!("[{}] [archive] preload_archive start path=\"{}\"", Local::now().format("%Y/%m/%d %H:%M:%S%.3f"), path);
      let archive_path = std::path::Path::new(&path);
      // バックエンドの進捗を受け取り、フロントエンドへイベント送信します。
      let progress_callback = |loaded: usize, total: usize| {
        println!("[{}] [archive] preload_archive progress {}/{}", Local::now().format("%Y/%m/%d %H:%M:%S%.3f"), loaded, total);
        let _ = app.emit("archive-progress", ArchiveProgress { loaded, total });
      };
      let (page_count, page_names) = read_archive_info_with_progress(archive_path, Some(&progress_callback))?;
      println!("[{}] [archive] preload_archive scan_complete pages={}", Local::now().format("%Y/%m/%d %H:%M:%S%.3f"), page_count);
      // 最後に 100% 相当の進捗を送って完了を明示します。
      let _ = app.emit(
        "archive-progress",
        ArchiveProgress {
          loaded: page_count,
          total: page_count.max(1),
        },
      );
      Ok(ArchiveInfo { page_count, page_names })
    })
    .await
    .map_err(|err| AppError::Internal(format!("Archive scan task failed: {err}")))?
  }

  #[tauri::command]
  /// ページキャッシュ作成をバックグラウンドで開始し、進捗とサムネイルを逐次通知します。
  pub fn preload_archive_pages(path: String, page_count: usize, max_dimension: u32, app: tauri::AppHandle) -> Result<(), AppError> {
    if path.is_empty() {
      return Err(AppError::InvalidArchivePath);
    }

    println!(
      "[{}ms] [archive] preload_archive_pages start path=\"{}\" page_count={} max_dimension={}",
      app_elapsed_ms(),
      path,
      page_count,
      max_dimension
    );
    // 開始時点の進捗（0%）を通知します。
    let _ = app.emit("archive-progress", ArchiveProgress { loaded: 0, total: page_count.max(1) });

    // コマンド呼び出し元をブロックしないよう、重い処理は別スレッドで実行します。
    let app_thread = app.clone();
    let path_thread = path.clone();
    let _thread_handle = std::thread::spawn(move || {
      let archive_path = std::path::Path::new(&path_thread);
      // キャッシュ作成の進捗を受け取り、UI に反映できるようイベント送信します。
      let progress_callback = |loaded: usize, total: usize| {
        println!("[{}ms] [archive] preload_archive_pages progress {}/{}", app_elapsed_ms(), loaded, total);
        let _ = app_thread.emit("archive-progress", ArchiveProgress { loaded, total });
      };
      // 1ページ分のサムネイルができるたびに即時送信します。
      let page_thumb_callback = |index: usize, name: &str, data: &[u8], mime_type: &str| {
        println!("[{}ms] [archive] preload_archive_pages thumbnail index={} name=\"{}\"", app_elapsed_ms(), index, name);
        let _ = app_thread.emit(
          "archive-page-thumbnail",
          ArchivePageThumbnail {
            index,
            name: name.to_string(),
            data: data.to_vec(),
            mime_type: mime_type.to_string(),
          },
        );
      };

      // 実際のキャッシュ生成処理を実行します。
      let result = preload_archive_cache(archive_path, Some(&progress_callback), Some(&page_thumb_callback), None, max_dimension);
      match result {
        Ok(_) => println!("[{}ms] [archive] preload_archive_pages finished {} pages", app_elapsed_ms(), page_count),
        Err(err) => eprintln!("[{}ms] [archive] preload_archive_pages error: {}", app_elapsed_ms(), err),
      }
      // 成否に関わらず最終進捗を送って、UI 側で終了判定しやすくします。
      let _ = app_thread.emit(
        "archive-progress",
        ArchiveProgress {
          loaded: page_count,
          total: page_count.max(1),
        },
      );
    });

    println!("[{}ms] [archive] preload_archive_pages spawned thread", app_elapsed_ms());
    Ok(())
  }

  #[tauri::command]
  /// 指定範囲のページサムネイルをまとめて取得して返します。
  pub fn get_page_thumbnail_range(path: String, start_index: usize, count: usize, max_dimension: u32) -> Result<Vec<PagePayload>, AppError> {
    if path.is_empty() {
      return Err(AppError::InvalidArchivePath);
    }

    let archive_path = std::path::Path::new(&path);
    let pages = read_archive_page_thumbnails_range(archive_path, start_index, count, max_dimension)?;
    // 内部型をフロントエンド向けの `PagePayload` に変換して返します。
    Ok(
      pages
        .into_iter()
        .map(|page| PagePayload {
          name: page.name,
          data: page.data,
          mime_type: page.mime_type,
        })
        .collect(),
    )
  }

  #[tauri::command]
  /// 指定範囲のページを事前読み込みしてページキャッシュを温めます。
  pub async fn prefetch_page_range(path: String, start_index: usize, count: usize, max_width: u32, max_height: u32) -> Result<(), AppError> {
    if path.is_empty() {
      return Err(AppError::InvalidArchivePath);
    }

    if count == 0 {
      return Ok(());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
      let archive_path = std::path::Path::new(&path);
      let warmed = prefetch_archive_page_range_at_resolution(archive_path, start_index, count, max_width, max_height)?;
      println!(
        "[{}ms] [archive] prefetch_page_range path=\"{}\" start_index={} count={} warmed={}",
        app_elapsed_ms(),
        path,
        start_index,
        count,
        warmed
      );
      Ok(())
    })
    .await
    .map_err(|err| AppError::Internal(format!("Page prefetch task failed: {err}")))?
  }

  #[tauri::command]
  /// サムネイル取得を非同期で実行し、結果をイベントで返します。
  pub fn request_page_thumbnail_range(path: String, start_index: usize, count: usize, max_dimension: u32, app: tauri::AppHandle) -> Result<(), AppError> {
    if path.is_empty() {
      return Err(AppError::InvalidArchivePath);
    }

    let started_at = std::time::Instant::now();
    println!(
      "[{}] [archive] request_page_thumbnail_range start path=\"{}\" start_index={} count={} max_dimension={}",
      Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
      path,
      start_index,
      count,
      max_dimension
    );

    let app_thread = app.clone();
    let path_thread = path.clone();
    // 呼び出し元を待たせないために別スレッドで取得処理を行います。
    std::thread::spawn(move || {
      let archive_path = std::path::Path::new(&path_thread);
      let result = read_archive_page_thumbnails_range(archive_path, start_index, count, max_dimension);
      match result {
        Ok(thumbnails) => {
          let elapsed = started_at.elapsed();
          println!(
            "[{}] [archive] request_page_thumbnail_range completed path=\"{}\" start_index={} count={} elapsed={}ms actual_pages={}",
            Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
            path_thread,
            start_index,
            count,
            elapsed.as_millis(),
            thumbnails.len()
          );

          // 取得した配列に連番インデックスを付与してイベント送信します。
          let batch: Vec<ArchivePageThumbnail> = thumbnails
            .into_iter()
            .enumerate()
            .map(|(i, page)| ArchivePageThumbnail {
              index: start_index + i,
              name: page.name,
              data: page.data,
              mime_type: page.mime_type,
            })
            .collect();
          let _ = app_thread.emit("archive-page-thumbnail-batch", ArchivePageThumbnailBatch { thumbnails: batch });
        }
        Err(err) => {
          let elapsed = started_at.elapsed();
          eprintln!(
            "[{}] [archive] request_page_thumbnail_range error path=\"{}\" start_index={} count={} elapsed={}ms err={}",
            Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
            path_thread,
            start_index,
            count,
            elapsed.as_millis(),
            err
          );
        }
      }
    });

    Ok(())
  }

  #[tauri::command]
  /// ZIP 内画像を一時ディレクトリへ抽出し、抽出結果を順次イベント通知します。
  pub fn start_zip_thumbnail_extraction(path: String, app: tauri::AppHandle) -> Result<(), AppError> {
    if path.is_empty() {
      return Err(AppError::InvalidArchivePath);
    }

    let app_thread = app.clone();
    let path_thread = path.clone();
    // ブロッキング I/O を含むため、専用スレッドプールで実行します。
    let _ = tauri::async_runtime::spawn_blocking(move || {
      let started = std::time::Instant::now();
      match extract_archive_thumbnails_to_memory(&path_thread, &app_thread) {
        Ok(_) => {
          let elapsed = started.elapsed();
          println!("[{}ms] [archive] start_zip_thumbnail_extraction completed in {}", app_elapsed_ms(), format_duration(elapsed));
        }
        Err(err) => {
          let elapsed = started.elapsed();
          eprintln!("[{}ms] [archive] start_zip_thumbnail_extraction error after {}: {}", app_elapsed_ms(), format_duration(elapsed), err);
        }
      }
    });

    Ok(())
  }
}

/// アーカイブ内の画像をストリーミング読み込みでメモリに展開し、
/// キャッシュへ保持した上で、都度フロントへ通知します。
fn extract_archive_thumbnails_to_memory(path: &str, app: &tauri::AppHandle) -> Result<(), AppError> {
  let archive_path = Path::new(path);
  if !archive_path.exists() {
    return Err(AppError::InvalidArchivePath);
  }

  let thumbnails = read_archive_thumbnails_to_memory(archive_path)?;
  for thumbnail in thumbnails {
    let _ = app.emit("zip-thumbnail-extracted", thumbnail);
  }

  Ok(())
}

/// アーカイブ内の画像をメモリ上に直接展開し、キャッシュへ保存します。
fn read_archive_thumbnails_to_memory(archive_path: &Path) -> Result<Vec<ExtractedZipThumbnail>, AppError> {
  let (total, names) = archive::get_archive_info(archive_path)?;

  let mut thumbnails = Vec::new();
  for index in 0..total {
    let entry_name = &names[index];
    if entry_name.ends_with('/') || !is_supported_image(entry_name) {
      continue;
    }

    let safe_name = sanitize_entry_name(entry_name);
    let cache_key = format!("memory://zip/{:04}_{}", index, safe_name);

    let thumbnail = archive::read_archive_page_thumbnail(archive_path, index, 88)?;
    let mime = thumbnail.mime_type.clone();

    thumbnails.push(ExtractedZipThumbnail {
      name: entry_name.clone(),
      path: cache_key,
      mime_type: mime,
    });

    // Archive cache is the shared source of truth for page and thumbnail data,
    // so we intentionally warm the unified archive cache here and then reuse it.
    let _ = archive::read_archive_page(archive_path, index).ok();
  }

  Ok(thumbnails)
}

/// 画像として扱う拡張子かどうかを判定します。
fn is_supported_image(name: &str) -> bool {
  let lowercase = name.to_lowercase();
  lowercase.ends_with(".png")
    || lowercase.ends_with(".jpg")
    || lowercase.ends_with(".jpeg")
    || lowercase.ends_with(".webp")
    || lowercase.ends_with(".gif")
    || lowercase.ends_with(".bmp")
    || lowercase.ends_with(".avif")
}

/// ZIP エントリ名を、保存時に安全な文字列へ変換します。
///
/// 英数字や一部記号以外は `_` に置換し、空白は `_` へ統一します。
fn sanitize_entry_name(name: &str) -> String {
  let mut sanitized = String::new();
  for ch in name.chars() {
    if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ' ') {
      sanitized.push(ch);
    } else {
      sanitized.push('_');
    }
  }
  sanitized.trim().replace(' ', "_")
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  #[test]
  fn reads_zip_thumbnails_directly_into_memory_cache() {
    let _guard = crate::archive::archive_test_guard();
    let temp_dir = std::env::temp_dir().join(format!("brave-comic-reader-memory-test-{}", std::process::id()));
    let archive_path = temp_dir.join("sample.cbz");
    let _ = std::fs::create_dir_all(&temp_dir);

    let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive_path).unwrap());
    let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let png = create_test_png();
    let jpeg = create_test_jpeg();

    writer.start_file("page-1.png", options).unwrap();
    writer.write_all(&png).unwrap();
    writer.start_file("page-2.jpg", options).unwrap();
    writer.write_all(&jpeg).unwrap();
    writer.finish().unwrap();

    let thumbnails = read_archive_thumbnails_to_memory(&archive_path).unwrap();
    assert_eq!(thumbnails.len(), 2);
    assert!(thumbnails[0].path.starts_with("memory://zip/"));
    assert_eq!(thumbnails[0].mime_type, "image/webp");
    assert_eq!(thumbnails[1].mime_type, "image/webp");

    let _ = std::fs::remove_file(&archive_path);
    let _ = std::fs::remove_dir(&temp_dir);
  }

  fn create_test_png() -> Vec<u8> {
    let image = image::RgbImage::from_pixel(2, 2, image::Rgb([255, 0, 0]));
    let mut bytes = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
    bytes
  }

  fn create_test_jpeg() -> Vec<u8> {
    let image = image::RgbImage::from_pixel(2, 2, image::Rgb([255, 0, 0]));
    let mut bytes = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Jpeg).unwrap();
    bytes
  }
}

/// Tauri アプリを構築して起動します。
///
/// ダイアログプラグイン登録、コマンド公開、実行コンテキストの生成を行います。
pub fn run() {
  // 起動時刻を保持し、以降のログで経過時間を表示できるようにします。
  APP_START.set(Instant::now()).ok();

  // アプリ本体を組み立てて実行します。
  tauri::Builder::default()
    .setup(|app| {
      let resource_library = app.path().resource_dir()?.join("binaries/pdfium/libpdfium.so");
      let source_library = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/pdfium/libpdfium.so");
      let library_path = if resource_library.is_file() {
        resource_library
      } else if source_library.is_file() {
        source_library
      } else {
        pdf::extract_embedded_library(&app.path().app_cache_dir()?)?
      };
      pdf::set_library_path(library_path)?;
      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      commands::ping,
      commands::get_startup_archive_path,
      commands::load_settings,
      commands::save_settings,
      commands::get_archive_info,
      commands::identify_archive,
      commands::create_bookmark,
      commands::list_bookmarks,
      commands::get_last_read_page,
      commands::save_last_read_page,
      commands::delete_bookmark,
      commands::get_page,
      commands::preload_archive,
      commands::preload_archive_pages,
      commands::get_page_thumbnail_range,
      commands::prefetch_page_range,
      commands::request_page_thumbnail_range,
      commands::start_zip_thumbnail_extraction,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
