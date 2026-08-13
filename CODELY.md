

## Codely Structured Memories

### User

### Feedback
- [2026-08-12 10:11:03] node-pty native module cannot be rebuilt for Electron on this machine — TLS connection failures prevent downloading Electron headers from electronjs.org and npmmirror.com (ECONNRESET). **Why:** node-pty 1.1.0 doesn't use N-API, so prebuilt binaries are ABI-incompatible with Electron. **How to apply:** Use @homebridge/node-pty-prebuilt-multiarch instead — it uses node-addon-api (N-API), is ABI-stable across Node/Electron versions, and its prebuild-install falls back to local compilation successfully. No electron-rebuild needed.
- [2026-08-12 11:34:44] @homebridge/node-pty-prebuilt-multiarch Windows prebuilds (build/Release/*.node) get wiped when npm reinstall is triggered (e.g. installing ws with --no-save). prebuilds/ dir only has Linux binaries. **Why:** prebuild-install runs on postinstall but may silently fail to download Windows binaries without --force. **How to apply:** After any npm install that touches node-pty, verify build/Release/pty.node exists. If missing, run `npx prebuild-install -r node --force` from the node-pty package dir. Also: ASAR packaging breaks native module path resolution for this package — use `asar: false` in electron-builder.yml.

### Project
- [2026-08-13 23:48:56] ShellDesk is at v1.2.x on branch `dev-link` (12 commits). Stack: Electron 33 + Vue 3 + Vite + xterm.js 6 + node-pty + ssh2 + Pinia. Features: local terminal (pwsh/cmd), SSH (password/key, keepalive), shortcut commands (single/multi-step), quick paths (drag-reorder), tab interactions (drag-reorder/double-click-rename/middle-close/right-click-menu), settings panel (fontSize/fontFamily/theme: amber/green/blue, autoReconnect, confirmClose, defaultShell — all wired and functional), disconnect reconnect overlay + exponential backoff, terminal search (Ctrl+Shift+F, @xterm/addon-search), terminal right-click menu (copy/paste/clear/selectAll/find), real SSH latency measurement (10s echo), session restore (lastTabs in settings). Engineering: ESLint flat config (.mjs), node:test smoke tests (10), pre-commit hook (typecheck+lint+test via Node install-hooks.js), GitHub Actions CI (Windows), security.ts shared sender validation, SFTP code @deprecated (v1.3 target).


- [2026-08-13 23:49:10] ShellDesk architecture (v1.2.x): Lazy terminal rendering — only active tab's xterm.js instance is mounted (v-if + :key). PTY/SSH sessions persist in main process via pause/resume IPC. Non-active tab output buffered (max 512KB). Max 12 tabs, scrollback=2000, PTY data batched at 16ms. TabStatus type: connecting/connected/disconnected — driven by TerminalPane events. Settings store (fontSize/fontFamily/theme/autoReconnect/confirmClose/defaultShell/lastTabs) persisted via electron-store; TerminalPane watches settings for live xterm reconfig. Reconnect: onDisconnected → overlay + optional exponential backoff (1s→30s cap). Session restore: saveTabs on unmount → restoreTabs on mount (settings.lastTabs). StatusBar: computed fontSize from settings store, SSH latency via 10s echo interval. Theme presets: THEME_PRESETS in stores/settings.ts (amber/green/blue).


- [2026-08-13 23:08:07] ShellDesk UI (v1.2.0): "琥珀荧光控制台" theme — amber #ffb000 accent on charcoal #0c0d10. Now supports 3 theme presets (amber/green/blue) switchable via SettingsDialog. Custom frameless titlebar (frame:false). Tab bar with scroll arrows, drag-reorder, double-click rename, middle-click close, right-click context menu. StatusBar shows real connection status (tab.status). Sidebar gear button opens SettingsDialog (no longer "开发中"). Scanline texture via separate div. Reconnect overlay on disconnect.

- [2026-08-12 13:32:18] ShellDesk security & quality audit (2026-08-12): Fixed 22 issues across 4 severity levels. Key fixes: B1 safeStorage encrypts SSH passwords at rest; B2 StringDecoder fixes UTF-8 multi-byte truncation; H1 all IPC handlers validate sender + shell whitelist + privateKey restricted to ~/.ssh; H2 pause writes residual buffer to pausedBuffer not IPC; M3 single-instance lock; M6 frame:false replaces titleBarOverlay (no more double buttons); M9 SSH keepalive 10s/3. git initialized with initial commit.

### Reference

