use crate::format_duration;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use chrono::Local;
use image::{DynamicImage, ImageFormat};
use lazy_archive::open_archive as open_archive_vfs;
use rayon::prelude::*;
use thiserror::Error;
use vfs_archive::ArchiveVfs;

/// WebP再エンコード時の画質（0.0-100.0）。lossless比で大幅に高速化しつつ視認上の劣化を抑える値。
const WEBP_QUALITY: f32 = 90.0;

/// libwebpの圧縮方法（0=最速/低圧縮 〜 6=最遅/高圧縮）。デフォルトの4より速度を優先。
const WEBP_METHOD: i32 = 2;

/// キャッシュ画像の最大解像度（4Kモニター基準）。これを超える原寸画像のみ縮小します。
const MAX_CACHE_WIDTH: u32 = 3840;
const MAX_CACHE_HEIGHT: u32 = 2160;

#[derive(Debug, Error)]
pub enum ArchiveError {
  #[error("Archive file not found")]
  NotFound,
  #[error("Unsupported archive format")]
  UnsupportedFormat,
  #[error("Page index out of range")]
  PageIndexOutOfRange,
  #[error("I/O error: {0}")]
  Io(#[from] std::io::Error),
  #[error("Archive error: {0}")]
  Archive(String),
  #[error("Image decode error: {0}")]
  Image(String),
  #[error("PDF error: {0}")]
  Pdfium(String),
}

#[derive(Clone)]
pub struct ArchivePage {
  pub name: String,
  pub data: Vec<u8>,
  pub mime_type: String,
}

#[derive(Clone)]
struct CachedPage {
  encoded_page: Arc<ArchivePage>,
}

#[derive(Clone)]
struct CachedArchiveEntry {
  name: String,
  path: PathBuf,
}

fn read_archive_entry(archive: &dyn ArchiveVfs, entry: &CachedArchiveEntry) -> Result<Vec<u8>, ArchiveError> {
  let mut reader = archive.open(&entry.path)?;
  let mut data = Vec::new();
  reader.read_to_end(&mut data)?;
  Ok(data)
}

struct CachedArchive {
  path: PathBuf,
  entries: Vec<CachedArchiveEntry>,
  pages: Vec<Option<CachedPage>>,
  page_locks: Vec<Arc<Mutex<()>>>,
  archive: Arc<dyn ArchiveVfs>,
}

impl CachedArchive {
  /// キャッシュ対象の全ページを読み込み、必要なら進捗や生成結果を通知します。
  ///
  /// すでに全ページが `pages` に載っている場合は何もしません。
  fn ensure_pages_loaded(
    &mut self,
    progress: Option<&dyn Fn(usize, usize)>,
    page_thumbnail_loaded: Option<&dyn Fn(usize, &str, &[u8], &str)>,
    page_loaded: Option<&dyn Fn(usize, &ArchivePage)>,
    _thumbnail_dimension: u32,
  ) -> Result<(), ArchiveError> {
    // すべてのページがロード済みかどうかではなく、未ロードのページだけを処理します。
    if self.pages.iter().all(Option::is_some) {
      println!(
        "[{}] [archive] cache_complete pages={} total={} reason=already_loaded",
        Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
        self.pages.iter().filter(|page| page.is_some()).count(),
        self.entries.len()
      );
      return Ok(());
    }

    let total = self.entries.len();

    // 進捗通知がある場合は開始時点を通知します。
    if let Some(report) = progress {
      report(0, total);
    }

    // エントリを1件ずつ読み込み、画像デコードとサムネイル作成を行います。
    for (index, entry) in self.entries.iter().enumerate() {
      if self.pages.get(index).and_then(|page| page.as_ref()).is_some() {
        if let Some(report) = progress {
          report(index + 1, total);
        }
        continue;
      }

      println!("[{}] [archive] cache_page_start index={} name={}", Local::now().format("%Y/%m/%d %H:%M:%S%.3f"), index, entry.name);

      let buf = read_archive_entry(self.archive.as_ref(), entry)?;

      let decode_started = std::time::Instant::now();
      let image = decode_image(&buf, &entry.name)?;
      let decode_elapsed = decode_started.elapsed();

      let encode_started = std::time::Instant::now();
      let page_payload = encode_image_bytes(&image, &entry.name)?;
      let encode_elapsed = encode_started.elapsed();

      println!(
        "[{}] [archive] perf cache_page index={} name={} bytes={} decode={} encode={} total={}",
        Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
        index,
        entry.name,
        buf.len(),
        format_duration(decode_elapsed),
        format_duration(encode_elapsed),
        format_duration(decode_elapsed + encode_elapsed)
      );

      // ページ本体は WebP(lossy) でキャッシュし、サムネイル要求も同一データを共有します。
      let page_payload = cache_page(&self.path, index, Arc::new(page_payload));
      self.pages[index] = Some(CachedPage {
        encoded_page: Arc::clone(&page_payload),
      });

      // サムネイル生成完了イベントを通知します。
      if let Some(page_thumbnail_loaded) = page_thumbnail_loaded {
        page_thumbnail_loaded(index, &page_payload.name, &page_payload.data, &page_payload.mime_type);
      }

      // ページ本体の読み込み完了イベントを通知します。
      if let Some(page_loaded) = page_loaded {
        page_loaded(index, &page_payload);
      }

      // 1件処理ごとに進捗を更新します。
      if let Some(report) = progress {
        report(index + 1, total);
      }

      println!(
        "[{}] [archive] cache_page_complete index={} name={} mime_type={}",
        Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
        index,
        page_payload.name,
        page_payload.mime_type
      );
    }

    println!(
      "[{}] [archive] cache_complete pages={} total={} reason=all_pages_loaded",
      Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
      self.pages.iter().filter(|page| page.is_some()).count(),
      total
    );
    Ok(())
  }
}

static ARCHIVE_CACHE: Mutex<Option<CachedArchive>> = Mutex::new(None);
static PAGE_CACHE: RwLock<Option<(PathBuf, Vec<Option<Arc<ArchivePage>>>)>> = RwLock::new(None);
static PDF_PAGE_CACHE: RwLock<Option<(PathBuf, Vec<Option<(u32, u32, Arc<ArchivePage>)>>)>> = RwLock::new(None);
static PREFETCH_POOL: LazyLock<Result<rayon::ThreadPool, String>> = LazyLock::new(|| {
  rayon::ThreadPoolBuilder::new()
    .num_threads(1)
    .thread_name(|index| format!("comic-prefetch-{index}"))
    .build()
    .map_err(|error| error.to_string())
});

#[cfg(test)]
static ARCHIVE_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn archive_test_guard() -> std::sync::MutexGuard<'static, ()> {
  ARCHIVE_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
fn reset_archive_cache() {
  let mut cache = ARCHIVE_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  *cache = None;
  *PAGE_CACHE.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
  *PDF_PAGE_CACHE.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

fn get_cached_page(path: &Path, page_index: usize) -> Option<Arc<ArchivePage>> {
  let cache = PAGE_CACHE.read().unwrap_or_else(|poisoned| poisoned.into_inner());
  let (cached_path, pages) = cache.as_ref()?;
  if cached_path != path {
    return None;
  }
  pages.get(page_index)?.clone()
}

fn cache_page(path: &Path, page_index: usize, page: Arc<ArchivePage>) -> Arc<ArchivePage> {
  let mut cache = PAGE_CACHE.write().unwrap_or_else(|poisoned| poisoned.into_inner());
  let Some((cached_path, pages)) = cache.as_mut() else {
    return page;
  };
  if cached_path != path || page_index >= pages.len() {
    return page;
  }
  if let Some(cached_page) = &pages[page_index] {
    return Arc::clone(cached_page);
  }
  pages[page_index] = Some(Arc::clone(&page));
  page
}

fn get_cached_pdf_page(path: &Path, page_index: usize, max_width: u32, max_height: u32) -> Option<Arc<ArchivePage>> {
  let cache = PDF_PAGE_CACHE.read().unwrap_or_else(|poisoned| poisoned.into_inner());
  let (cached_path, pages) = cache.as_ref()?;
  if cached_path != path {
    return None;
  }

  let (cached_width, cached_height, page) = pages.get(page_index)?.as_ref()?;
  (*cached_width >= max_width && *cached_height >= max_height).then(|| Arc::clone(page))
}

fn cache_pdf_page(path: &Path, page_index: usize, max_width: u32, max_height: u32, page: Arc<ArchivePage>) -> Arc<ArchivePage> {
  let mut cache = PDF_PAGE_CACHE.write().unwrap_or_else(|poisoned| poisoned.into_inner());
  let Some((cached_path, pages)) = cache.as_mut() else {
    return page;
  };
  if cached_path != path || page_index >= pages.len() {
    return page;
  }

  if let Some((cached_width, cached_height, cached_page)) = &pages[page_index] {
    if *cached_width >= max_width && *cached_height >= max_height {
      return Arc::clone(cached_page);
    }
  }

  pages[page_index] = Some((max_width, max_height, Arc::clone(&page)));
  page
}

/// 指定パスのアーカイブがキャッシュ済みか確認し、必要なら読み直します。
fn ensure_cached_archive(path: &Path, progress: Option<&dyn Fn(usize, usize)>) -> Result<(), ArchiveError> {
  // 共有キャッシュに排他アクセスします。
  let mut cache = ARCHIVE_CACHE.lock().unwrap();
  let should_reload = match &*cache {
    Some(cached) => cached.path != path,
    None => true,
  };

  // パスが変わった場合のみアーカイブを開き直して一覧を再生成します。
  if should_reload {
    let archive: Arc<dyn ArchiveVfs> = Arc::from(open_archive(path)?);
    let entries = collect_page_entries(archive.as_ref(), progress)?;
    let page_count = entries.len();
    let pages = vec![None; entries.len()];
    let page_locks = (0..page_count).map(|_| Arc::new(Mutex::new(()))).collect();
    let cached_path = path.to_path_buf();
    *cache = Some(CachedArchive {
      path: cached_path.clone(),
      entries,
      pages,
      page_locks,
      archive,
    });
    *PAGE_CACHE.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((cached_path, vec![None; page_count]));
  }

  Ok(())
}

fn open_archive(path: &Path) -> Result<Box<dyn ArchiveVfs>, ArchiveError> {
  if !path.exists() {
    return Err(ArchiveError::NotFound);
  }

  open_archive_vfs(path.to_path_buf()).map_err(|error| ArchiveError::Archive(error.to_string()))
}

fn with_cached_archive<F, R>(path: &Path, progress: Option<&dyn Fn(usize, usize)>, f: F) -> Result<R, ArchiveError>
where
  F: FnOnce(&mut CachedArchive) -> Result<R, ArchiveError>,
{
  // まず対象パスのキャッシュを有効化し、続いて呼び出し側の処理を実行します。
  ensure_cached_archive(path, progress)?;
  let mut cache = ARCHIVE_CACHE.lock().unwrap();
  let cached = cache.as_mut().unwrap();
  f(cached)
}

/// アーカイブ情報（ページ数とページ名一覧）を取得します。
pub fn get_archive_info(path: &Path) -> Result<(usize, Vec<String>), ArchiveError> {
  get_archive_info_with_progress(path, None)
}

/// アーカイブ情報を取得し、必要に応じて進捗コールバックを呼び出します。
pub fn get_archive_info_with_progress(path: &Path, progress: Option<&dyn Fn(usize, usize)>) -> Result<(usize, Vec<String>), ArchiveError> {
  if is_pdf_path(path) {
    let names = crate::pdf::get_page_names(path)?;
    let page_count = names.len();
    let mut cache = PAGE_CACHE.write().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !cache.as_ref().is_some_and(|(cached_path, pages)| cached_path == path && pages.len() == page_count) {
      *cache = Some((path.to_path_buf(), vec![None; page_count]));
    }
    let mut pdf_cache = PDF_PAGE_CACHE.write().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !pdf_cache.as_ref().is_some_and(|(cached_path, pages)| cached_path == path && pages.len() == page_count) {
      *pdf_cache = Some((path.to_path_buf(), vec![None; page_count]));
    }
    if let Some(report) = progress {
      report(page_count, page_count);
    }
    return Ok((page_count, names));
  }

  with_cached_archive(path, progress, |cached| {
    let names = cached.entries.iter().map(|entry| entry.name.clone()).collect();
    Ok((cached.entries.len(), names))
  })
}

/// アーカイブ全ページの画像キャッシュを作成し、名前一覧を返します。
pub fn preload_archive_cache(
  path: &Path,
  progress: Option<&dyn Fn(usize, usize)>,
  page_thumbnail_loaded: Option<&dyn Fn(usize, &str, &[u8], &str)>,
  page_loaded: Option<&dyn Fn(usize, &ArchivePage)>,
  thumbnail_dimension: u32,
) -> Result<(usize, Vec<String>), ArchiveError> {
  if is_pdf_path(path) {
    let (_, names) = get_archive_info(path)?;
    let total = names.len();
    if let Some(report) = progress {
      report(0, total);
    }
    for (index, name) in names.iter().enumerate() {
      let page = read_archive_page(path, index)?;
      if let Some(page_thumbnail_loaded) = page_thumbnail_loaded {
        page_thumbnail_loaded(index, name, &page.data, &page.mime_type);
      }
      if let Some(page_loaded) = page_loaded {
        page_loaded(index, &page);
      }
      if let Some(report) = progress {
        report(index + 1, total);
      }
    }
    let _ = thumbnail_dimension;
    return Ok((total, names));
  }

  with_cached_archive(path, None, |cached| {
    cached.ensure_pages_loaded(progress, page_thumbnail_loaded, page_loaded, thumbnail_dimension)?;
    let names = cached.entries.iter().map(|entry| entry.name.clone()).collect();
    Ok((cached.entries.len(), names))
  })
}

/// 指定インデックスのページ画像を1枚取得します。
pub fn read_archive_page(path: &Path, page_index: usize) -> Result<ArchivePage, ArchiveError> {
  read_archive_page_at_resolution(path, page_index, 3840, 2160)
}

pub fn read_archive_page_at_resolution(path: &Path, page_index: usize, max_width: u32, max_height: u32) -> Result<ArchivePage, ArchiveError> {
  if is_pdf_path(path) {
    let (max_width, max_height) = crate::pdf::normalize_render_size(max_width, max_height);
    if !path.exists() {
      return Err(ArchiveError::NotFound);
    }

    let page_count = {
      let cache = PAGE_CACHE.read().unwrap_or_else(|poisoned| poisoned.into_inner());
      cache.as_ref().filter(|(cached_path, _)| cached_path == path).map(|(_, pages)| pages.len())
    };
    let page_count = match page_count {
      Some(page_count) => page_count,
      None => get_archive_info(path)?.0,
    };
    if page_index >= page_count {
      return Err(ArchiveError::PageIndexOutOfRange);
    }

    if let Some(page) = get_cached_pdf_page(path, page_index, max_width, max_height) {
      return Ok(page.as_ref().clone());
    }

    let name = format!("Page {}", page_index + 1);
    let image = crate::pdf::render_page(path, page_index, max_width, max_height)?;
    let page = Arc::new(encode_image_bytes_lossless(&image, &name)?);
    return Ok(cache_pdf_page(path, page_index, max_width, max_height, page).as_ref().clone());
  }

  let started = std::time::Instant::now();

  let result = (|| {
    if let Some(page) = get_cached_page(path, page_index) {
      println!(
        "[{}] [archive] read_archive_page cache_hit page_index={} name={}",
        Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
        page_index,
        page.name
      );
      return Ok(page.as_ref().clone());
    }

    ensure_cached_archive(path, None)?;
    let (archive, entry, page_lock) = {
      let cache = ARCHIVE_CACHE.lock().unwrap();
      let cached = cache.as_ref().ok_or(ArchiveError::NotFound)?;
      if cached.path != path {
        return Err(ArchiveError::NotFound);
      }
      let entry = cached.entries.get(page_index).cloned().ok_or(ArchiveError::PageIndexOutOfRange)?;
      let page_lock = cached.page_locks.get(page_index).cloned().ok_or(ArchiveError::PageIndexOutOfRange)?;
      (Arc::clone(&cached.archive), entry, page_lock)
    };
    let _page_guard = page_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(page) = get_cached_page(path, page_index) {
      println!(
        "[{}] [archive] read_archive_page cache_hit page_index={} name={}",
        Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
        page_index,
        page.name
      );
      return Ok(page.as_ref().clone());
    }

    println!(
      "[{}] [archive] read_archive_page cache_miss page_index={} name={}",
      Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
      page_index,
      entry.name
    );
    let read_started = std::time::Instant::now();
    let buf = read_archive_entry(archive.as_ref(), &entry)?;
    let read_elapsed = read_started.elapsed();

    let decode_started = std::time::Instant::now();
    let decoded = decode_image(&buf, &entry.name)?;
    let decode_elapsed = decode_started.elapsed();

    let encode_started = std::time::Instant::now();
    let encoded_page = Arc::new(encode_image_bytes(&decoded, &entry.name)?);
    let encode_elapsed = encode_started.elapsed();
    println!(
      "[{}] [archive] perf ensure_page_cached page_index={} name={} bytes={} read={} decode={} encode={} total={}",
      Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
      page_index,
      entry.name,
      buf.len(),
      format_duration(read_elapsed),
      format_duration(decode_elapsed),
      format_duration(encode_elapsed),
      format_duration(read_elapsed + decode_elapsed + encode_elapsed)
    );

    let encoded_page = {
      let mut cache = ARCHIVE_CACHE.lock().unwrap();
      match cache.as_mut().filter(|cached| cached.path == path) {
        Some(cached) => {
          if let Some(page) = cached.pages[page_index].as_ref() {
            Arc::clone(&page.encoded_page)
          } else {
            cached.pages[page_index] = Some(CachedPage {
              encoded_page: Arc::clone(&encoded_page),
            });
            Arc::clone(&encoded_page)
          }
        }
        None => Arc::clone(&encoded_page),
      }
    };
    let encoded_page = cache_page(path, page_index, encoded_page);
    Ok(encoded_page.as_ref().clone())
  })();

  let elapsed = started.elapsed();
  match &result {
    Ok(_) => println!(
      "[{}] [archive] read_archive_page completed page_index={} elapsed={}",
      Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
      page_index,
      format_duration(elapsed)
    ),
    Err(err) => eprintln!(
      "[{}] [archive] read_archive_page failed page_index={} elapsed={} err={}",
      Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
      page_index,
      format_duration(elapsed),
      err
    ),
  }

  result
}

/// 指定範囲のページを事前読み込みし、キャッシュを温めます。
pub fn prefetch_archive_page_range_at_resolution(path: &Path, start_index: usize, count: usize, max_width: u32, max_height: u32) -> Result<usize, ArchiveError> {
  if is_pdf_path(path) {
    let (max_width, max_height) = crate::pdf::normalize_render_size(max_width, max_height);
    let page_count = get_archive_info(path)?.0;
    let end_index = usize::min(start_index.saturating_add(count), page_count);
    let mut warmed = 0;
    for index in start_index..end_index {
      if get_cached_pdf_page(path, index, max_width, max_height).is_none() {
        read_archive_page_at_resolution(path, index, max_width, max_height)?;
        warmed += 1;
      }
    }
    return Ok(warmed);
  }

  let started = std::time::Instant::now();
  println!(
    "[{}] [archive] prefetch_page_range start start_index={} count={}",
    Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
    start_index,
    count
  );

  let (archive, candidates) = with_cached_archive(path, None, |cached| {
    let end_index = usize::min(start_index.saturating_add(count), cached.entries.len());
    let mut candidates = Vec::new();

    for index in start_index..end_index {
      if get_cached_page(path, index).is_some() {
        continue;
      }

      let entry = &cached.entries[index];
      candidates.push((index, entry.clone(), Arc::clone(&cached.page_locks[index])));
    }

    Ok((Arc::clone(&cached.archive), candidates))
  })?;

  let mut pending = Vec::with_capacity(candidates.len());
  for (index, entry, page_lock) in candidates {
    if get_cached_page(path, index).is_some() {
      continue;
    }
    let data = read_archive_entry(archive.as_ref(), &entry)?;
    pending.push((index, entry.name, data, page_lock));
  }
  let read_elapsed = started.elapsed();
  let pending_bytes: usize = pending.iter().map(|(_, _, data, _)| data.len()).sum();
  println!(
    "[{}] [archive] perf prefetch_page_range read pages={} bytes={} elapsed={}",
    Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
    pending.len(),
    pending_bytes,
    format_duration(read_elapsed)
  );

  let process_started = std::time::Instant::now();
  let prefetch_pool = match &*PREFETCH_POOL {
    Ok(pool) => pool,
    Err(error) => return Err(ArchiveError::Archive(format!("prefetch worker pool unavailable: {error}"))),
  };
  let encoded_pages: Vec<Result<(usize, CachedPage), ArchiveError>> = prefetch_pool.install(|| {
    pending
      .par_iter()
      .map(|(index, name, data, page_lock)| {
        let _page_guard = page_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(encoded_page) = get_cached_page(path, *index) {
          return Ok((*index, CachedPage { encoded_page }));
        }
        let decoded = decode_image(data, name)?;
        let encoded_page = cache_page(path, *index, Arc::new(encode_image_bytes(&decoded, name)?));
        Ok((*index, CachedPage { encoded_page }))
      })
      .collect()
  });
  let process_elapsed = process_started.elapsed();
  println!(
    "[{}] [archive] perf prefetch_page_range process pages={} elapsed={}",
    Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
    encoded_pages.len(),
    format_duration(process_elapsed)
  );

  let store_started = std::time::Instant::now();
  with_cached_archive(path, None, |cached| {
    let mut warmed = 0usize;
    for encoded_page in encoded_pages {
      let (index, page) = encoded_page?;
      if cached.pages.get(index).and_then(|item| item.as_ref()).is_none() {
        let encoded_page = cache_page(&cached.path, index, page.encoded_page);
        cached.pages[index] = Some(CachedPage { encoded_page });
        warmed += 1;
      }
    }
    Ok(warmed)
  })
  .map(|warmed| {
    println!(
      "[{}] [archive] prefetch_page_range completed requested={} warmed={} read={} process={} store={} total={}",
      Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
      count,
      warmed,
      format_duration(read_elapsed),
      format_duration(process_elapsed),
      format_duration(store_started.elapsed()),
      format_duration(started.elapsed())
    );
    warmed
  })
}

/// 指定インデックスのサムネイル画像を1枚取得します。
pub fn read_archive_page_thumbnail(path: &Path, page_index: usize, max_dimension: u32) -> Result<ArchivePage, ArchiveError> {
  let _ = max_dimension;
  read_archive_page(path, page_index)
}

/// 指定範囲のサムネイル画像を取得します。
pub fn read_archive_page_thumbnails_range(path: &Path, start_index: usize, count: usize, max_dimension: u32) -> Result<Vec<ArchivePage>, ArchiveError> {
  let _ = max_dimension;
  if is_pdf_path(path) {
    let page_count = get_archive_info(path)?.0;
    let end_index = usize::min(start_index.saturating_add(count), page_count);
    return (start_index..end_index).map(|index| read_archive_page(path, index)).collect();
  }

  ensure_cached_archive(path, None)?;
  let end_index = {
    let cache = ARCHIVE_CACHE.lock().unwrap();
    let cached = cache.as_ref().ok_or(ArchiveError::NotFound)?;
    if cached.path != path {
      return Err(ArchiveError::NotFound);
    }
    usize::min(start_index.saturating_add(count), cached.entries.len())
  };
  let mut thumbnails = Vec::with_capacity(end_index.saturating_sub(start_index));
  for index in start_index..end_index {
    thumbnails.push(read_archive_page(path, index)?);
  }
  Ok(thumbnails)
}

fn is_pdf_path(path: &Path) -> bool {
  path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

/// アーカイブから画像エントリ一覧を収集します。
fn collect_page_entries(archive: &dyn ArchiveVfs, progress: Option<&dyn Fn(usize, usize)>) -> Result<Vec<CachedArchiveEntry>, ArchiveError> {
  let archive_entries = archive.entries()?;
  let mut entries = Vec::new();
  let total = archive_entries.len();
  if let Some(report) = progress {
    report(0, total);
  }
  for (index, entry) in archive_entries.into_iter().enumerate() {
    let name = entry.path().to_string_lossy().into_owned();
    if !entry.is_directory() && is_supported_image(&name) {
      entries.push(CachedArchiveEntry {
        name,
        path: entry.path().to_path_buf(),
      });
    }
    if let Some(report) = progress {
      report(index + 1, total);
    }
  }
  Ok(entries)
}

/// 画像を WebP（lossy, quality=WEBP_QUALITY）バイト列へエンコードし、`ArchivePage` に詰めます。
///
/// 原寸が `MAX_CACHE_WIDTH`x`MAX_CACHE_HEIGHT`（4K）を超える場合は、アスペクト比を保ったまま
/// 高速な整数縮小で縮小してからエンコードし、キャッシュサイズと転送量を抑えます。
fn encode_image_bytes(image: &DynamicImage, name: &str) -> Result<ArchivePage, ArchiveError> {
  encode_image_bytes_with_mode(image, name, false)
}

fn encode_image_bytes_lossless(image: &DynamicImage, name: &str) -> Result<ArchivePage, ArchiveError> {
  encode_image_bytes_with_mode(image, name, true)
}

fn encode_image_bytes_with_mode(image: &DynamicImage, name: &str, lossless: bool) -> Result<ArchivePage, ArchiveError> {
  let resize_started = std::time::Instant::now();
  let resized;
  let target = if image.width() > MAX_CACHE_WIDTH || image.height() > MAX_CACHE_HEIGHT {
    resized = image.thumbnail(MAX_CACHE_WIDTH, MAX_CACHE_HEIGHT);
    &resized
  } else {
    image
  };
  let resize_elapsed = resize_started.elapsed();

  let convert_started = std::time::Instant::now();
  let mut config = webp::WebPConfig::new().map_err(|_| ArchiveError::Archive("webp config init failed".into()))?;
  config.quality = if lossless { 100.0 } else { WEBP_QUALITY };
  config.lossless = i32::from(lossless);
  if lossless {
    config.alpha_compression = 0;
  }
  config.method = WEBP_METHOD;
  config.thread_level = 1; // マルチスレッド圧縮を有効化

  let encoded = if target.has_alpha() {
    let rgba8 = target.to_rgba8();
    webp::Encoder::from_rgba(&rgba8, rgba8.width(), rgba8.height())
      .encode_advanced(&config)
      .map_err(|err| ArchiveError::Archive(format!("{:?}", err)))?
      .to_vec()
  } else {
    let rgb8 = target.to_rgb8();
    webp::Encoder::from_rgb(&rgb8, rgb8.width(), rgb8.height())
      .encode_advanced(&config)
      .map_err(|err| ArchiveError::Archive(format!("{:?}", err)))?
      .to_vec()
  };
  let convert_elapsed = convert_started.elapsed();

  println!(
    "[{}] [archive] perf encode_image name={} source={}x{} target={}x{} resize={} convert_encode={}",
    Local::now().format("%Y/%m/%d %H:%M:%S%.3f"),
    name,
    image.width(),
    image.height(),
    target.width(),
    target.height(),
    format_duration(resize_elapsed),
    format_duration(convert_elapsed)
  );

  Ok(ArchivePage {
    name: name.to_string(),
    data: encoded,
    mime_type: "image/webp".into(),
  })
}

/// 画像バイト列を `DynamicImage` にデコードします。
///
/// JPEGはTurboJPEG（libjpeg-turbo, SIMD）でスケールデコードして高速化し、
/// それ以外の形式は`image`クレートでデコードし、既知の拡張子は形式推定を省略します。
fn decode_image(data: &[u8], name: &str) -> Result<DynamicImage, ArchiveError> {
  if is_jpeg(data) {
    return decode_jpeg_scaled(data);
  }

  if image_format_from_name(name) == Some(ImageFormat::WebP) {
    if let Some(decoded) = webp::Decoder::new(data).decode() {
      return Ok(decoded.to_image());
    }
  }

  if let Some(format) = image_format_from_name(name) {
    return image::ImageReader::with_format(Cursor::new(data), format).decode().map_err(|err| ArchiveError::Image(err.to_string()));
  }

  let cursor = Cursor::new(data);
  let result = match image::ImageReader::new(cursor).with_guessed_format() {
    Ok(reader) => reader.decode(),
    Err(_) => image::ImageReader::new(Cursor::new(data)).with_guessed_format()?.decode(),
  };
  result.map_err(|err| ArchiveError::Image(err.to_string()))
}

/// 先頭バイトからJPEG（SOIマーカー）かどうかを判定します。
fn is_jpeg(data: &[u8]) -> bool {
  data.len() >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF
}

/// TurboJPEGでJPEGをDCTスケールデコードし、`DynamicImage`として返します。
///
/// フル解像度でデコードしてから`resize`するのではなく、`MAX_CACHE_WIDTH`/`MAX_CACHE_HEIGHT`
/// に収まる最小の1/8刻みスケールを選んでデコード時に縮小するため、デコード自体のコストも下がります。
fn decode_jpeg_scaled(data: &[u8]) -> Result<DynamicImage, ArchiveError> {
  let mut decompressor = turbojpeg::Decompressor::new().map_err(|err| ArchiveError::Image(format!("turbojpeg init failed: {err}")))?;
  let header = decompressor.read_header(data).map_err(|err| ArchiveError::Image(format!("turbojpeg header read failed: {err}")))?;

  let required_scale = (MAX_CACHE_WIDTH as f64 / header.width as f64).min(MAX_CACHE_HEIGHT as f64 / header.height as f64).min(1.0);

  // 最大キャッシュ寸法を超えない範囲で、最も大きい係数を選びます。
  let ratio = |factor: &turbojpeg::ScalingFactor| factor.num() as f64 / factor.denom() as f64;
  let scaling_factor = turbojpeg::Decompressor::supported_scaling_factors()
    .into_iter()
    .filter(|factor| ratio(factor) <= required_scale)
    .max_by(|a, b| ratio(a).partial_cmp(&ratio(b)).unwrap())
    .unwrap_or(turbojpeg::ScalingFactor::ONE);

  decompressor
    .set_scaling_factor(scaling_factor)
    .map_err(|err| ArchiveError::Image(format!("turbojpeg scaling factor failed: {err}")))?;
  let scaled = header.scaled(scaling_factor);

  let mut image = turbojpeg::Image {
    pixels: vec![0u8; 4 * scaled.width * scaled.height],
    width: scaled.width,
    pitch: 4 * scaled.width,
    height: scaled.height,
    format: turbojpeg::PixelFormat::RGBA,
  };

  decompressor
    .decompress(data, image.as_deref_mut())
    .map_err(|err| ArchiveError::Image(format!("turbojpeg decode failed: {err}")))?;

  image::RgbaImage::from_raw(scaled.width as u32, scaled.height as u32, image.pixels)
    .map(DynamicImage::ImageRgba8)
    .ok_or_else(|| ArchiveError::Image("failed to build image buffer from decoded pixels".into()))
}

/// ファイル名拡張子から `ImageFormat` を推定します。
fn image_format_from_name(name: &str) -> Option<ImageFormat> {
  let lowercase = name.to_lowercase();
  if lowercase.ends_with(".png") {
    Some(ImageFormat::Png)
  } else if lowercase.ends_with(".jpg") || lowercase.ends_with(".jpeg") {
    Some(ImageFormat::Jpeg)
  } else if lowercase.ends_with(".webp") {
    Some(ImageFormat::WebP)
  } else if lowercase.ends_with(".gif") {
    Some(ImageFormat::Gif)
  } else if lowercase.ends_with(".bmp") {
    Some(ImageFormat::Bmp)
  } else if lowercase.ends_with(".avif") {
    Some(ImageFormat::Avif)
  } else {
    None
  }
}

/// サポート対象の画像拡張子かどうかを判定します。
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

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs::File;
  use std::fs;
  use std::io::Write;

  #[test]
  fn lossless_webp_encoding_preserves_all_pixels() {
    let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(32, 24, |x, y| image::Rgb([(x * 7) as u8, (y * 9) as u8, ((x + y) * 5) as u8])));

    let encoded = encode_image_bytes_lossless(&image, "Page 1").unwrap();
    let decoded = webp::Decoder::new(&encoded.data).decode().unwrap().to_image();

    assert_eq!(decoded.to_rgba8(), image.to_rgba8());
  }

  #[test]
  /// ZIP（CBZ）からページ情報と画像が読み取れることを確認します。
  fn reads_images_from_zip_archive() {
    let _guard = archive_test_guard();
    reset_archive_cache();
    let temp_dir = std::env::temp_dir().join(format!("brave-comic-reader-test-{}", std::process::id()));
    let archive_path = temp_dir.join("sample.cbz");
    fs::create_dir_all(&temp_dir).unwrap();

    // テスト用アーカイブを作成し、2ページ分の画像を格納します。
    let mut writer = zip::ZipWriter::new(File::create(&archive_path).unwrap());
    let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);

    let image_bytes = create_test_png();
    writer.start_file("page-1.png", options).unwrap();
    writer.write_all(&image_bytes).unwrap();
    writer.start_file("page-2.jpg", options).unwrap();
    writer.write_all(&image_bytes).unwrap();
    writer.finish().unwrap();

    let (page_count, page_names) = get_archive_info(&archive_path).unwrap();
    assert_eq!(page_count, 2);
    assert_eq!(page_names, vec!["page-1.png", "page-2.jpg"]);

    let page = read_archive_page(&archive_path, 0).unwrap();
    assert_eq!(page.name, "page-1.png");
    assert!(page.data.starts_with(b"RIFF"));
    assert_eq!(&page.data[8..12], b"WEBP");

    let _ = fs::remove_file(&archive_path);
    let _ = fs::remove_dir(&temp_dir);
  }

  #[test]
  /// TAR からも画像ページを列挙し、非画像エントリを除外できることを確認します。
  fn reads_images_from_tar_archive() {
    let _guard = archive_test_guard();
    reset_archive_cache();
    let temp_dir = std::env::temp_dir().join(format!("brave-comic-reader-tar-test-{}", std::process::id()));
    let archive_path = temp_dir.join("sample.tar");
    fs::create_dir_all(&temp_dir).unwrap();

    let image_bytes = create_test_png();
    let mut writer = tar::Builder::new(File::create(&archive_path).unwrap());
    let mut image_header = tar::Header::new_gnu();
    image_header.set_size(image_bytes.len() as u64);
    image_header.set_mode(0o644);
    image_header.set_cksum();
    writer.append_data(&mut image_header, "pages/page-1.png", image_bytes.as_slice()).unwrap();

    let text = b"not an image";
    let mut text_header = tar::Header::new_gnu();
    text_header.set_size(text.len() as u64);
    text_header.set_mode(0o644);
    text_header.set_cksum();
    writer.append_data(&mut text_header, "README.txt", text.as_slice()).unwrap();
    writer.finish().unwrap();

    let (page_count, page_names) = get_archive_info(&archive_path).unwrap();
    assert_eq!(page_count, 1);
    assert_eq!(page_names, vec!["pages/page-1.png"]);

    let page = read_archive_page(&archive_path, 0).unwrap();
    assert_eq!(page.name, "pages/page-1.png");
    assert!(page.data.starts_with(b"RIFF"));
    assert_eq!(&page.data[8..12], b"WEBP");

    let _ = fs::remove_file(&archive_path);
    let _ = fs::remove_dir(&temp_dir);
  }

  #[test]
  /// 単一ページだけ読み込んだ場合でも、そのページがページ単位キャッシュに入ることを確認します。
  fn page_read_populates_page_level_cache() {
    let _guard = archive_test_guard();
    reset_archive_cache();
    let temp_dir = std::env::temp_dir().join(format!("brave-comic-reader-page-cache-test-{}", std::process::id()));
    let archive_path = temp_dir.join("sample.cbz");
    fs::create_dir_all(&temp_dir).unwrap();

    let mut writer = zip::ZipWriter::new(File::create(&archive_path).unwrap());
    let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);

    let image_bytes = create_test_png();
    writer.start_file("page-1.png", options).unwrap();
    writer.write_all(&image_bytes).unwrap();
    writer.start_file("page-2.jpg", options).unwrap();
    writer.write_all(&image_bytes).unwrap();
    writer.finish().unwrap();

    let _ = read_archive_page(&archive_path, 0).unwrap();

    let cache = ARCHIVE_CACHE.lock().unwrap();
    let cached = cache.as_ref().unwrap();
    assert!(cached.pages[0].is_some());
    assert!(cached.pages[1].is_none());

    let archive_path_for_worker = archive_path.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
      sender.send(read_archive_page(&archive_path_for_worker, 0)).unwrap();
    });
    let cached_read = receiver.recv_timeout(std::time::Duration::from_secs(1));
    drop(cache);
    worker.join().unwrap();
    assert_eq!(cached_read.unwrap().unwrap().name, "page-1.png");

    let _ = fs::remove_file(&archive_path);
    let _ = fs::remove_dir(&temp_dir);
  }

  /// テスト用の小さな PNG バイト列を生成します。
  fn create_test_png() -> Vec<u8> {
    let image = image::RgbImage::from_pixel(2, 2, image::Rgb([255, 0, 0]));
    let mut bytes = Vec::new();
    image.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png).unwrap();
    bytes
  }
}
