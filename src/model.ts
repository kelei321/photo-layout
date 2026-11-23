export type Format = 'jpg' | 'png' | 'pdf' | 'zip'
export type Crop = { x: number; y: number; zoom: number }
export type Asset = { id: string; name: string; width: number; height: number }
export type Photo = { id: string; asset: Asset; crop: Crop }
export type Settings = {
  columns: number
  fixedRows: number | null
  gap: number
  cornerRadius: number
  tilePx: number
  tileMm: number
  printGapMm: number
  zipPx: number
  format: Format
}
export type Project = { photos: Photo[]; settings: Settings }
export type Rect = { x: number; y: number; width: number; height: number }
export type Job = {
  format: Format
  width: number
  height: number
  page: { widthMm: number; heightMm: number } | null
  cornerRadius: number
  tiles: { assetId: string; source: Rect; destination: Rect }[]
}

export const MAX_PHOTOS = 500
export const DEFAULT_CROP: Crop = { x: 0.5, y: 0.5, zoom: 1 }
export const DEFAULT_SETTINGS: Settings = {
  columns: 10, fixedRows: null, gap: 12, cornerRadius: 0, tilePx: 600, tileMm: 20, printGapMm: 1, zipPx: 600, format: 'jpg',
}
export const FORMATS = [
  { id: 'jpg', label: 'JPG', detail: '高质量整版图片' },
  { id: 'png', label: 'PNG', detail: '无损整版图片' },
  { id: 'pdf', label: 'PDF', detail: '300 DPI 单页打印' },
  { id: 'zip', label: 'ZIP', detail: '按顺序编号的独立小图' },
] as const

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
export const photoNumber = (index: number) => String(index + 1).padStart(3, '0')

export function constrainCrop(asset: Asset, crop: Crop): Crop {
  const zoom = clamp(crop.zoom, 1, 8)
  const side = Math.max(1, Math.round(Math.min(asset.width, asset.height) / zoom))
  const horizontal = side / (2 * asset.width)
  const vertical = side / (2 * asset.height)
  return { zoom, x: clamp(crop.x, horizontal, 1 - horizontal), y: clamp(crop.y, vertical, 1 - vertical) }
}

export function cropRect(asset: Asset, crop: Crop): Rect {
  const { x, y, zoom } = constrainCrop(asset, crop)
  const side = Math.max(1, Math.round(Math.min(asset.width, asset.height) / zoom))
  return {
    x: clamp(Math.round(x * asset.width - side / 2), 0, asset.width - side),
    y: clamp(Math.round(y * asset.height - side / 2), 0, asset.height - side),
    width: side,
    height: side,
  }
}

export function movePhoto(photos: Photo[], from: number, to: number): Photo[] {
  if (from < 0 || to < 0 || from >= photos.length || to >= photos.length || from === to) return photos
  const next = photos.slice()
  const [photo] = next.splice(from, 1)
  next.splice(to, 0, photo)
  return next
}

export function sortIndexAt(x: number, y: number, width: number, gap: number, columns: number, count: number) {
  const tile = (width - gap * (columns - 1)) / columns
  const step = tile + gap
  const rows = Math.ceil(count / columns)
  if (tile <= 0 || !count || x < 0 || x >= width || y < 0 || y >= step * rows - gap) return -1
  const column = Math.min(columns - 1, Math.floor((x + gap / 2) / step))
  const row = Math.min(rows - 1, Math.floor((y + gap / 2) / step))
  return Math.min(count - 1, row * columns + column)
}

export function previewTileStyle(rect: Rect, size: Pick<Job, 'width' | 'height'>) {
  return {
    left: `${rect.x / size.width * 100}%`,
    top: `${rect.y / size.height * 100}%`,
    width: `${rect.width / size.width * 100}%`,
    height: `${rect.height / size.height * 100}%`,
  }
}

export function previewGridSize(viewport: { width: number; height: number }, columns: number, rows: number, gapRatio: number, zoom: number) {
  const widthUnits = columns + (columns - 1) * gapRatio
  const heightUnits = rows + Math.max(0, rows - 1) * gapRatio
  const fittedTile = Math.min(viewport.width / widthUnits, heightUnits ? viewport.height / heightUnits : 0)
  const tile = Math.floor(fittedTile * (zoom / 100) * 64) / 64
  const gap = Math.floor(tile * gapRatio * 64) / 64
  return { tile, gap, width: columns * tile + (columns - 1) * gap }
}

export function replacePhoto(photos: Photo[], id: string, asset: Asset): Photo[] {
  return photos.map(photo => photo.id === id ? { id, asset, crop: DEFAULT_CROP } : photo)
}

export function fixedCapacity(settings: Settings) {
  return settings.fixedRows == null ? null : settings.columns * settings.fixedRows
}

export function exportCountAllowed(count: number, settings: Settings) {
  const capacity = fixedCapacity(settings)
  return count > 0 && (settings.format === 'zip' || capacity === null || count === capacity)
}

export function exportDimensions(count: number, settings: Settings): Pick<Job, 'width' | 'height' | 'page'> {
  if (settings.format === 'zip') return { width: settings.zipPx, height: settings.zipPx, page: null }
  const columns = settings.columns
  const rows = settings.fixedRows ?? Math.ceil(count / columns)
  if (settings.format === 'pdf') {
    const widthMm = columns * settings.tileMm + (columns - 1) * settings.printGapMm
    const heightMm = rows * settings.tileMm + Math.max(0, rows - 1) * settings.printGapMm
    return {
      width: Math.round(widthMm * 300 / 25.4),
      height: Math.round(heightMm * 300 / 25.4),
      page: { widthMm, heightMm },
    }
  }
  return {
    width: columns * settings.tilePx + (columns - 1) * settings.gap,
    height: rows * settings.tilePx + Math.max(0, rows - 1) * settings.gap,
    page: null,
  }
}

export function exportSizeAllowed(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 16_384 && height <= 16_384 && width * height <= 64_000_000
}

export function makeExportJob(photos: Photo[], settings: Settings): Job {
  if (!exportCountAllowed(photos.length, settings)) throw new Error('照片数量不符合导出要求')
  const { width, height, page } = exportDimensions(photos.length, settings)
  const tileSize = page ? settings.tileMm : settings.tilePx
  const gap = page ? settings.printGapMm : settings.gap
  const factor = page ? 300 / 25.4 : 1
  return {
    format: settings.format, width, height, page, cornerRadius: settings.cornerRadius,
    tiles: photos.map((photo, index) => {
      const column = index % settings.columns
      const row = Math.floor(index / settings.columns)
      const left = column * (tileSize + gap)
      const top = row * (tileSize + gap)
      const x = Math.round(left * factor)
      const y = Math.round(top * factor)
      return {
        assetId: photo.asset.id,
        source: cropRect(photo.asset, photo.crop),
        destination: settings.format === 'zip'
          ? { x: 0, y: 0, width, height }
          : { x, y, width: Math.round((left + tileSize) * factor) - x, height: Math.round((top + tileSize) * factor) - y },
      }
    }),
  }
}
