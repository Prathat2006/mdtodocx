# Changelog

All notable changes to MarkDoc are documented here. Releases use the `vMAJOR.MINOR.PATCH` Git tag format. GitHub Release pages are the canonical place to download desktop installers.

## [1.0.2] - 2026-10-31

### Fixed

- Graphviz installation reads the official SHA-256 from the response header and supports checksum text in the response body.

### Release assets

- `MarkDoc_1.0.2_x64-setup.exe` — NSIS installer.
- `MarkDoc_1.0.2_x64_en-US.msi` — Windows Installer package.

[1.0.2]: https://github.com/Prathat2006/MarkDoc/releases/tag/v1.0.2
## [1.0.1] - 2026-10-31

### Fixed

- MiKTeX setup verifies the official archive SHA-256 because its setup utility is unsigned.
- The MSI now fails when dependency setup fails.

### Release assets

- `MarkDoc_1.0.1_x64-setup.exe` — NSIS installer.
- `MarkDoc_1.0.1_x64_en-US.msi` — Windows Installer package.

[1.0.1]: https://github.com/Prathat2006/mdtodocx/releases/tag/v1.0.1
## [1.0.0] - 2026-10-31

### Added

- Windows desktop application with NSIS (`.exe`) and WiX (`.msi`) installers.
- App-local setup for export dependencies, with reuse of system-installed tools and an installation log for troubleshooting.
- Local account, notes, equation studio, Markdown editor, live preview, and DOCX export in the desktop app.
- TikZ, Mermaid, and Graphviz diagram rendering in preview and exported documents.

### Fixed

- Graphviz DOCX export now uses the default `dot` layout engine, matching the node and edge arrangement in the browser SVG preview. The DOCX remains a 300-DPI PNG, so it can look less crisp than vector SVG when zoomed.
- TikZ fences, including empty fences, no longer consume the rest of the Markdown preview.
- Desktop export opens the native Save As dialog and writes the generated file to the selected location.
- Desktop startup and export subprocesses run without opening terminal windows.
- Equation Studio closed state persists in browser local storage.

### Release assets

- `MarkDoc_1.0.0_x64-setup.exe` — NSIS installer.
- `MarkDoc_1.0.0_x64_en-US.msi` — Windows Installer package.

[1.0.0]: https://github.com/Prathat2006/mdtodocx/releases/tag/v1.0.0
