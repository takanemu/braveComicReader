#!/usr/bin/env sh
set -eu

ARCHIVEFS_VERSION="${ARCHIVEFS_VERSION:-v0.1.1}"
TARGET="${ARCHIVEFS_TARGET:-x86_64-unknown-linux-gnu}"
RELEASE_NAME="archivefs-${ARCHIVEFS_VERSION}-${TARGET}"
DOWNLOAD_URL="https://github.com/takanemu/archivefs/releases/download/${ARCHIVEFS_VERSION}/${RELEASE_NAME}.tar.gz"
CHECKSUM_URL="${DOWNLOAD_URL}.sha256"
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT_DIR="${PROJECT_ROOT}/src-tauri/binaries"
OUTPUT_PATH="${OUTPUT_DIR}/archivefs-bench-${TARGET}"
TEMP_DIR=$(mktemp -d)

cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT INT TERM

if [ "${TARGET}" != "x86_64-unknown-linux-gnu" ]; then
  echo "Unsupported archivefs target: ${TARGET}" >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"
curl --fail --location --silent --show-error "${DOWNLOAD_URL}" -o "${TEMP_DIR}/${RELEASE_NAME}.tar.gz"
curl --fail --location --silent --show-error "${CHECKSUM_URL}" -o "${TEMP_DIR}/${RELEASE_NAME}.tar.gz.sha256"

(
  cd "${TEMP_DIR}"
  sha256sum --check "${RELEASE_NAME}.tar.gz.sha256"
)

tar -xzf "${TEMP_DIR}/${RELEASE_NAME}.tar.gz" -C "${TEMP_DIR}"
install -m 0755 "${TEMP_DIR}/${RELEASE_NAME}/archivefs-bench" "${OUTPUT_PATH}"
echo "Installed ${OUTPUT_PATH}"
