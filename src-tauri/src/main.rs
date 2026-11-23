#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod project;
mod render;
#[cfg(test)]
mod tests;

use project::{Imported, Project, Store};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{async_runtime::spawn_blocking, ipc::Response, AppHandle, Emitter, State};

type CommandResult<T> = Result<T, String>;

#[derive(Clone, Serialize)]
struct Progress {
    label: String,
    current: usize,
    total: usize,
}

#[derive(Serialize)]
struct Opened {
    path: PathBuf,
    project: Project,
}

fn progress(app: &AppHandle, label: impl Into<String>, current: usize, total: usize) {
    let _ = app.emit(
        "operation-progress",
        Progress {
            label: label.into(),
            current,
            total,
        },
    );
}

fn filename(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

fn picker(label: &str, extensions: &[&str]) -> rfd::FileDialog {
    rfd::FileDialog::new()
        .set_title(label)
        .add_filter(label, extensions)
}

async fn work<T: Send + 'static>(
    action: impl FnOnce() -> project::Result<T> + Send + 'static,
) -> CommandResult<T> {
    spawn_blocking(action)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn import_photos(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    paths: Option<Vec<PathBuf>>,
    capacity: usize,
    replacement: bool,
) -> CommandResult<Option<Imported>> {
    let store = Arc::clone(&store);
    work(move || {
        let selected = if replacement {
            picker("选择替换照片", &["jpg", "jpeg", "png", "webp"])
                .pick_file()
                .map(|path| vec![path])
        } else {
            paths.or_else(|| {
                picker("导入照片或 ZIP", &["jpg", "jpeg", "png", "webp", "zip"]).pick_files()
            })
        };
        Ok(selected.map(|paths| {
            store.import(paths, capacity, |name, position| {
                let (current, total) = position.unwrap_or_default();
                progress(&app, format!("正在导入 {name}"), current, total);
            })
        }))
    })
    .await
}

#[tauri::command]
async fn photo_preview(store: State<'_, Arc<Store>>, id: String) -> CommandResult<Response> {
    let store = Arc::clone(&store);
    work(move || store.preview(&id).map(Response::new)).await
}

#[tauri::command]
async fn release_photos(store: State<'_, Arc<Store>>, ids: Vec<String>) -> CommandResult<()> {
    let store = Arc::clone(&store);
    work(move || {
        store.release(&ids);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn open_project(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> CommandResult<Option<Opened>> {
    let store = Arc::clone(&store);
    work(move || {
        let Some(path) = picker("打开排版项目", &["photolayout"]).pick_file() else {
            return Ok(None);
        };
        let project = store.open(&path, |current, total| {
            progress(&app, "正在打开项目", current, total)
        })?;
        Ok(Some(Opened { path, project }))
    })
    .await
}

#[tauri::command]
async fn save_project(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    path: Option<PathBuf>,
    project: Project,
) -> CommandResult<Option<PathBuf>> {
    let store = Arc::clone(&store);
    work(move || {
        let selected = path.or_else(|| {
            picker("保存排版项目", &["photolayout"])
                .set_file_name("照片排版.photolayout")
                .save_file()
                .map(|path| with_extension(path, "photolayout"))
        });
        let Some(path) = selected else {
            return Ok(None);
        };
        store.save(&path, project, |current, total| {
            progress(&app, "正在保存项目", current, total)
        })?;
        Ok(Some(path))
    })
    .await
}

fn with_extension(mut path: PathBuf, wanted: &str) -> PathBuf {
    if path
        .extension()
        .is_none_or(|extension| !extension.to_string_lossy().eq_ignore_ascii_case(wanted))
    {
        let extended = format!("{}.{}", filename(&path), wanted);
        path.set_file_name(extended);
    }
    path
}

#[tauri::command]
async fn export_photos(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    job: render::Job,
) -> CommandResult<Option<PathBuf>> {
    let store = Arc::clone(&store);
    work(move || {
        let format = job.format.as_str();
        if !matches!(format, "jpg" | "png" | "pdf" | "zip") {
            return Err("不支持的导出格式".into());
        }
        let name = if format == "zip" {
            "编号小图"
        } else {
            "照片排版"
        };
        let selected = picker("导出照片", &[format])
            .set_file_name(format!("{name}.{format}"))
            .save_file();
        let Some(path) = selected.map(|path| with_extension(path, format)) else {
            return Ok(None);
        };
        render::export(&store, &path, job, |current, total| {
            progress(&app, "正在处理照片", current, total)
        })?;
        Ok(Some(path))
    })
    .await
}

fn main() {
    let store = match Store::new() {
        Ok(store) => store,
        Err(error) => {
            rfd::MessageDialog::new()
                .set_title("照片排版")
                .set_description(format!("无法创建照片临时目录：{error}"))
                .show();
            return;
        }
    };
    let store = Arc::new(store);
    match tauri::Builder::default()
        .manage(Arc::clone(&store))
        .invoke_handler(tauri::generate_handler![
            import_photos,
            photo_preview,
            release_photos,
            open_project,
            save_project,
            export_photos,
        ])
        .build(tauri::generate_context!())
    {
        Ok(app) => app.run(move |_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                store.clear();
            }
        }),
        Err(error) => {
            rfd::MessageDialog::new()
                .set_title("照片排版")
                .set_description(format!(
                    "无法启动窗口，请确认已安装 Microsoft Edge WebView2 Runtime。\n{error}"
                ))
                .show();
        }
    }
}
