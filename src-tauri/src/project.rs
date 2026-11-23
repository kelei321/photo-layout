use image::{
    codecs::jpeg::JpegEncoder, metadata::Orientation, DynamicImage, ImageDecoder, ImageFormat,
    ImageReader, Limits,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, BufReader, Cursor, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tempfile::{NamedTempFile, TempDir};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const MAX_PHOTOS: usize = 500;
const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_PIXELS: u64 = 80_000_000;
const MAX_MANIFEST: u64 = 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 20_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub columns: u32,
    #[serde(default)]
    pub fixed_rows: Option<u32>,
    pub gap: u32,
    #[serde(default)]
    pub corner_radius: u32,
    pub tile_px: u32,
    pub tile_mm: f64,
    pub print_gap_mm: f64,
    pub zip_px: u32,
    pub format: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub id: String,
    pub asset: Asset,
    pub crop: Crop,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub photos: Vec<Photo>,
    pub settings: Settings,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPhoto {
    id: String,
    name: String,
    crop: Crop,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: u32,
    photos: Vec<SavedPhoto>,
    settings: Settings,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub assets: Vec<Asset>,
    pub issues: Vec<String>,
    pub issue_count: usize,
}

impl Imported {
    fn issue(&mut self, name: &str, error: impl std::fmt::Display) {
        self.issue_count += 1;
        if self.issues.len() < 30 {
            self.issues.push(format!("{name}：{error}"));
        }
    }
}

pub struct Store {
    directory: TempDir,
    assets: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Store {
    pub fn new() -> Result<Self> {
        Ok(Self {
            directory: tempfile::Builder::new().prefix("photolayout-").tempdir()?,
            assets: Mutex::new(HashMap::new()),
        })
    }

    fn path(&self, id: &str, extension: &str) -> PathBuf {
        self.directory.path().join(format!("{id}.{extension}"))
    }

    fn add(&self, name: String, bytes: &[u8]) -> Result<Asset> {
        let image = decode(Cursor::new(bytes))?;
        let preview = encode_preview(&image)?;
        self.register(name, bytes, (image.width(), image.height()), Some(&preview))
    }

    fn restore(&self, name: String, bytes: &[u8]) -> Result<Asset> {
        let mut decoder = photo_decoder(Cursor::new(bytes))?;
        let (width, height) = decoder.dimensions();
        let dimensions = match decoder.orientation()? {
            Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH => (height, width),
            _ => (width, height),
        };
        self.register(name, bytes, dimensions, None)
    }

    fn register(
        &self,
        name: String,
        bytes: &[u8],
        (width, height): (u32, u32),
        preview: Option<&[u8]>,
    ) -> Result<Asset> {
        let id = Uuid::new_v4().to_string();
        let original = self.path(&id, "original");
        let thumbnail = self.path(&id, "jpg");
        let written = (|| -> Result<()> {
            fs::write(&original, bytes)?;
            if let Some(preview) = preview {
                fs::write(&thumbnail, preview)?;
            }
            Ok(())
        })();
        if let Err(error) = written {
            let _ = fs::remove_file(original);
            let _ = fs::remove_file(thumbnail);
            return Err(error);
        }
        self.assets
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::new(Mutex::new(())));
        Ok(Asset {
            id,
            name,
            width,
            height,
        })
    }

    pub fn original(&self, id: &str) -> Result<PathBuf> {
        self.asset_lock(id)?;
        Ok(self.path(id, "original"))
    }

    fn asset_lock(&self, id: &str) -> Result<Arc<Mutex<()>>> {
        self.assets
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "找不到照片原图".into())
    }

    pub fn preview(&self, id: &str) -> Result<Vec<u8>> {
        let lock = self.asset_lock(id)?;
        let _guard = lock.lock().unwrap();
        let path = self.path(id, "jpg");
        match fs::read(&path) {
            Ok(bytes) => return Ok(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let image = decode(BufReader::new(File::open(self.original(id)?)?))?;
        let preview = encode_preview(&image)?;
        if let Err(error) = fs::write(&path, &preview) {
            let _ = fs::remove_file(path);
            return Err(error.into());
        }
        Ok(preview)
    }

    pub fn release(&self, ids: &[String]) {
        let to_release: Vec<_> = {
            let mut assets = self.assets.lock().unwrap();
            ids.iter()
                .filter_map(|id| assets.remove(id).map(|lock| (id, lock)))
                .collect()
        };
        for (id, lock) in to_release {
            let _guard = lock.lock().unwrap();
            let _ = fs::remove_file(self.path(id, "original"));
            let _ = fs::remove_file(self.path(id, "jpg"));
        }
    }

    pub fn clear(&self) {
        let _ = fs::remove_dir_all(self.directory.path());
    }

    pub fn import<F: Fn(&str, Option<(usize, usize)>)>(
        &self,
        mut files: Vec<PathBuf>,
        capacity: usize,
        progress: F,
    ) -> Imported {
        files.sort_by_cached_key(|path| natural_key(&file_name(path)));
        let mut imported = Imported::default();
        let capacity = capacity.min(MAX_PHOTOS);
        let total = files.len();
        for (index, path) in files.into_iter().enumerate() {
            let name = file_name(&path);
            progress(&name, Some((index + 1, total)));
            if imported.assets.len() >= capacity {
                imported.issue(&name, "已达到项目照片数量上限");
                continue;
            }
            let result = match extension(&path).as_str() {
                "zip" => self.import_zip(&path, capacity, &mut imported, &progress),
                _ if is_photo(&path) => read_limited(
                    File::open(&path).map_err(|error| format!("无法读取文件：{error}").into()),
                )
                .and_then(|bytes| self.add(name.clone(), &bytes))
                .map(|asset| imported.assets.push(asset)),
                _ => Err("仅支持 JPG、PNG、WebP 和 ZIP".into()),
            };
            if let Err(error) = result {
                imported.issue(&name, error);
            }
        }
        imported
    }

    fn import_zip<F: Fn(&str, Option<(usize, usize)>)>(
        &self,
        path: &Path,
        capacity: usize,
        imported: &mut Imported,
        progress: F,
    ) -> Result<()> {
        let mut zip = ZipArchive::new(BufReader::new(File::open(path)?))?;
        if zip.len() > MAX_ZIP_ENTRIES {
            return Err("ZIP 内的文件数量过多".into());
        }
        let mut entries = Vec::new();
        for index in 0..zip.len() {
            let entry = match zip.by_index_raw(index) {
                Ok(entry) => entry,
                Err(error) => {
                    imported.issue(&format!("ZIP 条目 {}", index + 1), error);
                    continue;
                }
            };
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_owned();
            let normalized_name = name.replace('\\', "/");
            if normalized_name
                .split('/')
                .any(|part| part == "__MACOSX" || part.starts_with("._"))
            {
                continue;
            }
            if is_photo(Path::new(&normalized_name)) {
                entries.push((normalized_name, index));
            }
        }
        if entries.is_empty() {
            return Err("ZIP 内没有支持的照片".into());
        }
        entries.sort_by_cached_key(|(name, _)| natural_key(name));
        let total = entries.len();
        for (position, (name, index)) in entries.into_iter().enumerate() {
            progress(&name, Some((position + 1, total)));
            if imported.assets.len() >= capacity {
                imported.issue(&name, "已达到项目照片数量上限");
                continue;
            }
            let result = (|| -> Result<Asset> {
                let entry = zip.by_index(index)?;
                if entry.enclosed_name().is_none() || entry.is_symlink() {
                    return Err("ZIP 条目路径或类型无效".into());
                }
                if entry.size() > MAX_FILE {
                    return Err("单张照片超过 64 MB".into());
                }
                let bytes = read_limited(Ok(entry))?;
                self.add(file_name(Path::new(&name)), &bytes)
            })();
            match result {
                Ok(asset) => imported.assets.push(asset),
                Err(error) => imported.issue(&name, error),
            }
        }
        Ok(())
    }

    pub fn save<F: Fn(usize, usize)>(
        &self,
        path: &Path,
        project: Project,
        progress: F,
    ) -> Result<()> {
        validate_settings(&project.settings)?;
        let saved: Vec<_> = project
            .photos
            .iter()
            .map(|photo| SavedPhoto {
                id: photo.id.clone(),
                name: photo.asset.name.clone(),
                crop: photo.crop.clone(),
            })
            .collect();
        validate_photos(&saved)?;
        let manifest = Manifest {
            version: 1,
            photos: saved,
            settings: project.settings,
        };
        atomic_write(path, |file| {
            let mut zip = ZipWriter::new(file);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            zip.start_file("project.json", options)?;
            serde_json::to_writer(&mut zip, &manifest)?;
            let total = project.photos.len();
            for (index, photo) in project.photos.into_iter().enumerate() {
                progress(index + 1, total);
                let path = self.original(&photo.asset.id)?;
                zip.start_file(archive_asset(index), options)?;
                io::copy(&mut File::open(path)?, &mut zip)?;
            }
            zip.finish()?;
            Ok(())
        })
    }

    pub fn open<F: Fn(usize, usize)>(&self, path: &Path, progress: F) -> Result<Project> {
        let mut zip = ZipArchive::new(BufReader::new(File::open(path)?))?;
        if zip.len() > MAX_PHOTOS + 1 {
            return Err("项目文件条目过多".into());
        }
        let manifest: Manifest = {
            let entry = zip.by_name("project.json")?;
            let mut bytes = Vec::new();
            entry.take(MAX_MANIFEST + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_MANIFEST {
                return Err("项目清单过大".into());
            }
            let version = serde_json::from_slice::<serde_json::Value>(&bytes)?
                .get("version")
                .and_then(serde_json::Value::as_u64);
            if version != Some(1) {
                return Err("项目版本不受支持".into());
            }
            serde_json::from_slice(&bytes)?
        };
        validate_settings(&manifest.settings)?;
        validate_photos(&manifest.photos)?;
        if zip.len() != manifest.photos.len() + 1 {
            return Err("项目原图数量与清单不符".into());
        }
        let mut photos = Vec::with_capacity(manifest.photos.len());
        let result = (|| -> Result<()> {
            let total = manifest.photos.len();
            for (index, photo) in manifest.photos.into_iter().enumerate() {
                progress(index + 1, total);
                let entry = zip.by_name(&archive_asset(index))?;
                if entry.size() > MAX_FILE || entry.is_dir() || entry.is_symlink() {
                    return Err("项目原图无效或过大".into());
                }
                let bytes = read_limited(Ok(entry))?;
                let asset = self
                    .restore(photo.name, &bytes)
                    .map_err(|error| format!("项目中的第 {} 张照片无法读取：{error}", index + 1))?;
                photos.push(Photo {
                    id: photo.id,
                    asset,
                    crop: photo.crop,
                });
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.release(
                &photos
                    .into_iter()
                    .map(|photo| photo.asset.id)
                    .collect::<Vec<_>>(),
            );
            return Err(error);
        }
        Ok(Project {
            photos,
            settings: manifest.settings,
        })
    }
}

fn archive_asset(index: usize) -> String {
    format!("photos/{:03}", index + 1)
}

fn validate_photos(photos: &[SavedPhoto]) -> Result<()> {
    if photos.len() > MAX_PHOTOS {
        return Err("项目照片超过 500 张".into());
    }
    let mut ids = HashSet::new();
    for photo in photos {
        if Uuid::parse_str(&photo.id).is_err()
            || !ids.insert(&photo.id)
            || photo.name.is_empty()
            || photo.name.len() > 4096
            || !(0.0..=1.0).contains(&photo.crop.x)
            || !(0.0..=1.0).contains(&photo.crop.y)
            || !(1.0..=8.0).contains(&photo.crop.zoom)
        {
            return Err("项目包含无效的照片信息或裁切设置".into());
        }
    }
    Ok(())
}

fn validate_settings(settings: &Settings) -> Result<()> {
    if !(1..=100).contains(&settings.columns)
        || settings.fixed_rows.is_some_and(|rows| {
            rows == 0 || u64::from(rows) * u64::from(settings.columns) > MAX_PHOTOS as u64
        })
        || settings.gap > 1000
        || settings.corner_radius > 50
        || !(32..=4096).contains(&settings.tile_px)
        || !(32..=4096).contains(&settings.zip_px)
        || !(1.0..=500.0).contains(&settings.tile_mm)
        || !(0.0..=100.0).contains(&settings.print_gap_mm)
        || !matches!(settings.format.as_str(), "jpg" | "png" | "pdf" | "zip")
    {
        return Err("项目包含超出范围的排版或导出设置".into());
    }
    Ok(())
}

fn read_limited(reader: Result<impl Read>) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader?.take(MAX_FILE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("单张照片超过 64 MB".into());
    }
    Ok(bytes)
}

fn photo_decoder<'a>(reader: impl io::BufRead + io::Seek + 'a) -> Result<impl ImageDecoder + 'a> {
    let mut reader = ImageReader::new(reader).with_guessed_format()?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP)
    ) {
        return Err("文件内容不是 JPG、PNG 或 WebP 图片".into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(32_768);
    limits.max_image_height = Some(32_768);
    limits.max_alloc = Some(768 * 1024 * 1024);
    reader.limits(limits);
    let decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("照片超过 8000 万像素".into());
    }
    Ok(decoder)
}

pub fn decode(reader: impl io::BufRead + io::Seek) -> Result<DynamicImage> {
    let mut decoder = photo_decoder(reader)?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn encode_preview(image: &DynamicImage) -> Result<Vec<u8>> {
    let rgba = image.thumbnail(480, 480).into_rgba8();
    let rgb = image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        on_white(rgba.get_pixel(x, y).0)
    });
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 87).encode_image(&rgb)?;
    Ok(bytes)
}

pub fn on_white([red, green, blue, alpha]: [u8; 4]) -> image::Rgb<u8> {
    let alpha = u32::from(alpha);
    let flatten = |color| ((u32::from(color) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
    image::Rgb([flatten(red), flatten(green), flatten(blue)])
}

pub fn atomic_write(path: &Path, write: impl FnOnce(&mut File) -> Result<()>) -> Result<()> {
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or("找不到输出目录")?;
    let mut temporary = NamedTempFile::new_in(directory)?;
    write(temporary.as_file_mut())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

fn extension(path: &Path) -> String {
    path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase()
}

fn is_photo(path: &Path) -> bool {
    matches!(extension(path).as_str(), "jpg" | "jpeg" | "png" | "webp")
}

#[derive(Eq, Ord, PartialEq, PartialOrd)]
enum Part {
    Text(String),
    Number(usize, String, usize),
}

fn natural_key(name: &str) -> (Vec<Part>, String) {
    let lower = name.to_lowercase();
    let parts = lower.split_inclusive(|character: char| !character.is_ascii_digit());
    let mut key = Vec::new();
    let mut text = String::new();
    for part in parts {
        let digits = part.trim_end_matches(|character: char| !character.is_ascii_digit());
        if !digits.is_empty() {
            if !text.is_empty() {
                key.push(Part::Text(std::mem::take(&mut text)));
            }
            let significant = digits.trim_start_matches('0');
            key.push(Part::Number(
                significant.len(),
                significant.into(),
                digits.len(),
            ));
        }
        text.push_str(&part[digits.len()..]);
    }
    if !text.is_empty() {
        key.push(Part::Text(text));
    }
    (key, name.to_owned())
}
