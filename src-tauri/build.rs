use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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

fn read_env_file(path: &Path, out: &mut HashMap<String, String>) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    for line in content.lines() {
        if let Some((k, v)) = parse_env_line(line) {
            out.insert(k, v);
        }
    }
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let env_paths = [
        manifest_dir.join(".env"),
        manifest_dir.join("../.env"),
        manifest_dir.join("src-tauri/.env"),
    ];

    for p in &env_paths {
        println!("cargo:rerun-if-changed={}", p.display());
    }
    println!("cargo:rerun-if-env-changed=TMDB_API_KEY");
    println!("cargo:rerun-if-env-changed=TMDB_ACCESS_TOKEN");

    let mut vals = HashMap::new();
    for p in &env_paths {
        read_env_file(p, &mut vals);
    }

    if let Ok(v) = std::env::var("TMDB_API_KEY") {
        vals.insert("TMDB_API_KEY".to_string(), v);
    }
    if let Ok(v) = std::env::var("TMDB_ACCESS_TOKEN") {
        vals.insert("TMDB_ACCESS_TOKEN".to_string(), v);
    }

    if let Some(v) = vals.get("TMDB_API_KEY").map(String::as_str) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            println!("cargo:rustc-env=TMDB_API_KEY={trimmed}");
        }
    }
    if let Some(v) = vals.get("TMDB_ACCESS_TOKEN").map(String::as_str) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            println!("cargo:rustc-env=TMDB_ACCESS_TOKEN={trimmed}");
        }
    }

    tauri_build::build();
}
