use crate::{
    project::{atomic_write, decode, Crop, Photo, Project, Settings, Store},
    render::{export, Job},
};
use image::{GenericImageView, ImageFormat, Rgb, RgbImage};
use serde_json::json;
use std::{
    fs::{self, File},
    io::{Cursor, Read, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

fn fixture(index: usize, format: ImageFormat) -> Vec<u8> {
    let image = RgbImage::from_fn(100, 60, |x, y| {
        Rgb([
            index as u8,
            if x < 50 { 40 } else { 210 },
            if y < 30 { 50 } else { 190 },
        ])
    });
    let mut output = Cursor::new(Vec::new());
    image.write_to(&mut output, format).unwrap();
    output.into_inner()
}

fn rotated_jpg(index: usize) -> Vec<u8> {
    let mut jpeg = fixture(index, ImageFormat::Jpeg);
    let exif = b"\xff\xe1\x00\x22Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    jpeg.splice(2..2, exif.iter().copied());
    jpeg
}

fn settings() -> Settings {
    Settings {
        columns: 10,
        fixed_rows: None,
        gap: 4,
        corner_radius: 0,
        tile_px: 32,
        tile_mm: 20.0,
        print_gap_mm: 1.0,
        zip_px: 48,
        format: "pdf".into(),
    }
}

fn make_project(folder: &Path, store: &Store) -> Project {
    let path = folder.join("batch.zip");
    let mut zip = ZipWriter::new(File::create(&path).unwrap());
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for index in (1..=100).rev() {
        let (suffix, bytes) = match index % 3 {
            0 => ("webp", fixture(index, ImageFormat::WebP)),
            1 => ("jpg", rotated_jpg(index)),
            _ => ("png", fixture(index, ImageFormat::Png)),
        };
        zip.start_file(format!("album/photo{index}.{suffix}"), options)
            .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.start_file("album/photo101.jpg", options).unwrap();
    zip.write_all(b"invalid image").unwrap();
    zip.start_file("../unsafe.jpg", options).unwrap();
    zip.write_all(&fixture(101, ImageFormat::Jpeg)).unwrap();
    zip.start_file("__MACOSX/._preview.jpg", options).unwrap();
    zip.write_all(b"AppleDouble").unwrap();
    zip.finish().unwrap();
    let imported = store.import(vec![path.clone()], 500, |_, _| {});
    assert_eq!(imported.assets.len(), 100);
    assert_eq!(imported.issue_count, 2);
    assert_eq!(imported.assets[9].name, "photo10.jpg");
    assert_eq!(
        (imported.assets[0].width, imported.assets[0].height),
        (60, 100)
    );
    assert_eq!(
        (imported.assets[1].width, imported.assets[1].height),
        (100, 60)
    );
    let preview = decode(Cursor::new(store.preview(&imported.assets[0].id).unwrap())).unwrap();
    assert_eq!((preview.width(), preview.height()), (288, 480));
    fs::remove_file(path).unwrap();
    let photos = imported
        .assets
        .into_iter()
        .map(|asset| Photo {
            id: uuid::Uuid::new_v4().to_string(),
            asset,
            crop: Crop {
                x: 0.5,
                y: 0.5,
                zoom: 1.0,
            },
        })
        .collect();
    Project {
        photos,
        settings: settings(),
    }
}

#[test]
fn mixed_import_and_self_contained_project_round_trip() {
    let folder = tempfile::tempdir().unwrap();
    let store = Store::new().unwrap();
    let mut project = make_project(folder.path(), &store);
    project.settings.columns = 5;
    project.settings.fixed_rows = Some(20);
    project.settings.corner_radius = 18;
    project.photos.swap(0, 60);
    project.photos[60].crop = Crop {
        x: 0.7,
        y: 0.25,
        zoom: 3.0,
    };
    let ids: Vec<_> = project
        .photos
        .iter()
        .map(|photo| photo.id.clone())
        .collect();
    let path = folder.path().join("saved.photolayout");
    store.save(&path, project, |_, _| {}).unwrap();
    drop(store);
    let moved = folder.path().join("moved.photolayout");
    fs::rename(path, &moved).unwrap();
    let store = Store::new().unwrap();
    let restored = store.open(&moved, |_, _| {}).unwrap();
    assert_eq!(
        ids,
        restored
            .photos
            .iter()
            .map(|photo| photo.id.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(restored.settings.columns, 5);
    assert_eq!(restored.settings.fixed_rows, Some(20));
    assert_eq!(restored.settings.corner_radius, 18);
    assert_eq!(restored.photos[60].asset.name, "photo1.jpg");
    assert_eq!(restored.photos[60].crop.zoom, 3.0);
    assert_eq!(restored.photos[60].crop.y, 0.25);
    let restored_asset = &restored.photos[60].asset;
    let thumbnail = store
        .original(&restored_asset.id)
        .unwrap()
        .with_extension("jpg");
    assert!(!thumbnail.exists());
    let preview = store.preview(&restored_asset.id).unwrap();
    assert!(thumbnail.exists());
    assert_eq!(store.preview(&restored_asset.id).unwrap(), preview);
    let preview = decode(Cursor::new(preview)).unwrap();
    assert_eq!((restored_asset.width, restored_asset.height), (60, 100));
    assert_eq!((preview.width(), preview.height()), (288, 480));
    assert_eq!(
        fs::read(store.original(&restored.photos[60].asset.id).unwrap()).unwrap(),
        rotated_jpg(1)
    );
}

#[test]
fn legacy_project_settings_default_to_square_corners() {
    let mut legacy = serde_json::to_value(settings()).unwrap();
    legacy.as_object_mut().unwrap().remove("cornerRadius");
    legacy.as_object_mut().unwrap().remove("fixedRows");
    let restored: Settings = serde_json::from_value(legacy).unwrap();
    assert_eq!(restored.corner_radius, 0);
    assert_eq!(restored.fixed_rows, None);
}

#[test]
fn render_all_formats_with_white_gaps_and_numbered_tiles() {
    let folder = tempfile::tempdir().unwrap();
    let store = Store::new().unwrap();
    let project = make_project(folder.path(), &store);
    for format in ["jpg", "png", "pdf", "zip"] {
        let (count, width, height) = match format {
            "zip" => (100, 48, 48),
            "pdf" => (100, 2469, 2469),
            _ => (11, 356, 68),
        };
        let tiles: Vec<_> = project.photos[..count].iter().enumerate().map(|(index, photo)| {
            let column = (index % 10) as u32;
            let row = (index / 10) as u32;
            let (x, y, w, h) = match format {
                "zip" => (0, 0, 48, 48),
                "pdf" => {
                    let pixel = |mm: u32| (f64::from(mm) * 300.0 / 25.4).round() as u32;
                    let x = pixel(column * 21);
                    let y = pixel(row * 21);
                    (x, y, pixel(column * 21 + 20) - x, pixel(row * 21 + 20) - y)
                }
                _ => (column * 36, row * 36, 32, 32),
            };
            json!({
                "assetId": photo.asset.id,
                "source": { "x": (photo.asset.width-40)/2, "y": (photo.asset.height-40)/2, "width": 40, "height": 40 },
                "destination": { "x": x, "y": y, "width": w, "height": h }
            })
        }).collect();
        let job: Job = serde_json::from_value(json!({
            "format": format, "width": width, "height": height, "tiles": tiles, "cornerRadius": 50,
            "page": if format == "pdf" { json!({ "widthMm": 209.0, "heightMm": 209.0 }) } else { json!(null) },
        })).unwrap();
        let path = folder.path().join(format!("export.{format}"));
        export(&store, &path, job, |_, _| {}).unwrap();
        match format {
            "zip" => {
                let mut zip = ZipArchive::new(File::open(&path).unwrap()).unwrap();
                assert_eq!(zip.len(), 100);
                for index in [0, 60, 99] {
                    let mut entry = zip.by_index(index).unwrap();
                    assert_eq!(entry.name(), format!("{:03}.jpg", index + 1));
                    let mut bytes = Vec::new();
                    entry.read_to_end(&mut bytes).unwrap();
                    let tile = decode(Cursor::new(bytes)).unwrap();
                    assert_eq!((tile.width(), tile.height()), (48, 48));
                    assert!(tile.get_pixel(0, 0).0[..3]
                        .iter()
                        .all(|&channel| channel >= 247));
                    assert!(tile.get_pixel(24, 24).0[0] < 200);
                }
            }
            "pdf" => {
                let bytes = fs::read(&path).unwrap();
                let pdf = String::from_utf8_lossy(&bytes);
                assert!(pdf.starts_with("%PDF-1.4"));
                assert!(pdf.contains("/MediaBox [0 0 592.440945 592.440945]"));
                assert!(pdf.contains("/Width 2469 /Height 2469"));
                let xref = pdf
                    .rsplit_once("startxref\n")
                    .unwrap()
                    .1
                    .lines()
                    .next()
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                assert_eq!(&bytes[xref..xref + 4], b"xref");
                let image_start = bytes
                    .windows(4)
                    .position(|chunk| chunk == b"\xff\xd8\xff\xe0")
                    .unwrap();
                let image_end = bytes[image_start..]
                    .windows(2)
                    .position(|chunk| chunk == b"\xff\xd9")
                    .unwrap()
                    + image_start
                    + 2;
                let embedded = decode(Cursor::new(&bytes[image_start..image_end])).unwrap();
                assert!(embedded.get_pixel(0, 0).0[..3]
                    .iter()
                    .all(|&channel| channel >= 247));
            }
            _ => {
                let image = image::open(&path).unwrap().to_rgb8();
                assert_eq!(image.dimensions(), (width, height));
                assert_eq!(image.get_pixel(350, 60).0, [255; 3]);
                assert_ne!(image.get_pixel(10, 10).0, [255; 3]);
                if format == "png" {
                    assert_eq!(image.get_pixel(33, 10).0, [255; 3]);
                }
                assert!(image
                    .get_pixel(0, 0)
                    .0
                    .iter()
                    .all(|&channel| channel >= 247));
            }
        }
    }
}

#[test]
fn cancelled_or_failed_write_keeps_the_previous_file() {
    let folder = tempfile::tempdir().unwrap();
    let target = folder.path().join("project.photolayout");
    fs::write(&target, b"old project").unwrap();
    let failure = atomic_write(&target, |file| {
        file.write_all(b"incomplete bytes")?;
        Err("simulated write failure".into())
    });
    assert!(failure.is_err());
    assert_eq!(fs::read(&target).unwrap(), b"old project");
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    assert!(atomic_write(&folder.path().join("missing").join("file"), |_| Ok(())).is_err());
    atomic_write(&target, |file| {
        file.write_all(b"new project")?;
        Ok(())
    })
    .unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new project");
}
