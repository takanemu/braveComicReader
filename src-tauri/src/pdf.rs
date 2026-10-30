use crate::archive::ArchiveError;
use image::DynamicImage;
use pdfium_render::prelude::{PdfRenderConfig, Pdfium};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_PAGE_DIMENSION: u32 = 8192;
const MAX_PAGE_PIXELS: u64 = 33_177_600;

static PDFIUM_LIBRARY_PATH: OnceLock<PathBuf> = OnceLock::new();
static PDFIUM_INSTANCE: OnceLock<Result<Pdfium, String>> = OnceLock::new();

pub fn set_library_path(path: PathBuf) -> Result<(), ArchiveError> {
  if !path.is_file() {
    return Err(ArchiveError::Pdfium(format!("Bundled PDFium library not found at {}", path.display())));
  }

  PDFIUM_LIBRARY_PATH.set(path).map_err(|_| ArchiveError::Pdfium("PDFium library path was already initialized".into()))
}

fn load_pdfium() -> Result<&'static Pdfium, ArchiveError> {
  let instance = PDFIUM_INSTANCE.get_or_init(|| {
    let library_path = PDFIUM_LIBRARY_PATH.get().ok_or_else(|| "PDFium library path is not initialized".to_string())?;
    let bindings = Pdfium::bind_to_library(library_path).map_err(|error| error.to_string())?;
    Ok(Pdfium::new(bindings))
  });
  instance.as_ref().map_err(|error| ArchiveError::Pdfium(error.clone()))
}

pub fn get_page_names(path: &Path) -> Result<Vec<String>, ArchiveError> {
  let pdfium = load_pdfium()?;
  let document = pdfium.load_pdf_from_file(path, None).map_err(|error| ArchiveError::Pdfium(error.to_string()))?;
  let page_count = usize::try_from(document.pages().len()).map_err(|error| ArchiveError::Pdfium(error.to_string()))?;
  Ok((1..=page_count).map(|page| format!("Page {page}")).collect())
}

pub fn render_page(path: &Path, page_index: usize, max_width: u32, max_height: u32) -> Result<DynamicImage, ArchiveError> {
  let page_index = i32::try_from(page_index).map_err(|_| ArchiveError::PageIndexOutOfRange)?;
  let (max_width, max_height) = normalize_render_size(max_width, max_height);
  let pdfium = load_pdfium()?;
  let document = pdfium.load_pdf_from_file(path, None).map_err(|error| ArchiveError::Pdfium(error.to_string()))?;
  let page = document.pages().get(page_index).map_err(|_| ArchiveError::PageIndexOutOfRange)?;
  let bitmap = page
    .render_with_config(
      &PdfRenderConfig::new()
        .set_target_width(max_width as i32)
        .set_maximum_width(max_width as i32)
        .set_maximum_height(max_height as i32),
    )
    .map_err(|error| ArchiveError::Pdfium(error.to_string()))?;
  bitmap.as_image().map_err(|error| ArchiveError::Pdfium(error.to_string()))
}

pub(crate) fn normalize_render_size(width: u32, height: u32) -> (u32, u32) {
  let width = width.clamp(1, MAX_PAGE_DIMENSION);
  let height = height.clamp(1, MAX_PAGE_DIMENSION);
  let pixels = u64::from(width) * u64::from(height);

  if pixels <= MAX_PAGE_PIXELS {
    return (width, height);
  }

  let scale = (MAX_PAGE_PIXELS as f64 / pixels as f64).sqrt();
  ((f64::from(width) * scale).floor().max(1.0) as u32, (f64::from(height) * scale).floor().max(1.0) as u32)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  #[test]
  fn reads_and_renders_a_pdf_page() {
    let _guard = crate::archive::archive_test_guard();
    let library_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/pdfium/libpdfium.so");
    set_library_path(library_path).unwrap();

    let temp_dir = std::env::temp_dir().join(format!("brave-comic-reader-pdf-test-{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let pdf_path = temp_dir.join("sample.pdf");
    std::fs::write(&pdf_path, create_test_pdf()).unwrap();

    let (page_count, page_names) = crate::archive::get_archive_info(&pdf_path).unwrap();
    assert_eq!(page_count, 1);
    assert_eq!(page_names, vec!["Page 1"]);

    let rendered_page = crate::archive::read_archive_page_at_resolution(&pdf_path, 0, 720, 720).unwrap();
    assert_eq!(rendered_page.mime_type, "image/webp");
    assert!(rendered_page.data.starts_with(b"RIFF"));
    assert_eq!(image::load_from_memory(&rendered_page.data).unwrap().width(), 720);
    let cached_page = crate::archive::read_archive_page_at_resolution(&pdf_path, 0, 360, 360).unwrap();
    assert_eq!(image::load_from_memory(&cached_page.data).unwrap().width(), 720);
    let upgraded_page = crate::archive::read_archive_page_at_resolution(&pdf_path, 0, 1024, 1024).unwrap();
    assert_eq!(image::load_from_memory(&upgraded_page.data).unwrap().width(), 1024);
    assert!(matches!(crate::archive::read_archive_page(&pdf_path, 1), Err(ArchiveError::PageIndexOutOfRange)));

    std::fs::remove_file(pdf_path).unwrap();
    std::fs::remove_dir(temp_dir).unwrap();
  }

  #[test]
  fn render_size_is_bounded_by_dimension_and_pixel_limits() {
    let (width, height) = normalize_render_size(u32::MAX, u32::MAX);

    assert!(width <= MAX_PAGE_DIMENSION);
    assert!(height <= MAX_PAGE_DIMENSION);
    assert!(u64::from(width) * u64::from(height) <= MAX_PAGE_PIXELS);
  }

  fn create_test_pdf() -> Vec<u8> {
    let objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>",
      "<< /Length 0 >>\nstream\n\nendstream",
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());

    for (index, object) in objects.iter().enumerate() {
      offsets.push(pdf.len());
      writeln!(&mut pdf, "{} 0 obj\n{}\nendobj", index + 1, object).unwrap();
    }

    let xref_offset = pdf.len();
    writeln!(&mut pdf, "xref\n0 {}\n0000000000 65535 f ", objects.len() + 1).unwrap();
    for offset in offsets {
      writeln!(&mut pdf, "{offset:010} 00000 n ").unwrap();
    }
    write!(&mut pdf, "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n", objects.len() + 1).unwrap();
    pdf
  }
}
