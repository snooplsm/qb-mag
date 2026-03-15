use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct AppState {
    initial_magnet: Mutex<Option<String>>,
    initial_torrent_file: Mutex<Option<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Media {
    Show {
        name: String,
        season: i32,
        episode: Option<i32>,
        quality: Option<String>,
        source: Option<String>,
        format: Option<String>,
        hdr: bool,
        release_group: Option<String>,
        proper: bool,
        repack: bool,
        language: Option<String>,
    },
    Movie {
        title: String,
        year: Option<i32>,
        quality: Option<String>,
        source: Option<String>,
        format: Option<String>,
        hdr: bool,
        release_group: Option<String>,
        proper: bool,
        repack: bool,
        language: Option<String>,
    },
    Book {
        title: String,
        year: Option<i32>,
        format: Option<String>,
        language: Option<String>,
        release_group: Option<String>,
    },
    App {
        name: String,
        version: Option<String>,
        platform: Option<String>,
        arch: Option<String>,
        release_group: Option<String>,
    },
}

#[derive(Debug, Serialize)]
struct UploadResult {
    success: bool,
    save_path: String,
    media: Option<Media>,
    torrent_hash: Option<String>,
    torrent_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct HistoryEntry {
    id: u64,
    ts_unix: u64,
    qb_url: String,
    magnet_url: String,
    save_path: String,
    success: bool,
    torrent_hash: Option<String>,
    torrent_name: Option<String>,
    media: Option<Media>,
}

#[derive(Debug, Serialize)]
struct QbTorrentInfo {
    hash: String,
    name: String,
    save_path: String,
    category: String,
    added_on: i64,
    state: String,
    progress: f64,
    dlspeed: i64,
    upspeed: i64,
    size: i64,
    completed: i64,
}

#[derive(Debug, Deserialize)]
struct QbTorrentInfoApi {
    hash: String,
    name: String,
    save_path: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    added_on: i64,
    state: String,
    #[serde(default)]
    progress: f64,
    #[serde(default)]
    dlspeed: i64,
    #[serde(default)]
    upspeed: i64,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    completed: i64,
}

#[derive(Debug, Serialize)]
struct TmdbMetadata {
    title: String,
    overview: Option<String>,
    image_url: Option<String>,
    episode_name: Option<String>,
    episode_image_url: Option<String>,
    page_url: Option<String>,
}

enum TmdbCreds {
    ApiKey(String),
    AccessToken(String),
}

#[derive(Debug)]
struct ExtraInfo {
    quality: Option<String>,
    source: Option<String>,
    format: Option<String>,
    hdr: bool,
    release_group: Option<String>,
    proper: bool,
    repack: bool,
    language: Option<String>,
}

#[derive(Debug, Clone)]
struct Auth {
    username: Option<String>,
    password: Option<String>,
}

#[tauri::command]
fn parse_magnet(magnet_url: String) -> Result<Option<Media>, String> {
    let parsed = parse_magnet_display_name(&magnet_url);
    println!(
        "[parse_magnet] parsed={} url_prefix={}",
        parsed.is_some(),
        magnet_url.chars().take(120).collect::<String>()
    );
    Ok(parsed)
}

#[tauri::command]
fn parse_release_name(name: String) -> Result<Option<Media>, String> {
    Ok(parse_media(&name))
}

#[tauri::command]
fn take_initial_magnet(state: State<AppState>) -> Option<String> {
    if let Ok(mut guard) = state.initial_magnet.lock() {
        guard.take()
    } else {
        None
    }
}

#[tauri::command]
fn take_initial_torrent_file(state: State<AppState>) -> Option<String> {
    if let Ok(mut guard) = state.initial_torrent_file.lock() {
        guard.take()
    } else {
        None
    }
}

#[tauri::command]
async fn upload_magnet(
    app: AppHandle,
    qb_url: String,
    magnet_url: String,
    username: Option<String>,
    password: Option<String>,
    save_path_override: Option<String>,
) -> Result<UploadResult, String> {
    let auth = Auth { username, password };
    let mut media = parse_magnet_display_name(&magnet_url);
    let dn_name = extract_dn_fallback(&magnet_url);
    if media.is_none() {
        if let Some(dn) = dn_name.as_deref() {
            media = parse_media(dn);
        }
    }
    let save_path = save_path_override
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| build_save_path(media.as_ref()));
    let base = qb_url.trim_end_matches('/').to_string();
    let client = qb_client(&base, &auth).await?;

    let add_endpoint = format!("{base}/api/v2/torrents/add");
    let response = client
        .post(add_endpoint)
        .form(&[
            ("urls", magnet_url.as_str()),
            ("savepath", save_path.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let success = response.status().is_success();
    let maybe_hash = extract_btih_hash(&magnet_url);

    let (torrent_hash, torrent_name) = if success {
        if let Some(hash) = maybe_hash.clone() {
            match fetch_torrent_by_hash(&client, &base, &hash).await {
                Ok(Some(t)) => (Some(t.hash), Some(t.name)),
                _ => (Some(hash), dn_name.clone()),
            }
        } else {
            (None, dn_name.clone())
        }
    } else {
        (None, dn_name.clone())
    };

    let result = UploadResult {
        success,
        save_path: save_path.clone(),
        media: media.clone(),
        torrent_hash: torrent_hash.clone(),
        torrent_name: torrent_name.clone(),
    };

    append_history(
        &app,
        HistoryEntry {
            id: 0,
            ts_unix: unix_now(),
            qb_url: base,
            magnet_url,
            save_path,
            success,
            torrent_hash,
            torrent_name,
            media,
        },
    )?;

    Ok(result)
}

#[tauri::command]
async fn upload_torrent_file(
    app: AppHandle,
    qb_url: String,
    torrent_path: String,
    username: Option<String>,
    password: Option<String>,
    save_path_override: Option<String>,
) -> Result<UploadResult, String> {
    let path = PathBuf::from(torrent_path.trim());
    if !path.exists() {
        return Err("Torrent file not found.".to_string());
    }
    let ext_ok = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("torrent"))
        .unwrap_or(false);
    if !ext_ok {
        return Err("Expected a .torrent file.".to_string());
    }

    let inferred_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("upload.torrent")
        .to_string();
    let file_bytes = fs::read(&path).map_err(|e| format!("Failed to read torrent file: {e}"))?;

    upload_torrent_payload(
        app,
        qb_url,
        file_name,
        file_bytes,
        inferred_name,
        username,
        password,
        save_path_override,
    )
    .await
}

#[tauri::command]
async fn upload_torrent_bytes(
    app: AppHandle,
    qb_url: String,
    file_name: String,
    file_bytes: Vec<u8>,
    username: Option<String>,
    password: Option<String>,
    save_path_override: Option<String>,
) -> Result<UploadResult, String> {
    if file_bytes.is_empty() {
        return Err("Torrent file bytes are empty.".to_string());
    }
    let inferred_name = PathBuf::from(file_name.trim())
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    upload_torrent_payload(
        app,
        qb_url,
        file_name,
        file_bytes,
        inferred_name,
        username,
        password,
        save_path_override,
    )
    .await
}

async fn upload_torrent_payload(
    app: AppHandle,
    qb_url: String,
    file_name: String,
    file_bytes: Vec<u8>,
    inferred_name: Option<String>,
    username: Option<String>,
    password: Option<String>,
    save_path_override: Option<String>,
) -> Result<UploadResult, String> {
    let auth = Auth { username, password };
    let base = qb_url.trim_end_matches('/').to_string();
    let client = qb_client(&base, &auth).await?;
    let media = inferred_name.as_deref().and_then(parse_media);
    let save_path = save_path_override
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| build_save_path(media.as_ref()));

    let add_endpoint = format!("{base}/api/v2/torrents/add");
    let form = reqwest::multipart::Form::new()
        .part(
            "torrents",
            reqwest::multipart::Part::bytes(file_bytes).file_name(file_name),
        )
        .text("savepath", save_path.clone());

    let response = client
        .post(add_endpoint)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let success = response.status().is_success();
    let result = UploadResult {
        success,
        save_path: save_path.clone(),
        media: media.clone(),
        torrent_hash: None,
        torrent_name: inferred_name.clone(),
    };

    append_history(
        &app,
        HistoryEntry {
            id: 0,
            ts_unix: unix_now(),
            qb_url: base,
            magnet_url: String::new(),
            save_path,
            success,
            torrent_hash: None,
            torrent_name: inferred_name,
            media,
        },
    )?;

    Ok(result)
}

#[tauri::command]
async fn list_torrents(
    qb_url: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<Vec<QbTorrentInfo>, String> {
    let auth = Auth { username, password };
    let base = qb_url.trim_end_matches('/').to_string();
    let client = qb_client(&base, &auth).await?;
    let endpoint = format!("{base}/api/v2/torrents/info");
    let data = client
        .get(endpoint)
        .send()
        .await
        .map_err(|e| format!("Failed to list torrents: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Failed to list torrents: {e}"))?
        .json::<Vec<QbTorrentInfoApi>>()
        .await
        .map_err(|e| format!("Invalid torrent response: {e}"))?;

    Ok(data
        .into_iter()
        .map(|t| QbTorrentInfo {
            hash: t.hash,
            name: t.name,
            save_path: t.save_path,
            category: t.category,
            added_on: t.added_on,
            state: t.state,
            progress: t.progress,
            dlspeed: t.dlspeed,
            upspeed: t.upspeed,
            size: t.size,
            completed: t.completed,
        })
        .collect())
}

#[tauri::command]
async fn move_torrents(
    qb_url: String,
    hashes: Vec<String>,
    location: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<bool, String> {
    if hashes.is_empty() {
        return Err("No torrent hashes provided".to_string());
    }
    if location.trim().is_empty() {
        return Err("Location is required".to_string());
    }

    let auth = Auth { username, password };
    let base = qb_url.trim_end_matches('/').to_string();
    let client = qb_client(&base, &auth).await?;

    let endpoint = format!("{base}/api/v2/torrents/setLocation");
    let hashes_joined = hashes.join("|");
    let response = client
        .post(endpoint)
        .form(&[
            ("hashes", hashes_joined.as_str()),
            ("location", location.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Move request failed: {e}"))?;

    Ok(response.status().is_success())
}

#[tauri::command]
async fn get_free_space(
    qb_url: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<i64, String> {
    let auth = Auth { username, password };
    let base = qb_url.trim_end_matches('/').to_string();
    let client = qb_client(&base, &auth).await?;
    // qBittorrent versions differ: free space may appear in transfer/info or sync/maindata server_state.
    let transfer_endpoint = format!("{base}/api/v2/transfer/info");
    let transfer_json = client
        .get(transfer_endpoint)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch transfer info: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Failed to fetch transfer info: {e}"))?
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid transfer info response: {e}"))?;
    if let Some(space) = extract_free_space_from_json(&transfer_json) {
        return Ok(space);
    }

    let maindata_endpoint = format!("{base}/api/v2/sync/maindata");
    let maindata_json = client
        .get(maindata_endpoint)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch main data: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Failed to fetch main data: {e}"))?
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid main data response: {e}"))?;
    if let Some(space) = extract_free_space_from_json(&maindata_json) {
        return Ok(space);
    }

    Err("free_space_on_disk not present in qBittorrent API response".to_string())
}

fn extract_free_space_from_json(v: &Value) -> Option<i64> {
    v.get("free_space_on_disk")
        .and_then(Value::as_i64)
        .or_else(|| {
            v.get("server_state")
                .and_then(|s| s.get("free_space_on_disk"))
                .and_then(Value::as_i64)
        })
}

#[tauri::command]
async fn torrent_action(
    qb_url: String,
    hashes: Vec<String>,
    action: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<bool, String> {
    if hashes.is_empty() {
        return Err("No torrent hashes provided".to_string());
    }

    let auth = Auth { username, password };
    let base = qb_url.trim_end_matches('/').to_string();
    let client = qb_client(&base, &auth).await?;
    let hashes_joined = hashes.join("|");
    let action_key = action.trim().to_lowercase();

    let request = match action_key.as_str() {
        // Remove torrent and payload files.
        "delete_with_files" => client
            .post(format!("{base}/api/v2/torrents/delete"))
            .form(&[("hashes", hashes_joined.as_str()), ("deleteFiles", "true")]),
        // Remove torrent only; keep payload files.
        "remove_keep_files" => client
            .post(format!("{base}/api/v2/torrents/delete"))
            .form(&[("hashes", hashes_joined.as_str()), ("deleteFiles", "false")]),
        // Force-start download.
        "force_start" => client
            .post(format!("{base}/api/v2/torrents/setForceStart"))
            .form(&[("hashes", hashes_joined.as_str()), ("value", "true")]),
        // Ask trackers for an immediate announce.
        "reannounce" => client
            .post(format!("{base}/api/v2/torrents/reannounce"))
            .form(&[("hashes", hashes_joined.as_str())]),
        // Pause active torrent.
        "pause" => client
            .post(format!("{base}/api/v2/torrents/pause"))
            .form(&[("hashes", hashes_joined.as_str())]),
        // Resume stopped/paused torrent.
        "resume" => client
            .post(format!("{base}/api/v2/torrents/resume"))
            .form(&[("hashes", hashes_joined.as_str())]),
        _ => return Err(format!("Unsupported action: {action}")),
    };

    let response = request
        .send()
        .await
        .map_err(|e| format!("Torrent action request failed: {e}"))?;

    Ok(response.status().is_success())
}

#[tauri::command]
fn get_history(app: AppHandle) -> Result<Vec<HistoryEntry>, String> {
    read_history(&app)
}

#[tauri::command]
fn clear_history(app: AppHandle) -> Result<bool, String> {
    let path = history_file_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Failed to clear history: {e}"))?;
    }
    Ok(true)
}

#[tauri::command]
fn delete_history_entry(app: AppHandle, id: u64) -> Result<bool, String> {
    let mut history = read_history(&app)?;
    let before = history.len();
    history.retain(|entry| entry.id != id);
    if history.len() == before {
        return Ok(false);
    }

    let raw = serde_json::to_string_pretty(&history)
        .map_err(|e| format!("Failed to serialize history: {e}"))?;
    let path = history_file_path(&app)?;
    fs::write(path, raw).map_err(|e| format!("Failed to write history: {e}"))?;
    Ok(true)
}

#[tauri::command]
async fn fetch_tmdb_metadata(
    media: Media,
    tmdb_api_key: String,
    tmdb_access_token: Option<String>,
) -> Result<Option<TmdbMetadata>, String> {
    let creds = resolve_tmdb_creds(&tmdb_api_key, tmdb_access_token.as_deref());
    let Some(creds) = creds else {
        return Ok(None);
    };

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Failed to create TMDb client: {e}"))?;

    let (query, media_type) = match media {
        Media::Show { ref name, .. } => (name.clone(), "tv"),
        Media::Movie { ref title, .. } => (title.clone(), "movie"),
        _ => return Ok(None),
    };

    let mut search_queries: Vec<(String, Option<i32>)> = vec![(query.clone(), None)];
    let mut wanted_year = None;
    if media_type == "tv" {
        let (base_name, year_opt) = split_trailing_year(&query);
        wanted_year = year_opt;
        if let Some(y) = year_opt {
            if !base_name.is_empty() {
                search_queries.insert(0, (base_name.clone(), Some(y)));
            }
        }
        let stripped = strip_trailing_year(&query);
        if !stripped.is_empty()
            && !search_queries
                .iter()
                .any(|(q, _)| q.eq_ignore_ascii_case(&stripped))
        {
            search_queries.push((stripped.clone(), None));
        }
        let stripped_season = strip_trailing_season(&stripped);
        if !stripped_season.is_empty()
            && !search_queries
                .iter()
                .any(|(q, _)| q.eq_ignore_ascii_case(&stripped_season))
        {
            search_queries.push((stripped_season, None));
        }
    }

    let mut first = None;
    for (q, year_hint) in search_queries {
        let mut search_url = format!(
            "https://api.themoviedb.org/3/search/{media_type}?query={}",
            urlencoding::encode(&q)
        );
        if media_type == "tv" {
            if let Some(y) = year_hint.or(wanted_year) {
                search_url.push_str("&first_air_date_year=");
                search_url.push_str(&y.to_string());
            }
        }
        let search = fetch_tmdb_json(&client, &creds, &search_url).await?;
        let mut candidate = search
            .get("results")
            .and_then(Value::as_array)
            .and_then(|arr| {
                if media_type == "tv" {
                    if let Some(y) = wanted_year {
                        if let Some(exact) =
                            arr.iter().find(|item| result_year(item, media_type) == Some(y))
                        {
                            return Some(exact.clone());
                        }
                    }
                }
                arr.first().cloned()
            });
        if first.is_none() && candidate.is_some() {
            first = candidate.take();
        }
        if first.is_some() {
            break;
        }
    }

    let Some(first) = first else {
        return Ok(None);
    };

    let id = first.get("id");
    let Some(id_num) = id.and_then(Value::as_i64) else {
        return Ok(None);
    };

    let details_url = if media_type == "tv" {
        format!("https://api.themoviedb.org/3/tv/{id_num}")
    } else {
        format!("https://api.themoviedb.org/3/movie/{id_num}")
    };

    let data = fetch_tmdb_json(&client, &creds, &details_url)
        .await
        .unwrap_or(Value::Null);

    let title = data
        .get("title")
        .or_else(|| data.get("name"))
        .or_else(|| first.get("title"))
        .or_else(|| first.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(query.as_str())
        .to_string();

    let overview = data
        .get("overview")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .or_else(|| {
            first
                .get("overview")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        });

    let mut image_url = data
        .get("poster_path")
        .or_else(|| first.get("poster_path"))
        .and_then(Value::as_str)
        .map(|s| format!("https://image.tmdb.org/t/p/w342{s}"));

    let mut episode_name = None;
    let mut episode_image_url = None;
    let mut page_url = Some(if media_type == "tv" {
        format!("https://www.themoviedb.org/tv/{id_num}")
    } else {
        format!("https://www.themoviedb.org/movie/{id_num}")
    });
    if let Media::Show { season, episode, .. } = media {
        let season_url = format!("https://api.themoviedb.org/3/tv/{id_num}/season/{season}");
        if let Ok(season_json) = fetch_tmdb_json(&client, &creds, &season_url).await {
            if let Some(season_poster) = season_json
                .get("poster_path")
                .and_then(Value::as_str)
                .map(|s| format!("https://image.tmdb.org/t/p/w342{s}"))
            {
                image_url = Some(season_poster);
            }
        }

        if let Some(ep) = episode {
            let ep_url =
                format!("https://api.themoviedb.org/3/tv/{id_num}/season/{season}/episode/{ep}");
            if let Ok(ep_json) = fetch_tmdb_json(&client, &creds, &ep_url).await {
                episode_name = ep_json
                    .get("name")
                    .or_else(|| ep_json.get("overview"))
                    .and_then(Value::as_str)
                    .map(|s| s.to_string());
                episode_image_url = ep_json
                    .get("still_path")
                    .and_then(Value::as_str)
                    .map(|s| format!("https://image.tmdb.org/t/p/w300{s}"));
            }
            page_url = Some(format!(
                "https://www.themoviedb.org/tv/{id_num}/season/{season}/episode/{ep}"
            ));
        }
    }

    Ok(Some(TmdbMetadata {
        title,
        overview,
        image_url,
        episode_name,
        episode_image_url,
        page_url,
    }))
}

#[tauri::command]
fn open_external(url: String) -> Result<bool, String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Only http(s) URLs are allowed".to_string());
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(trimmed).status();

    #[cfg(target_os = "windows")]
    let status = Command::new("cmd")
        .args(["/C", "start", "", trimmed])
        .status();

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(trimmed).status();

    let ok = status
        .map_err(|e| format!("Failed to open URL: {e}"))?
        .success();
    Ok(ok)
}

fn resolve_tmdb_creds(api_key_input: &str, access_token_input: Option<&str>) -> Option<TmdbCreds> {
    let api_key = api_key_input.trim();
    if !api_key.is_empty() {
        return Some(TmdbCreds::ApiKey(api_key.to_string()));
    }

    let access_token = access_token_input.unwrap_or("").trim();
    if !access_token.is_empty() {
        return Some(TmdbCreds::AccessToken(access_token.to_string()));
    }

    if let Ok(v) = env::var("TMDB_API_KEY") {
        let val = v.trim().to_string();
        if !val.is_empty() {
            return Some(TmdbCreds::ApiKey(val));
        }
    }

    if let Ok(v) = env::var("TMDB_ACCESS_TOKEN") {
        let val = v.trim().to_string();
        if !val.is_empty() {
            return Some(TmdbCreds::AccessToken(val));
        }
    }

    if let Some(v) = option_env!("TMDB_API_KEY") {
        let val = v.trim().to_string();
        if !val.is_empty() {
            return Some(TmdbCreds::ApiKey(val));
        }
    }

    if let Some(v) = option_env!("TMDB_ACCESS_TOKEN") {
        let val = v.trim().to_string();
        if !val.is_empty() {
            return Some(TmdbCreds::AccessToken(val));
        }
    }

    None
}

async fn qb_client(base: &str, auth: &Auth) -> Result<reqwest::Client, String> {
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let username = auth.username.as_deref().unwrap_or("").trim();
    let password = auth.password.as_deref().unwrap_or("").trim();
    if !username.is_empty() || !password.is_empty() {
        let login_endpoint = format!("{base}/api/v2/auth/login");
        let response = client
            .post(login_endpoint)
            .form(&[("username", username), ("password", password)])
            .send()
            .await
            .map_err(|e| format!("Login request failed: {e}"))?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() || !body.contains("Ok") {
            return Err(format!("qBittorrent login failed: {body}"));
        }
    }

    Ok(client)
}

async fn fetch_tmdb_json(
    client: &reqwest::Client,
    creds: &TmdbCreds,
    url: &str,
) -> Result<Value, String> {
    let mut req = client.get(url);
    match creds {
        TmdbCreds::ApiKey(k) => {
            req = req.query(&[("api_key", k)]);
        }
        TmdbCreds::AccessToken(token) => {
            req = req.bearer_auth(token);
        }
    }

    req.send()
        .await
        .map_err(|e| format!("TMDb request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("TMDb request failed: {e}"))?
        .json::<Value>()
        .await
        .map_err(|e| format!("TMDb invalid JSON: {e}"))
}

async fn fetch_torrent_by_hash(
    client: &reqwest::Client,
    qb_url: &str,
    hash: &str,
) -> Result<Option<QbTorrentInfo>, String> {
    let endpoint = format!("{qb_url}/api/v2/torrents/info?hashes={hash}");
    let torrents = client
        .get(endpoint)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch torrent info: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Failed to fetch torrent info: {e}"))?
        .json::<Vec<QbTorrentInfoApi>>()
        .await
        .map_err(|e| format!("Invalid torrent info response: {e}"))?;

    Ok(torrents.into_iter().next().map(|t| QbTorrentInfo {
        hash: t.hash,
        name: t.name,
        save_path: t.save_path,
        category: t.category,
        added_on: t.added_on,
        state: t.state,
        progress: t.progress,
        dlspeed: t.dlspeed,
        upspeed: t.upspeed,
        size: t.size,
        completed: t.completed,
    }))
}

fn history_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    dir.push("history.json");
    Ok(dir)
}

fn read_history(app: &AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let path = history_file_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(path).map_err(|e| format!("Failed to read history: {e}"))?;
    serde_json::from_str::<Vec<HistoryEntry>>(&raw)
        .map_err(|e| format!("Failed to parse history JSON: {e}"))
}

fn append_history(app: &AppHandle, mut entry: HistoryEntry) -> Result<(), String> {
    let mut history = read_history(app)?;
    let next_id = history.last().map_or(1, |e| e.id + 1);
    entry.id = next_id;
    history.push(entry);

    let raw = serde_json::to_string_pretty(&history)
        .map_err(|e| format!("Failed to serialize history: {e}"))?;
    let path = history_file_path(app)?;
    fs::write(path, raw).map_err(|e| format!("Failed to write history: {e}"))
}

fn parse_magnet_display_name(magnet_url: &str) -> Option<Media> {
    let trimmed = magnet_url.trim();

    let display_name = url::Url::parse(trimmed)
        .ok()
        .and_then(|parsed| {
            parsed
                .query_pairs()
                .find(|(k, _)| k.eq_ignore_ascii_case("dn"))
                .map(|(_, v)| v.to_string())
        })
        .or_else(|| extract_dn_fallback(trimmed))?;

    parse_media(&display_name)
}

fn extract_dn_fallback(magnet_url: &str) -> Option<String> {
    let query = magnet_url.split_once('?')?.1;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        if k.eq_ignore_ascii_case("dn") {
            return Some(v.into_owned());
        }
    }
    None
}

fn parse_media(display_name: &str) -> Option<Media> {
    let extra = extract_extra_info(display_name);
    let has_season =
        Regex::new(r"(?i)(?:\b[s]\d{1,2}(?:[e]\d{1,2})?\b|\bseason[\s\.\+_-]*\d{1,2}\b)")
        .ok()
        .map(|re| re.is_match(display_name))
        .unwrap_or(false);

    // Match Swift logic: if season marker exists, only attempt show parse.
    if has_season {
        let show_regex = Regex::new(
            r"(?i)^(?P<name>.+?)[\s\.\+_-]+[Ss](?P<season>\d{1,2})(?:[Ee](?P<episode>\d{1,2}))?",
        )
        .ok()?;
        if let Some(caps) = show_regex.captures(display_name) {
            let name = normalize(caps.name("name")?.as_str());
            let season = caps.name("season")?.as_str().parse::<i32>().ok()?;
            let episode = caps
                .name("episode")
                .and_then(|m| m.as_str().parse::<i32>().ok());
            return Some(Media::Show {
                name,
                season,
                episode,
                quality: extra.quality,
                source: extra.source,
                format: extra.format,
                hdr: extra.hdr,
                release_group: extra.release_group,
                proper: extra.proper,
                repack: extra.repack,
                language: extra.language,
            });
        }

        // Fallback for noisier scene names: find Sxx/Eyy anywhere and use the
        // prefix as show name.
        let loose_show_regex =
            Regex::new(r"(?i)[\s\.\+_-]+[Ss](?P<season>\d{1,2})(?:[Ee](?P<episode>\d{1,2}))?")
                .ok()?;
        if let Some(m) = loose_show_regex.find(display_name) {
            let prefix = &display_name[..m.start()];
            let season_caps = loose_show_regex.captures(m.as_str());
            if let Some(caps) = season_caps {
                let name = normalize(prefix);
                if !name.is_empty() {
                    let season = caps.name("season")?.as_str().parse::<i32>().ok()?;
                    let episode = caps
                        .name("episode")
                        .and_then(|ep| ep.as_str().parse::<i32>().ok());
                    return Some(Media::Show {
                        name,
                        season,
                        episode,
                        quality: extra.quality,
                        source: extra.source,
                        format: extra.format,
                        hdr: extra.hdr,
                        release_group: extra.release_group,
                        proper: extra.proper,
                        repack: extra.repack,
                        language: extra.language,
                    });
                }
            }
        }

        // Complete-season packs, e.g.:
        // "Chicago.Med.S05.COMPLETE.720p.AMZN.WEBRip.x264-GalaxyTV"
        let complete_pack_regex = Regex::new(
            r"(?i)^(?P<name>.+?)[\s\.\+_-]+S(?P<season>\d{1,2})[\s\.\+_-]+COMPLETE\b",
        )
        .ok()?;
        if let Some(caps) = complete_pack_regex.captures(display_name) {
            let name = normalize(caps.name("name")?.as_str());
            if !name.is_empty() {
                let season = caps.name("season")?.as_str().parse::<i32>().ok()?;
                return Some(Media::Show {
                    name,
                    season,
                    episode: None,
                    quality: extra.quality,
                    source: extra.source,
                    format: extra.format,
                    hdr: extra.hdr,
                    release_group: extra.release_group,
                    proper: extra.proper,
                    repack: extra.repack,
                    language: extra.language,
                });
            }
        }

        // Season-pack naming style, e.g.:
        // "One Piece - Season 2"
        let season_word_regex = Regex::new(
            r"(?i)^(?P<name>.+?)(?:[\s\.\+_-]*[-:][\s\.\+_-]*|[\s\.\+_-]+)Season[\s\.\+_-]*(?P<season>\d{1,2})\b",
        )
        .ok()?;
        if let Some(caps) = season_word_regex.captures(display_name) {
            let name = normalize(caps.name("name")?.as_str());
            if !name.is_empty() {
                let season = caps.name("season")?.as_str().parse::<i32>().ok()?;
                return Some(Media::Show {
                    name,
                    season,
                    episode: None,
                    quality: extra.quality,
                    source: extra.source,
                    format: extra.format,
                    hdr: extra.hdr,
                    release_group: extra.release_group,
                    proper: extra.proper,
                    repack: extra.repack,
                    language: extra.language,
                });
            }
        }
    } else {
        // Match Swift logic: without season marker, only attempt movie parse.
        let movie_regex =
            Regex::new(r"(?i)^(?P<title>.+?)[\s\.\+_-]+\(?\s*(?P<year>\d{4})\s*\)?").ok()?;
        if let Some(caps) = movie_regex.captures(display_name) {
            let title = normalize(caps.name("title")?.as_str());
            let year = caps
                .name("year")
                .and_then(|m| m.as_str().replace(',', "").parse::<i32>().ok());
            return Some(Media::Movie {
                title,
                year,
                quality: extra.quality,
                source: extra.source,
                format: extra.format,
                hdr: extra.hdr,
                release_group: extra.release_group,
                proper: extra.proper,
                repack: extra.repack,
                language: extra.language,
            });
        }
    }

    let book_regex = Regex::new(
        r"(?i)^(?P<title>.+?)(?:[\s\.\+_-]+(?P<year>\d{4}))?.*?(?P<format>EPUB|PDF|MOBI|AZW3|CBR|CBZ|AUDIOBOOK)?",
    )
    .ok()?;
    let has_book_signal = Regex::new(r"(?i)\b(EPUB|PDF|MOBI|AZW3|CBR|CBZ|AUDIOBOOK|EBOOK)\b")
        .ok()?
        .is_match(display_name);
    if has_book_signal {
        if let Some(caps) = book_regex.captures(display_name) {
            let title = normalize(caps.name("title")?.as_str());
            let year = caps
                .name("year")
                .and_then(|m| m.as_str().parse::<i32>().ok());
            let format = caps.name("format").map(|m| m.as_str().to_uppercase());
            return Some(Media::Book {
                title,
                year,
                format,
                language: extra.language,
                release_group: extra.release_group,
            });
        }
    }

    let app_regex = Regex::new(
        r"(?i)^(?P<name>.+?)(?:[\s\.\+_-]+v?(?P<version>\d+(?:\.\d+){0,3}))?.*?(?P<platform>WIN(?:DOWS)?|MAC|LINUX|ANDROID|IOS)?",
    )
    .ok()?;
    let has_app_signal =
        Regex::new(r"(?i)\b(WIN(?:DOWS)?|MAC|LINUX|ANDROID|IOS|X64|X86|ARM64|CRACK)\b")
            .ok()?
            .is_match(display_name);
    if has_app_signal {
        if let Some(caps) = app_regex.captures(display_name) {
            let name = normalize(caps.name("name")?.as_str());
            let version = caps.name("version").map(|m| m.as_str().to_string());
            let platform = caps.name("platform").map(|m| m.as_str().to_uppercase());
            let arch = extract_arch(display_name);
            return Some(Media::App {
                name,
                version,
                platform,
                arch,
                release_group: extra.release_group,
            });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_complete_season_pack() {
        let input = "Chicago.Med.S05.COMPLETE.720p.AMZN.WEBRip.x264-GalaxyTV";
        let media = parse_media(input);
        match media {
            Some(Media::Show {
                name,
                season,
                episode,
                quality,
                ..
            }) => {
                assert_eq!(name, "Chicago Med");
                assert_eq!(season, 5);
                assert_eq!(episode, None);
                assert_eq!(quality.as_deref(), Some("720p"));
            }
            _ => panic!("expected show parse for complete season pack"),
        }
    }

    #[test]
    fn still_parses_standard_episode() {
        let input = "Paradise.2025.S02E05.The.Mailman.2160p.DSNP.WEB-DL.DDP5.1.H.265-RAWR";
        let media = parse_media(input);
        match media {
            Some(Media::Show {
                name,
                season,
                episode,
                ..
            }) => {
                assert_eq!(name, "Paradise 2025");
                assert_eq!(season, 2);
                assert_eq!(episode, Some(5));
            }
            _ => panic!("expected show parse for standard SxxExx"),
        }
    }

    #[test]
    fn still_parses_movie() {
        let input = "Wuthering.Heights.2026.1080p.WEB-DL.H264-DkS";
        let media = parse_media(input);
        match media {
            Some(Media::Movie { title, year, .. }) => {
                assert_eq!(title, "Wuthering Heights");
                assert_eq!(year, Some(2026));
            }
            _ => panic!("expected movie parse"),
        }
    }

    #[test]
    fn parses_season_word_pack() {
        let input = "One Piece - Season 2";
        let media = parse_media(input);
        match media {
            Some(Media::Show {
                name,
                season,
                episode,
                ..
            }) => {
                assert_eq!(name, "One Piece");
                assert_eq!(season, 2);
                assert_eq!(episode, None);
            }
            _ => panic!("expected show parse for season word pack"),
        }
    }

    #[test]
    fn splits_trailing_year_for_disambiguation() {
        let (name, year) = split_trailing_year("Paradise 2025");
        assert_eq!(name, "Paradise");
        assert_eq!(year, Some(2025));
    }
}

fn normalize(value: &str) -> String {
    Regex::new(r"[\.\+_-]+")
        .ok()
        .map(|re| re.replace_all(value, " ").trim().to_string())
        .unwrap_or_else(|| value.trim().to_string())
}

fn strip_trailing_year(value: &str) -> String {
    Regex::new(r"(?i)\s+(19\d{2}|20\d{2}|21\d{2})$")
        .ok()
        .map(|re| re.replace(value.trim(), "").trim().to_string())
        .unwrap_or_else(|| value.trim().to_string())
}

fn split_trailing_year(value: &str) -> (String, Option<i32>) {
    let re = Regex::new(r"(?i)^(?P<name>.+?)\s+(?P<year>19\d{2}|20\d{2}|21\d{2})$");
    if let Ok(re) = re {
        if let Some(caps) = re.captures(value.trim()) {
            let name = caps
                .name("name")
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_else(|| value.trim().to_string());
            let year = caps
                .name("year")
                .and_then(|m| m.as_str().parse::<i32>().ok());
            return (name, year);
        }
    }
    (value.trim().to_string(), None)
}

fn strip_trailing_season(value: &str) -> String {
    Regex::new(r"(?i)(?:\s*[-:]\s*|\s+)season\s+\d{1,2}$")
        .ok()
        .map(|re| re.replace(value.trim(), "").trim().to_string())
        .unwrap_or_else(|| value.trim().to_string())
}

fn result_year(item: &Value, media_type: &str) -> Option<i32> {
    let key = if media_type == "tv" {
        "first_air_date"
    } else {
        "release_date"
    };
    let date = item.get(key).and_then(Value::as_str)?;
    let year = date.get(0..4)?;
    year.parse::<i32>().ok()
}

fn extract_extra_info(display_name: &str) -> ExtraInfo {
    let quality = Regex::new(r"(?i)\b(\d{3,4}p)\b")
        .ok()
        .and_then(|re| re.captures(display_name))
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()));

    let source = Regex::new(r"(?i)\b(WEB[-\s]?DL|WEB|BLURAY|DVDRIP|HDTV|REMUX)\b")
        .ok()
        .and_then(|re| re.captures(display_name))
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()));

    let format = Regex::new(r"(?i)\b(x265|H\s?265|xvid|h264|H\s?264|HEVC|AV1|FLAC|AAC)\b")
        .ok()
        .and_then(|re| re.captures(display_name))
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()));

    let hdr = Regex::new(r"(?i)\b(HDR|DV|DOLBY[\s\.-]?VISION)\b")
        .ok()
        .map(|re| re.is_match(display_name))
        .unwrap_or(false);

    let release_group = Regex::new(r"-([A-Za-z0-9][A-Za-z0-9\._]{1,20})$")
        .ok()
        .and_then(|re| re.captures(display_name))
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()));

    let proper = Regex::new(r"(?i)\bPROPER\b")
        .ok()
        .map(|re| re.is_match(display_name))
        .unwrap_or(false);

    let repack = Regex::new(r"(?i)\bREPACK\b")
        .ok()
        .map(|re| re.is_match(display_name))
        .unwrap_or(false);

    let language = Regex::new(r"(?i)\b(ENGLISH|GERMAN|FRENCH|SPANISH|MULTI)\b")
        .ok()
        .and_then(|re| re.captures(display_name))
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()));

    ExtraInfo {
        quality,
        source,
        format,
        hdr,
        release_group,
        proper,
        repack,
        language,
    }
}

fn extract_arch(display_name: &str) -> Option<String> {
    Regex::new(r"(?i)\b(X64|X86|ARM64|AARCH64)\b")
        .ok()
        .and_then(|re| re.captures(display_name))
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_uppercase()))
}

fn build_save_path(media: Option<&Media>) -> String {
    match media {
        Some(Media::Show { name, season, .. }) => format!("/tv/{name}/Season {season}"),
        Some(Media::Movie { title, year, .. }) => {
            let year_string = year.map_or_else(|| "unknown".to_string(), |y| y.to_string());
            format!("/movies/{title} {year_string}").trim().to_string()
        }
        Some(Media::Book { title, .. }) => format!("/books/{title}"),
        Some(Media::App { name, .. }) => format!("/apps/{name}"),
        None => "/downloads".to_string(),
    }
}

fn extract_btih_hash(magnet_url: &str) -> Option<String> {
    let parsed = url::Url::parse(magnet_url).ok()?;
    let xt = parsed
        .query_pairs()
        .find(|(k, _)| k.eq_ignore_ascii_case("xt"))
        .map(|(_, v)| v.to_string())?;

    let lower = xt.to_ascii_lowercase();
    let prefix = "urn:btih:";
    if !lower.starts_with(prefix) {
        return None;
    }

    let raw = xt[prefix.len()..].trim();
    if raw.len() == 40 && raw.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(raw.to_ascii_lowercase());
    }

    decode_base32_to_hex(raw)
}

fn decode_base32_to_hex(input: &str) -> Option<String> {
    let mut bits: u64 = 0;
    let mut bit_count = 0usize;
    let mut out: Vec<u8> = Vec::new();

    for ch in input.chars() {
        let v = match ch {
            'A'..='Z' => (ch as u8 - b'A') as u64,
            'a'..='z' => (ch as u8 - b'a') as u64,
            '2'..='7' => (ch as u8 - b'2' + 26) as u64,
            _ => return None,
        };

        bits = (bits << 5) | v;
        bit_count += 5;

        while bit_count >= 8 {
            let shift = bit_count - 8;
            let byte = ((bits >> shift) & 0xff) as u8;
            out.push(byte);
            bit_count -= 8;
            bits &= (1u64 << bit_count).saturating_sub(1);
        }
    }

    if out.len() == 20 {
        Some(out.iter().map(|b| format!("{b:02x}")).collect())
    } else {
        None
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn normalize_magnet_candidate(arg: &str) -> Option<String> {
    if arg.starts_with("magnet:") {
        return Some(arg.to_string());
    }

    if let Ok(decoded) = urlencoding::decode(arg) {
        let decoded_ref = decoded.as_ref();
        if decoded_ref.starts_with("magnet:") {
            return Some(decoded_ref.to_string());
        }
    }

    if let Some(pos) = arg.find("magnet:") {
        return Some(arg[pos..].to_string());
    }

    None
}

fn extract_magnet_arg(args: &[String]) -> Option<String> {
    args.iter().find_map(|arg| normalize_magnet_candidate(arg))
}

fn normalize_torrent_path_candidate(arg: &str) -> Option<String> {
    let trimmed = arg.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(url) = url::Url::parse(trimmed) {
        if url.scheme() == "file" {
            if let Ok(path) = url.to_file_path() {
                let is_torrent = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.eq_ignore_ascii_case("torrent"))
                    .unwrap_or(false);
                if is_torrent {
                    return Some(path.to_string_lossy().to_string());
                }
            }
        }
    }

    let path = PathBuf::from(trimmed);
    let is_torrent = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("torrent"))
        .unwrap_or(false);
    if is_torrent {
        return Some(path.to_string_lossy().to_string());
    }

    None
}

fn extract_torrent_arg(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|arg| normalize_torrent_path_candidate(arg))
}

fn store_pending_magnet(app: &AppHandle, magnet: String) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut guard) = state.initial_magnet.lock() {
            *guard = Some(magnet.clone());
        }
    }
    eprintln!(
        "[deep-link] queued magnet prefix: {}",
        magnet.chars().take(96).collect::<String>()
    );
    let _ = app.emit("magnet-link", magnet);
}

fn store_pending_torrent_file(app: &AppHandle, path: String) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut guard) = state.initial_torrent_file.lock() {
            *guard = Some(path.clone());
        }
    }
    eprintln!("[deep-link] queued torrent file: {path}");
    let _ = app.emit("torrent-file-link", path);
}

fn parse_env_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let (k, v) = trimmed.split_once('=')?;
    let key = k.trim();
    if key.is_empty() {
        return None;
    }
    let mut value = v.trim().to_string();
    if (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
    {
        value = value[1..value.len().saturating_sub(1)].to_string();
    }
    Some((key.to_string(), value))
}

fn load_env_file_if_exists(path: &str) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    for line in content.lines() {
        if let Some((key, value)) = parse_env_line(line) {
            if env::var(&key).is_err() {
                env::set_var(key, value);
            }
        }
    }
}

fn load_env_files() {
    // Try common dev locations so TMDB_* works whether tauri runs from repo root or src-tauri.
    load_env_file_if_exists(".env");
    load_env_file_if_exists("../.env");
    load_env_file_if_exists("src-tauri/.env");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(magnet) = extract_magnet_arg(&argv) {
                store_pending_magnet(app, magnet);
            }
            if let Some(path) = extract_torrent_arg(&argv) {
                store_pending_torrent_file(app, path);
            }
        }))
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(drop) = event {
                if let tauri::DragDropEvent::Drop { paths, .. } = drop {
                    for path in paths {
                        let p = path.to_string_lossy().to_string();
                        if normalize_torrent_path_candidate(&p).is_some() {
                            store_pending_torrent_file(&webview.app_handle(), p);
                        }
                    }
                }
            }
        })
        .setup(|app| {
            load_env_files();
            let args: Vec<String> = std::env::args().collect();
            if let Some(magnet) = extract_magnet_arg(&args) {
                store_pending_magnet(&app.handle().clone(), magnet);
            }
            if let Some(path) = extract_torrent_arg(&args) {
                store_pending_torrent_file(&app.handle().clone(), path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parse_magnet,
            parse_release_name,
            upload_magnet,
            upload_torrent_file,
            upload_torrent_bytes,
            list_torrents,
            get_free_space,
            move_torrents,
            torrent_action,
            get_history,
            clear_history,
            delete_history_entry,
            fetch_tmdb_metadata,
            open_external,
            take_initial_magnet,
            take_initial_torrent_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Some(magnet) = normalize_magnet_candidate(url.as_ref()) {
                    store_pending_magnet(app_handle, magnet);
                }
                if let Some(path) = normalize_torrent_path_candidate(url.as_ref()) {
                    store_pending_torrent_file(app_handle, path);
                }
            }
        }
    });
}
