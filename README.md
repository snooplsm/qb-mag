# qbittorrent-magnet

**Send magnet links straight to your remote qBittorrent Web UI—clientless, simple, and organized.**

## Overview

`qbittorrent-magnet` is a macOS utility that lets you click magnet links anywhere and send them directly to a remote qBittorrent client—like the one running on Kodi or LibreELEC. The app also parses filenames from magnet links and helps organize your downloads automatically.

### Key Features
- **One-click magnet link handling** — Send torrents to a remote qBittorrent Web UI with zero hassle.
- **Smart file parsing** — Extracts filenames to auto-create categories or organize your content.
- **Quick setup** — Configure your host, port, API key, and preferred download location once; it’ll remember those settings.

---

## Prerequisites

- A working **qBittorrent Web UI** setup with API access enabled.
  - Enable it in **Preferences → Web UI** inside qBittorrent.
  - Refer to [qbittorrent.org](https://www.qbittorrent.org/) for installation/setup across platforms.
- Compatible with qBittorrent **4.1+** (API v2 and above).
- Communicates with the Web API using standard REST calls (`torrents/add`, etc.).

---

## Installation

1. Download and mount the `.dmg`.
2. Drag **`qbittorrent-magnet.app`** into your Applications folder.
3. **Note:** The app is **not signed**. The first time you open it, macOS will block it.  
   - Go to **System Settings → Privacy & Security → Security**.  
   - You’ll see a message about `qbittorrent-magnet` being blocked.  
   - Click **Open Anyway** to allow the app to run.
4. Launch the app and configure your remote connection details.

---

## How to Use

1. Configure your remote:
   - **Host/IP**, **Port**, **API Key (if needed)**, and **Default Save Path**.
2. (Optional) Configure how filenames should be parsed for organizing downloads.
3. From any browser or app, click a magnet link:
   - `qbittorrent-magnet` intercepts it and sends the request to your remote qBittorrent client.
4. The torrent is queued in qBittorrent with your preferences applied.

---

## FAQ

**Q: How does `qbittorrent-magnet` send torrents?**  
A: It uses the [qBittorrent Web API](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-4.1%29) (`torrents/add`) behind the scenes.

---

## Acknowledgments

- Built on qBittorrent’s robust Web UI API.  
- Huge thanks to the qBittorrent open-source community.  
- See [Wikipedia](https://en.wikipedia.org/wiki/QBittorrent) for more about the project.

---

## Contact & Support

For bug reports, feature requests, or issues, please open a ticket in the GitHub repository.  

---

### TL;DR  
**qbittorrent-magnet** = *Click a magnet → App sends it to your remote torrent box (with smart organization).*  
⚠️ First launch requires approval in **macOS Privacy & Security** since the app is not signed.
