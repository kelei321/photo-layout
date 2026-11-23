import { useLayoutEffect, useRef, useState } from 'react'
import { FORMATS, photoNumber, previewTileStyle, type Job, type Photo } from './model'
import PhotoView from './PhotoView'

export type Preview = { photos: Photo[]; job: Job }

export default function ExportPreview({ preview, onCancel, onExport }: {
  preview: Preview; onCancel: () => void; onExport: () => void;
}) {
  const { photos, job } = preview
  const [zoomed, setZoomed] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const format = FORMATS.find(format => format.id === job.format)!
  const isZip = job.format === 'zip'
  const borderRadius = `${job.cornerRadius}%`
  const aspect = job.width / job.height
  const paperWidth = zoomed
    ? `max(min(200%, ${104 * aspect}dvh), min(100%, ${job.width}px))`
    : `min(100%, ${52 * aspect}dvh)`
  const pixels = `${job.width.toLocaleString('zh-CN')} × ${job.height.toLocaleString('zh-CN')} px`
  const details = job.page
    ? `${Number(job.page.widthMm.toFixed(2))} × ${Number(job.page.heightMm.toFixed(2))} mm · 300 DPI · ${pixels}`
    : isZip ? `${photos.length} 张 JPG · 每张 ${pixels}` : pixels

  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  return <dialog ref={dialog} className="export-preview" aria-labelledby="preview-title"
    onCancel={event => { event.preventDefault(); onCancel() }}>
    <header className="preview-header">
      <div><h2 id="preview-title">导出预览 · {format.label}</h2><p>{details}</p></div>
      {!isZip && <button type="button" aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}>
        {zoomed ? '查看整版' : '放大预览'}
      </button>}
    </header>
    <div className="preview-scroll" tabIndex={0} aria-label={isZip ? '编号小图预览' : '整版照片预览'}>
      {isZip ? <div className="zip-preview">
        {job.tiles.map((tile, index) => <figure key={photos[index].id}>
          <div style={{ borderRadius }}><PhotoView photo={photos[index]} source={tile.source} /></div>
          <figcaption>{photoNumber(index)}.jpg</figcaption>
        </figure>)}
      </div> : <div className="preview-paper" role="img" aria-label={`${photos.length} 张照片的 ${format.label} 排版`}
        style={{
          aspectRatio: `${job.width} / ${job.height}`,
          width: paperWidth,
        }}>
        {job.tiles.map((tile, index) => <div key={photos[index].id} className="preview-tile" style={{ ...previewTileStyle(tile.destination, job), borderRadius }}>
          <PhotoView photo={photos[index]} source={tile.source} />
        </div>)}
      </div>}
    </div>
    <footer className="preview-footer dialog-actions">
      <button type="button" onClick={onCancel} autoFocus>返回编辑</button>
      <button type="button" onClick={onExport} className="primary">确认导出 {format.label}</button>
    </footer>
  </dialog>
}
