# qbittorrent-magnet

This repo now contains a **Tauri desktop app** version of qBittorrent Magnet alongside the original SwiftUI project.

## Tauri features implemented
- Magnet parsing for:
  - Shows
  - Movies
  - Books
  - Apps
- Extra scene-style metadata extraction (best-effort): quality, source, codec/format, HDR, group, PROPER, REPACK, language.
- qBittorrent submit via Web API (`/api/v2/torrents/add`).
- Server hash/ID tracking on submit (from BTIH and follow-up lookup when available).
- Queue browser (`/api/v2/torrents/info`) with move action (`/api/v2/torrents/setLocation`).
- Local persistent history in app data (`history.json`) including submit result, save path, hash/id, and parsed metadata.
- Optional qBittorrent login support (`/api/v2/auth/login`) when username/password are provided.

## Project layout
- Frontend: `/Users/snooplsm/qbittorrent-magnet/src`
- Backend (Rust/Tauri): `/Users/snooplsm/qbittorrent-magnet/src-tauri`

## Run (dev)
1. Install JS deps:
   - `npm install`
2. Run app:
   - `npm run dev`

## Build
- `npm run build`

## Notes
- Original SwiftUI/Xcode files remain untouched.
- Bundling is currently disabled in `src-tauri/tauri.conf.json` (`"bundle.active": false`) for faster iteration.
