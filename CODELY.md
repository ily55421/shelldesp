

## Codely Structured Memories

### User

### Feedback
- [2026-08-12 10:11:03] node-pty native module cannot be rebuilt for Electron on this machine — TLS connection failures prevent downloading Electron headers from electronjs.org and npmmirror.com (ECONNRESET). **Why:** node-pty 1.1.0 doesn't use N-API, so prebuilt binaries are ABI-incompatible with Electron. **How to apply:** Use @homebridge/node-pty-prebuilt-multiarch instead — it uses node-addon-api (N-API), is ABI-stable across Node/Electron versions, and its prebuild-install falls back to local compilation successfully. No electron-rebuild needed.
- [2026-08-12 11:34:44] @homebridge/node-pty-prebuilt-multiarch Windows prebuilds (build/Release/*.node) get wiped when npm reinstall is triggered (e.g. installing ws with --no-save). prebuilds/ dir only has Linux binaries. **Why:** prebuild-install runs on postinstall but may silently fail to download Windows binaries without --force. **How to apply:** After any npm install that touches node-pty, verify build/Release/pty.node exists. If missing, run `npx prebuild-install -r node --force` from the node-pty package dir. Also: ASAR packaging breaks native module path resolution for this package — use `asar: false` in electron-builder.yml.

### Project
- [2026-08-12 10:11:03] User is building "ShellDesk" — a lightweight terminal management desktop app (Electron + Vue 3 + Vite) at E:\code\ai\shelldesp. Features: local terminal (node-pty + xterm.js), SSH/SFTP (ssh2), left sidebar with quick paths + shortcut commands (including multi-step combo commands). Chinese-first UI.
- [2026-08-12 11:02:58] ShellDesk architecture (as of 2026-08-12): Lazy terminal rendering — only active tab's xterm.js instance is mounted (v-if, not v-show). PTY/SSH sessions persist in main process when switching tabs via pause/resume IPC. Non-active tab output buffered in main process (max 512KB). Tab close = pty.kill; app exit = cleanup all. Max 12 tabs. scrollback=2000. PTY data batched at 16ms interval for IPC.
- [2026-08-12 12:00:52] ShellDesk UI redesign (2026-08-12): "琥珀荧光控制台" theme — amber #ffb000 accent on charcoal #0c0d10, 4-level bg, 3-level text. Chakra Petch (titles) + IBM Plex Mono (terminal/body). Custom frameless titlebar (titleBarStyle: 'hidden' + overlay) with SVG logo, window control buttons. StatusBar at bottom (connection/shell/cwd/encoding/latency). Tab bar with scroll arrows + auto-scroll-to-active. App icon: assets/icons/icon.ico. Scanline texture in terminal via separate div (not ::after, which breaks xterm canvas).
- [2026-08-12 13:32:18] ShellDesk security & quality audit (2026-08-12): Fixed 22 issues across 4 severity levels. Key fixes: B1 safeStorage encrypts SSH passwords at rest; B2 StringDecoder fixes UTF-8 multi-byte truncation; H1 all IPC handlers validate sender + shell whitelist + privateKey restricted to ~/.ssh; H2 pause writes residual buffer to pausedBuffer not IPC; M3 single-instance lock; M6 frame:false replaces titleBarOverlay (no more double buttons); M9 SSH keepalive 10s/3. git initialized with initial commit.

### Reference

