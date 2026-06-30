#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, File},
    io::Write,
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const HOST: &str = "127.0.0.1";
const PORT: &str = "4173";

struct ServiceProcess(Mutex<Option<Child>>);

fn repo_root_for_dev() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must live inside the repository")
        .to_path_buf()
}

fn has_server(root: &PathBuf) -> bool {
    root.join("dist").join("server.js").exists() && root.join("public").join("index.html").exists()
}

fn app_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if cfg!(debug_assertions) {
        candidates.push(repo_root_for_dev());
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("_up_"));
        candidates.push(resource_dir);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("_up_"));
            candidates.push(exe_dir.to_path_buf());
        }
    }

    candidates.into_iter().find(has_server).ok_or_else(|| {
        "Cannot find bundled dist/server.js and public/index.html resources".to_string()
    })
}

fn log_line(data_dir: &PathBuf, message: &str) {
    let _ = fs::create_dir_all(data_dir);
    let log_path = data_dir.join("desktop.log");
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = writeln!(file, "{message}");
    }
}

fn state_migration_candidates(root: &PathBuf) -> Vec<PathBuf> {
    let mut candidates = vec![root.join("data")];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("data"));
            candidates.push(exe_dir.join("agency").join("data"));
        }
    }

    candidates
}

fn migrate_existing_local_state(root: &PathBuf, data_dir: &PathBuf) {
    let state_file = data_dir.join("state.local.json");
    if state_file.exists() {
        return;
    }

    for candidate in state_migration_candidates(root) {
        let source_state = candidate.join("state.local.json");
        if !source_state.exists() {
            continue;
        }

        let _ = fs::create_dir_all(data_dir);
        if fs::copy(&source_state, &state_file).is_ok() {
            let source_secret = candidate.join("auth.secret.local");
            let target_secret = data_dir.join("auth.secret.local");
            if source_secret.exists() && !target_secret.exists() {
                let _ = fs::copy(source_secret, target_secret);
            }
            log_line(
                data_dir,
                &format!("migrated state from {}", source_state.display()),
            );
        }
        break;
    }
}
fn local_secret(data_dir: &PathBuf) -> Result<String, String> {
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let secret_path = data_dir.join("auth.secret.local");
    if let Ok(secret) = fs::read_to_string(&secret_path) {
        let trimmed = secret.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let secret = format!("agency-local-{now}-{}", std::process::id());
    fs::write(&secret_path, &secret).map_err(|error| error.to_string())?;
    Ok(secret)
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

fn port_is_ready() -> bool {
    TcpStream::connect((HOST, PORT.parse::<u16>().unwrap_or(4173))).is_ok()
}

fn start_local_service(app: &tauri::AppHandle) -> Result<(), String> {
    let root = app_root(app)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;

    log_line(&data_dir, &format!("app root: {}", root.display()));
    log_line(&data_dir, &format!("data dir: {}", data_dir.display()));
    migrate_existing_local_state(&root, &data_dir);

    if port_is_ready() {
        log_line(
            &data_dir,
            "port 4173 is already responding; reusing existing local service",
        );
        return Ok(());
    }

    let stdout =
        File::create(data_dir.join("server.stdout.log")).map_err(|error| error.to_string())?;
    let stderr =
        File::create(data_dir.join("server.stderr.log")).map_err(|error| error.to_string())?;
    let secret = local_secret(&data_dir)?;
    let state_file = data_dir.join("state.local.json");

    let child = Command::new("node")
        .arg("dist/server.js")
        .current_dir(&root)
        .env("AGENCY_AUTH_SECRET", secret)
        .env("AGENCY_HOST", HOST)
        .env("PORT", PORT)
        .env("AGENCY_DESKTOP_MODE", "true")
        .env("AGENCY_STATE_FILE", &state_file)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("Failed to start Node local service: {error}"))?;

    log_line(&data_dir, &format!("started node pid {}", child.id()));
    app.state::<ServiceProcess>()
        .0
        .lock()
        .map_err(|_| "service process lock poisoned".to_string())?
        .replace(child);

    wait_until_ready()
}

fn main() {
    tauri::Builder::default()
        .manage(ServiceProcess(Mutex::new(None)))
        .setup(|app| {
            start_local_service(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Agency Workforce OS desktop app");
}
