# AGENTS.md - Project Guidelines for AI Agents

## 1. Project Overview
This project is a modern, high-performance comic/manga reader tailored for Linux (Ubuntu).
Key requirements:
- Fast on-demand extraction and display of images inside archives (7z, ZIP, RAR, CBZ, CBR).
- GPU-accelerated smooth rendering, zooming, and panning (ideal for 4K high-DPI displays).
- Low resource consumption with an intelligent image preloading/caching mechanism.

---

## 2. Tech Stack
- **Framework:** Tauri v2
- **Backend:** Rust (Tokio for async operations, `image` crate for high-quality resizing/decoding)
- **Frontend:** React (TypeScript) + Vite
- **Styling & UI:** Tailwind CSS + shadcn/ui
- **Target OS:** Linux (Ubuntu / WebKitGTK environment)
- **Preferred stable versions:**
  - Rust stable 1.85 or newer (required by archivefs edition 2024)
  - Tauri v2.x (latest stable patch release)
  - React 18.x
  - TypeScript 5.4+ / 5.x stable
  - Vite 5.x
  - Tailwind CSS 3.4+
  - `@tauri-apps/api` v2.x

- **Recommended Rust crate candidates:**
  - `lazy-archive` + `vfs-archive` from [archivefs](https://github.com/takanemu/archivefs) for format-independent archive access
  - `tokio` 1.35+ for async runtime
  - `image` 0.26+ for decoding/resizing and Lanczos3 filtering
  - `serde` 1.0+ for configuration and IPC payloads
  - `libarchive` 0.8+ or `zip` 0.7 + native `tar` support for archive reading
  - `xz2`, `bzip2`, `zstd` crates for compressed tar formats if needed
  - `glob` / `walkdir` for file discovery and folder scanning

- **Recommended frontend packages:**
  - `react` 18.x
  - `react-dom` 18.x
  - `typescript` 5.4+
  - `vite` 5.x
  - `tailwindcss` 3.4+
  - `@tailwindcss/forms`, `@tailwindcss/typography` as needed
  - `shadcn/ui` latest stable release matching React 18

---

## 3. Directory Structure
braveComicReader/
├── src/                  # Frontend (React + TypeScript)
│   ├── components/       # UI Components (shadcn/ui, Viewer, Sidebar, etc.)
│   ├── hooks/            # Custom React hooks (IPC, Keyboard shortcuts, etc.)
│   └── App.tsx           # Main application shell
├── src-tauri/            # Backend (Rust)
│   ├── capabilities/     # Tauri v2 Permission & Capability definitions
│   ├── src/              # Rust source code
│   │   ├── lib.rs        # Tauri commands and core logic
│   │   └── main.rs       # Entry point
│   ├── Cargo.toml        # Rust dependencies
│   └── tauri.conf.json   # Tauri configuration
└── AGENTS.md             # AI Agent guidelines (This file)

---

## 4. Architectural Rules & Best Practices

### A. Core Architecture & Performance
1. **On-Demand Archive Extraction:**
   - NEVER extract the full archive to disk or memory at once. Extract only requested pages or neighboring pages for preloading.
2. **Preloading & Memory Management:**
   - Preload the next 2 pages and previous 1 page in the background using Rust async tasks (`tokio`).
   - Evict unused image buffers to prevent memory leaks on large multi-page archives.
3. **GPU Rendering & 4K Display:**
   - Utilize browser hardware acceleration via CSS `transform` / `<canvas>` for panning and zooming.
   - For high-DPI scaling, configure image smoothing (`image-rendering` / `imageSmoothingQuality = 'high'`) or use Rust `image` crate filters (e.g., `Lanczos3`) when backend resizing is required.

### B. Tauri v2 & Security
1. **IPC & Commands:**
   - Expose backend capabilities to the frontend using Tauri commands (`#[tauri::command]`).
   - Always validate parameters (file paths, page numbers) in Rust before execution.
   - Prefer explicit error types over `Result<T, String>` where possible; use `thiserror` or custom enum-based errors for maintainability.
   - Pass readable error messages to the frontend and avoid leaking internal details.
2. **Capabilities & Permissions:**
   - Follow the strict Tauri v2 capability model. Define minimum necessary permissions in `src-tauri/capabilities/`.
   - Use Tauri's asset protocol or `convertFileSrc` to pass local image files safely to the WebView.
   - Restrict file system access to known directories and validate archive paths before opening.

---

## 5. Coding Conventions

### Rust (Backend)
- **Formatting & Style:** Strictly adhere to `rustfmt` and official Rust Style Guidelines.
- **Linting:** Code must pass `cargo clippy` without warnings.
- **Naming Conventions:**
  - Functions, variables, modules: `snake_case`
  - Types, Enums, Traits: `PascalCase`
  - Constants: `SCREAMING_SNAKE_CASE`
- **Error Handling:** Avoid `unwrap()` or `expect()` in production paths. Always use explicit error propagation (`?`) or pattern matching.

### TypeScript & React (Frontend)
- **Types:** Strict mode enabled. Avoid `any` type; define explicit interfaces/types for Tauri command parameters and payloads.
- **Components:** Functional components with React Hooks.
- **Styling:** Use Tailwind CSS utility classes and `shadcn/ui` components for consistent UI design and dark mode support.
- **Naming Conventions:**
  - Components, Types, Interfaces: `PascalCase`
  - Hooks: `camelCase` starting with `use` (e.g., `useComicPage`)
  - Variables, functions: `camelCase`

---

## 6. Helpful Commands for AI Execution

When requested to run checks or builds, use the following commands:

- **Development:** `npm run tauri:dev`
- **Frontend Type Check & Lint:** `npm run build` / `npm run lint`
- **Rust Linting:** `cargo clippy --manifest-path src-tauri/Cargo.toml`
- **Rust Formatting:** `cargo fmt --manifest-path src-tauri/Cargo.toml`
- **Build Release:** `npm run tauri:build`
