#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    net::TcpStream,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

const HOST: &str = "127.0.0.1";
const PORT: &str = "4173";

fn repo_root_for_dev() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must live inside the repository")
        .to_path_buf()
}

fn app_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(repo_root_for_dev())
    } else {
        app.path().resource_dir().map_err(|error| error.to_string())
    }
}

fn wait_until_ready() -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        if TcpStream::connect((HOST, PORT.parse::<u16>().unwrap_or(4173))).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(300));
    }
    Err("Local workstation service did not become ready on 127.0.0.1:4173".to_string())
}

fn start_local_service(app: &tauri::AppHandle) -> Result<(), String> {
    let root = app_root(app)?;
    let script = root.join("desktop").join("start-workstation.ps1");
    if !script.exists() {
        return Err(format!("Desktop launcher script not found: {}", script.display()));
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;

    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script.to_string_lossy().as_ref(),
            "-NoBrowser",
            "-DataDir",
            data_dir.to_string_lossy().as_ref(),
        ])
        .current_dir(&root)
        .env("PORT", PORT)
        .env("AGENCY_HOST", HOST)
        .env("AGENCY_DATA_DIR", &data_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Failed to start PowerShell launcher: {error}"))?;

    if !status.success() {
        return Err(format!("PowerShell launcher exited with status {status}"));
    }

    wait_until_ready()
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            start_local_service(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Agency Workforce OS desktop app");
}