use crate::project::{atomic_write, decode, on_white, Result, Store, MAX_PHOTOS};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    imageops::{resize, FilterType},
    ExtendedColorType, GenericImageView, ImageEncoder, Rgb, RgbImage,
};
use serde::Deserialize;
use std::{
    fs::File,
    io::{BufReader, Seek, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipWriter};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl Rect {
    fn fits(&self, width: u32, height: u32) -> bool {
        self.width > 0
            && self.height > 0
            && self
                .x
                .checked_add(self.width)
                .is_some_and(|right| right <= width)
            && self
                .y
                .checked_add(self.height)
                .is_some_and(|bottom| bottom <= height)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    asset_id: String,
    source: Rect,
    destination: Rect,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    width_mm: f64,
    height_mm: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub format: String,
    width: u32,
    height: u32,
    page: Option<Page>,
    #[serde(default)]
    corner_radius: u32,
    tiles: Vec<Tile>,
}

pub fn export(
    store: &Store,
    file: &Path,
    job: Job,
    progress: impl Fn(usize, usize) + Copy,
) -> Result<()> {
    validate(&job)?;
    if job.format == "zip" {
        return write_zip(store, file, &job, progress);
    }
    let mut canvas = RgbImage::from_pixel(job.width, job.height, Rgb([255; 3]));
    let total = job.tiles.len();
    for (index, tile) in job.tiles.iter().enumerate() {
        progress(index + 1, total);
        draw(store, &mut canvas, tile, job.corner_radius)?;
    }
    atomic_write(file, |file| {
        match job.format.as_str() {
            "png" => PngEncoder::new(file).write_image(
                canvas.as_raw(),
                job.width,
                job.height,
                ExtendedColorType::Rgb8,
            )?,
            "jpg" => encode_jpeg(file, &canvas)?,
            "pdf" => {
                let mut jpeg = Vec::new();
                encode_jpeg(&mut jpeg, &canvas)?;
                let page = job.page.as_ref().ok_or("缺少 PDF 页面尺寸")?;
                write_pdf(file, &jpeg, job.width, job.height, page)?;
            }
            _ => return Err("不支持的导出格式".into()),
        }
        Ok(())
    })
}

fn validate(job: &Job) -> Result<()> {
    if job.width == 0
        || job.height == 0
        || job.width > 16_384
        || job.height > 16_384
        || u64::from(job.width) * u64::from(job.height) > 64_000_000
        || job.tiles.is_empty()
        || job.tiles.len() > MAX_PHOTOS
    {
        return Err("导出尺寸或照片数量超出范围".into());
    }
    if !matches!(job.format.as_str(), "jpg" | "png" | "pdf" | "zip") {
        return Err("不支持的导出格式".into());
    }
    if job.corner_radius > 50 {
        return Err("照片圆角必须在 0% 到 50% 之间".into());
    }
    if job.format == "pdf" {
        let page = job.page.as_ref().ok_or("缺少 PDF 页面尺寸")?;
        if !page.width_mm.is_finite()
            || !page.height_mm.is_finite()
            || page.width_mm <= 0.0
            || page.height_mm <= 0.0
            || (page.width_mm * 300.0 / 25.4).round() != f64::from(job.width)
            || (page.height_mm * 300.0 / 25.4).round() != f64::from(job.height)
        {
            return Err("PDF 页面尺寸与 300 DPI 栅格尺寸不一致".into());
        }
    }
    for tile in &job.tiles {
        if tile.source.width != tile.source.height || !tile.destination.fits(job.width, job.height)
        {
            return Err("照片裁切或排版坐标无效".into());
        }
        if job.format == "zip"
            && (tile.destination.x != 0
                || tile.destination.y != 0
                || tile.destination.width != job.width
                || tile.destination.height != job.height
                || job.width != job.height
                || job.width > 4096)
        {
            return Err("编号小图尺寸无效".into());
        }
    }
    Ok(())
}

fn draw(store: &Store, canvas: &mut RgbImage, tile: &Tile, corner_radius: u32) -> Result<()> {
    let image = decode(BufReader::new(File::open(store.original(&tile.asset_id)?)?))?;
    let source = &tile.source;
    if !source.fits(image.width(), image.height()) {
        return Err("裁切范围超出照片边缘".into());
    }
    let destination = &tile.destination;
    let cropped = image.view(source.x, source.y, source.width, source.height);
    let image = resize(
        &*cropped,
        destination.width,
        destination.height,
        FilterType::Lanczos3,
    );
    let ratio = f64::from(corner_radius) / 100.0;
    let radius_x = f64::from(destination.width) * ratio;
    let radius_y = f64::from(destination.height) * ratio;
    for (x, y, rgba) in image.enumerate_pixels() {
        let mut pixel = rgba.0;
        if corner_radius > 0 {
            let dx = radius_x - (f64::from(x.min(destination.width - 1 - x)) + 0.5);
            let dy = radius_y - (f64::from(y.min(destination.height - 1 - y)) + 0.5);
            if dx > 0.0 && dy > 0.0 {
                let distance = (dx / radius_x).hypot(dy / radius_y);
                let coverage = ((1.0 - distance) * radius_x.min(radius_y) + 0.5).clamp(0.0, 1.0);
                pixel[3] = (f64::from(pixel[3]) * coverage).round() as u8;
            }
        }
        canvas.put_pixel(x + destination.x, y + destination.y, on_white(pixel));
    }
    Ok(())
}

fn encode_jpeg(writer: impl Write, image: &RgbImage) -> Result<()> {
    JpegEncoder::new_with_quality(writer, 95).encode(
        image.as_raw(),
        image.width(),
        image.height(),
        ExtendedColorType::Rgb8,
    )?;
    Ok(())
}

fn write_zip(store: &Store, file: &Path, job: &Job, progress: impl Fn(usize, usize)) -> Result<()> {
    atomic_write(file, |file| {
        let mut zip = ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let mut canvas = RgbImage::new(job.width, job.height);
        let total = job.tiles.len();
        for (index, tile) in job.tiles.iter().enumerate() {
            progress(index + 1, total);
            draw(store, &mut canvas, tile, job.corner_radius)?;
            zip.start_file(format!("{:03}.jpg", index + 1), options)?;
            encode_jpeg(&mut zip, &canvas)?;
        }
        zip.finish()?;
        Ok(())
    })
}

fn write_pdf(file: &mut File, jpeg: &[u8], width: u32, height: u32, page: &Page) -> Result<()> {
    let width_pt = page.width_mm * 72.0 / 25.4;
    let height_pt = page.height_mm * 72.0 / 25.4;
    let drawing = format!("q\n{width_pt:.6} 0 0 {height_pt:.6} 0 0 cm\n/PhotoGrid Do\nQ\n");
    file.write_all(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")?;
    let mut offsets = Vec::new();
    let objects = [
        ("<< /Type /Catalog /Pages 2 0 R >>".to_owned(), None),
        ("<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(), None),
        (format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width_pt:.6} {height_pt:.6}] /Resources << /XObject << /PhotoGrid 4 0 R >> >> /Contents 5 0 R >>"), None),
        (format!("<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>", jpeg.len()), Some(jpeg)),
        (format!("<< /Length {} >>", drawing.len()), Some(drawing.as_bytes())),
    ];
    for (index, (dictionary, stream)) in objects.iter().enumerate() {
        offsets.push(file.stream_position()?);
        writeln!(file, "{} 0 obj\n{dictionary}", index + 1)?;
        if let Some(stream) = stream {
            file.write_all(b"stream\n")?;
            file.write_all(stream)?;
            file.write_all(b"\nendstream\n")?;
        }
        file.write_all(b"endobj\n")?;
    }
    let xref = file.stream_position()?;
    let count = offsets.len() + 1;
    writeln!(file, "xref\n0 {count}\n0000000000 65535 f ")?;
    for offset in offsets {
        writeln!(file, "{offset:010} 00000 n ")?;
    }
    writeln!(
        file,
        "trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
    )?;
    Ok(())
}
