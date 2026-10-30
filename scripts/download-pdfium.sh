#!/usr/bin/env sh
set -eu

PDFIUM_VERSION="7881"
PDFIUM_ARCHIVE="pdfium-linux-x64.tgz"
PDFIUM_URL="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/${PDFIUM_VERSION}/${PDFIUM_ARCHIVE}"
PDFIUM_SHA256="1470e21b8b4a3b4ad7f85684e2da11d94f3b69a86d81dee11b9b6709d927ac1d"
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT_DIR="${PROJECT_ROOT}/src-tauri/binaries/pdfium"
TEMP_DIR=$(mktemp -d)

cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT INT TERM

curl --fail --location --silent --show-error "${PDFIUM_URL}" -o "${TEMP_DIR}/${PDFIUM_ARCHIVE}"
printf '%s  %s\n' "${PDFIUM_SHA256}" "${TEMP_DIR}/${PDFIUM_ARCHIVE}" | sha256sum --check
tar -xzf "${TEMP_DIR}/${PDFIUM_ARCHIVE}" -C "${TEMP_DIR}"

mkdir -p "${OUTPUT_DIR}"
install -m 0755 "${TEMP_DIR}/lib/libpdfium.so" "${OUTPUT_DIR}/libpdfium.so"
install -m 0644 "${TEMP_DIR}/LICENSE" "${OUTPUT_DIR}/LICENSE"
install -m 0644 "${TEMP_DIR}/VERSION" "${OUTPUT_DIR}/PDFIUM_VERSION"
rm -rf "${OUTPUT_DIR}/licenses"
cp -R "${TEMP_DIR}/licenses" "${OUTPUT_DIR}/licenses"

echo "Installed PDFium ${PDFIUM_VERSION} in ${OUTPUT_DIR}"
