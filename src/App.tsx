import { useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  clamp, constrainCrop, cropRect, DEFAULT_CROP, DEFAULT_SETTINGS, exportCountAllowed, exportDimensions, exportSizeAllowed,
  fixedCapacity, FORMATS, makeExportJob, MAX_PHOTOS, movePhoto, photoNumber, previewGridSize, replacePhoto,
  type Crop, type Format, type Photo, type Project, type Settings,
} from './model'
import { native, type Imported, type Progress } from './native'
import PhotoView from './PhotoView'
import ExportPreview, { type Preview } from './ExportPreview'
import { usePhotoSort } from './usePhotoSort'
import { createHistory, historyAssets, projectHistory } from './projectHistory'
import CropReference from './CropReference'
import PhotoMenu, { type MenuAnchor } from './PhotoMenu'
import SidePanel from './SidePanel'
import { usePanelLayout } from './usePanelLayout'

type Notice = { text: string; kind: 'success' | 'warning' | 'error'; details?: string[] }
type Confirm = { label: string; run: () => void }
type CropGesture = { startX: number; startY: number; crop: Crop; scale: number }
const PRESETS = [{ columns: 10, rows: 10 }, { columns: 5, rows: 20 }, { columns: 20, rows: 5 }]
const ZOOM_LEVELS = [50, 75, 100, 125, 150, 200, 300, 400, 600, 800]
const appWindow = getCurrentWindow()
const emptyProject: Project = { photos: [], settings: DEFAULT_SETTINGS }

function fileName(path: string) {
  return path.split(/[\\/]/).at(-1) ?? path
}

function numberText(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function NumberField({ label, value, min, max, unit, step = 1, onChange }: {
  label: string; value: number; min: number; max: number; unit: string; step?: number; onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return <label className="field">
    <span>{label}</span>
    <span className="field-control">
      <input type="number" min={min} max={max} step={step} value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => {
          const entered = draft.trim() ? Number(draft) : value
          const valid = Number.isFinite(entered) ? clamp(entered, min, max) : value
          const next = step === 1 ? Math.round(valid) : Math.round(valid * 100) / 100
          setDraft(String(next))
          onChange(next)
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(String(value))
        }} />
      <span aria-hidden="true">{unit}</span>
    </span>
  </label>
}

export default function App() {
  const panels = usePanelLayout()
  const [history, dispatchHistory] = useReducer(projectHistory, emptyProject, createHistory)
  const project = history.present.project
  const { photos, settings } = project
  const dirty = project !== history.saved
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [batchSelection, setBatchSelection] = useState<Set<string> | null>(null)
  const [photoMenu, setPhotoMenu] = useState<(MenuAnchor & { id: string }) | null>(null)
  const [cropAssist, setCropAssist] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [viewport, setViewport] = useState({ width: 600, height: 460 })
  const [zoom, setZoom] = useState(100)
  const [moveTo, setMoveTo] = useState('')
  const busy = useRef(false)
  const board = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const moveInput = useRef<HTMLInputElement>(null)
  const cropPreview = useRef<HTMLDivElement>(null)
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null)
  const batchAnchor = useRef<string | null>(null)
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const cropGesture = useRef<CropGesture | null>(null)
  const sliderGesture = useRef<object | null>(null)
  const retainedAssets = useRef(new Set<string>())
  const latest = useRef({ close: () => {}, drop: (_paths: string[]) => {}, shortcut: (_event: globalThis.KeyboardEvent) => {} })

  const selectedIndex = photos.findIndex(photo => photo.id === selectedId)
  const selected = photos[selectedIndex]
  const menuIndex = photoMenu ? photos.findIndex(photo => photo.id === photoMenu.id) : -1
  const menuPhoto = photos[menuIndex]
  const capacity = fixedCapacity(settings)
  const difference = capacity === null ? 0 : photos.length - capacity
  const countMessage = difference < 0 ? `还差 ${-difference} 张`
    : difference > 0 ? `多了 ${difference} 张，请移除多余照片` : '张数已满足'
  const rows = Math.max(settings.fixedRows ?? 0, Math.ceil(photos.length / settings.columns))
  const dimensions = exportDimensions(photos.length, settings)
  const sizeAllowed = exportSizeAllowed(dimensions.width, dimensions.height)
  const exportable = exportCountAllowed(photos.length, settings) && sizeAllowed
  const displayGap = (settings.format === 'pdf' ? settings.printGapMm / settings.tileMm : settings.gap / settings.tilePx)
  const formatInfo = FORMATS.find(format => format.id === settings.format)!
  const { tile, gap, width } = previewGridSize(viewport, settings.columns, rows, displayGap, zoom)
  const batchActive = batchSelection !== null
  const batchCount = batchSelection?.size ?? 0
  const sort = usePhotoSort(photos, { columns: settings.columns, gap, width }, !!progress || batchActive, { select: setSelectedId, commit: move })
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom)
  const zoomDisabled = !photos.length || !!sort.drag || !!progress
  const corner = `${settings.cornerRadius}%`
  const historyDisabled = !!progress || !!sort.drag

  useEffect(() => {
    const assets = historyAssets(history)
    const released = [...retainedAssets.current].filter(id => !assets.has(id))
    retainedAssets.current = assets
    if (released.length) void native.release(released).catch(console.error)
  }, [history])

  useEffect(() => {
    const element = stage.current
    if (!element) return
    const observer = new ResizeObserver(([{ contentRect }]) => setViewport({
      width: contentRect.width, height: contentRect.height,
    }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    const pane = stage.current
    const grid = sort.gridRef.current
    if (!pane || !grid) return
    zoomAnchor.current = null
    if (!anchor || zoom <= 100) {
      if (zoom <= 100) pane.scrollTo(0, 0)
      return
    }
    const bounds = grid.getBoundingClientRect()
    const view = pane.getBoundingClientRect()
    pane.scrollLeft += bounds.left + bounds.width * anchor.x - view.left - pane.clientWidth / 2
    pane.scrollTop += bounds.top + bounds.height * anchor.y - view.top - pane.clientHeight / 2
  }, [zoom, sort.gridRef])

  function changeZoom(next: number) {
    const pane = stage.current
    const bounds = sort.gridRef.current?.getBoundingClientRect()
    if (zoomDisabled || !pane || !bounds || zoom === next) return
    const view = pane.getBoundingClientRect()
    zoomAnchor.current = {
      x: clamp((view.left + pane.clientWidth / 2 - bounds.left) / bounds.width, 0, 1),
      y: clamp((view.top + pane.clientHeight / 2 - bounds.top) / bounds.height, 0, 1),
    }
    setZoom(next)
  }

  useEffect(() => {
    setMoveTo(selectedIndex >= 0 ? String(selectedIndex + 1) : '')
  }, [selectedId, selectedIndex])

  useEffect(() => {
    const dialog = confirmDialog.current
    if (confirm && !dialog?.open) dialog?.showModal()
    else if (!confirm && dialog?.open) dialog.close()
  }, [confirm])

  useEffect(() => {
    const handles = [
      listen<Progress>('operation-progress', event => {
        if (busy.current) setProgress(event.payload)
      }),
      appWindow.onDragDropEvent(({ payload }) => {
        if (payload.type === 'enter') setDropActive(!busy.current)
        else if (payload.type === 'leave') setDropActive(false)
        else if (payload.type === 'drop') {
          setDropActive(false)
          latest.current.drop(payload.paths)
        }
      }),
      appWindow.onCloseRequested(event => {
        event.preventDefault()
        latest.current.close()
      }),
    ]
    const keyboard = (event: globalThis.KeyboardEvent) => latest.current.shortcut(event)
    const suppressBrowserMenu = (event: globalThis.MouseEvent) => event.preventDefault()
    window.addEventListener('keydown', keyboard)
    window.addEventListener('contextmenu', suppressBrowserMenu)
    return () => {
      handles.forEach(handle => void handle.then(unlisten => unlisten()).catch(console.error))
      window.removeEventListener('keydown', keyboard)
      window.removeEventListener('contextmenu', suppressBrowserMenu)
    }
  }, [])

  async function task<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    if (busy.current) return undefined
    busy.current = true
    setNotice(null)
    setProgress({ label, current: 0, total: 0 })
    try {
      return await work()
    } catch (error) {
      setNotice({ kind: 'error', text: `${label}失败`, details: [String(error)] })
      return undefined
    } finally {
      busy.current = false
      setProgress(null)
    }
  }

  function editProject(changes: Partial<Project>, selection = selectedId, group?: object) {
    dispatchHistory({ type: 'edit', project: { ...project, ...changes }, before: selectedId, after: selection, group })
    if (selection !== selectedId) setSelectedId(selection)
  }

  function restoreHistory(direction: 'undo' | 'redo') {
    if (historyDisabled || busy.current || cropGesture.current || sliderGesture.current) return
    const entry = (direction === 'undo' ? history.past : history.future).at(-1)
    if (!entry) return
    dispatchHistory({ type: direction, selection: selectedId })
    setSelectedId(entry.selection)
    endBatchSelection()
    setNotice(null)
    if (!entry.project.photos.length) setZoom(100)
  }

  function updateSetting<Key extends keyof Settings>(key: Key, value: Settings[Key]) {
    if (settings[key] === value) return
    editProject({ settings: { ...settings, [key]: value } })
  }

  function changeLayout(columns: number, fixedRows: number | null) {
    if (settings.columns === columns && settings.fixedRows === fixedRows) return
    editProject({ settings: { ...settings, columns, fixedRows } })
  }

  function importNotice(result: Imported, verb: string) {
    if (result.issueCount) {
      const extra = result.issueCount - result.issues.length
      const details = extra ? [...result.issues, `另有 ${extra} 项未显示`] : result.issues
      setNotice({ kind: 'warning', text: `${verb} ${result.assets.length} 张，跳过 ${result.issueCount} 项`, details })
    } else if (result.assets.length) {
      setNotice({ kind: 'success', text: `已${verb} ${result.assets.length} 张照片` })
    }
  }

  async function importPhotos(paths: string[] | null = null) {
    if (photos.length >= MAX_PHOTOS) {
      setNotice({ kind: 'warning', text: `每个项目最多导入 ${MAX_PHOTOS} 张照片` })
      return
    }
    const result = await task('导入照片', () => native.import(MAX_PHOTOS - photos.length, paths))
    if (!result) return
    const added = result.assets.map(asset => ({ id: crypto.randomUUID(), asset, crop: DEFAULT_CROP }))
    if (added.length) {
      editProject({ photos: [...photos, ...added] }, selectedId ?? added[0].id)
    }
    importNotice(result, '导入')
  }

  async function replacePhotoInProject(photo: Photo) {
    const result = await task('替换照片', () => native.import(1, null, true))
    if (!result) return
    const [asset] = result.assets
    if (asset) {
      editProject({ photos: replacePhoto(photos, photo.id, asset) }, photo.id)
    }
    importNotice(result, '替换')
  }

  function openPhotoMenu(trigger: HTMLButtonElement, id: string, coordinates?: { x: number; y: number }) {
    if (busy.current || sort.drag || preview || confirm) return
    const bounds = trigger.getBoundingClientRect()
    setPhotoMenu({
      id, trigger, x: coordinates?.x ?? bounds.left + bounds.width / 2,
      y: coordinates?.y ?? bounds.bottom,
    })
  }

  function focusPhotoEditor(id: string, move = false) {
    setSelectedId(id)
    panels.expand('right')
    requestAnimationFrame(() => {
      if (move) {
        moveInput.current?.focus()
        moveInput.current?.select()
      } else {
        cropPreview.current?.focus()
      }
    })
  }

  function endBatchSelection() {
    setBatchSelection(null)
    batchAnchor.current = null
  }

  function selectPhoto(photo: Photo, index: number, extend: boolean) {
    if (!batchSelection) {
      sort.click(photo.id)
      return
    }
    const next = new Set(batchSelection)
    const anchor = extend ? photos.findIndex(item => item.id === batchAnchor.current) : -1
    if (anchor >= 0) {
      for (const item of photos.slice(Math.min(anchor, index), Math.max(anchor, index) + 1)) next.add(item.id)
    } else {
      if (next.has(photo.id)) next.delete(photo.id)
      else next.add(photo.id)
      batchAnchor.current = photo.id
    }
    setBatchSelection(next)
  }

  function removePhotos(ids: Set<string>) {
    if (!ids.size || busy.current || sort.drag) return
    const removed = photos.filter(photo => ids.has(photo.id))
    if (!removed.length) return
    const remaining = photos.filter(photo => !ids.has(photo.id))
    let nextSelection = selectedId
    if (!selectedId || ids.has(selectedId)) {
      const nextIndex = photos.slice(0, Math.max(0, selectedIndex)).filter(photo => !ids.has(photo.id)).length
      nextSelection = (remaining[nextIndex] ?? remaining.at(-1))?.id ?? null
    }
    editProject({ photos: remaining }, nextSelection)
    setNotice({ kind: 'success', text: removed.length === 1 ? `已移除 ${removed[0].asset.name}` : `已移除 ${removed.length} 张照片` })
    endBatchSelection()
    if (!remaining.length) setZoom(100)
  }

  async function saveProject() {
    const path = await task('保存项目', () => native.save(projectPath, project))
    if (!path) return false
    setProjectPath(path)
    dispatchHistory({ type: 'saved', project })
    setNotice({ kind: 'success', text: `已保存 ${fileName(path)}` })
    return true
  }

  function loadProject(project: Project, path: string | null) {
    dispatchHistory({ type: 'load', project })
    setPhotoMenu(null)
    endBatchSelection()
    setSelectedId(project.photos[0]?.id ?? null)
    setProjectPath(path)
    setZoom(100)
    stage.current?.scrollTo(0, 0)
    setNotice(null)
  }

  function askBefore(label: string, run: () => void) {
    if (busy.current || confirm) return
    if (dirty) setConfirm({ label, run })
    else run()
  }

  function openProject() {
    askBefore('打开项目', () => {
      void task('打开项目', native.open).then(opened => {
        if (!opened) return
        loadProject(opened.project, opened.path)
        setNotice({ kind: 'success', text: `已打开 ${fileName(opened.path)}` })
      })
    })
  }

  function closeWindow() {
    if (preview) {
      setPreview(null)
      return
    }
    sort.cancel()
    if (busy.current) {
      setNotice({ kind: 'warning', text: '请等待当前操作完成后再关闭' })
      return
    }
    askBefore('关闭窗口', () => {
      void appWindow.destroy().catch(error => setNotice({ kind: 'error', text: '无法关闭窗口', details: [String(error)] }))
    })
  }

  latest.current = {
    close: closeWindow,
    drop: paths => { if (!confirm && !preview && !sort.drag && !busy.current) void importPhotos(paths) },
    shortcut: event => {
      if (batchActive && !confirm && !preview && event.key === 'Escape') {
        event.preventDefault()
        endBatchSelection()
        return
      }
      if (sort.drag && event.key === 'Escape') {
        event.preventDefault()
        sort.cancel()
        return
      }
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      const key = event.key.toLowerCase()
      if (photoMenu && ['z', 'y', 's', 'o', 'i', 'p'].includes(key)) setPhotoMenu(null)
      if (key === 'z' || key === 'y') {
        if (event.target instanceof HTMLElement && event.target.closest('input:not([type=range]), textarea, [contenteditable=true]')) return
        event.preventDefault()
        if (!confirm && !preview) restoreHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo')
        return
      }
      if (key === 's' || key === 'o' || key === 'i' || key === 'p') {
        event.preventDefault()
        if (confirm || preview || sort.drag) return
        if (key === 's') void saveProject()
        else if (key === 'o') openProject()
        else if (key === 'p') showExportPreview('pdf')
        else if (!busy.current) void importPhotos()
      }
    },
  }

  function showExportPreview(format: Format = settings.format) {
    if (busy.current || !photos.length) return
    const output = { ...settings, format }
    if (!exportCountAllowed(photos.length, output)) {
      setNotice({ kind: 'warning', text: countMessage })
      return
    }
    const { width, height } = exportDimensions(photos.length, output)
    if (!exportSizeAllowed(width, height)) {
      setNotice({ kind: 'warning', text: '成品尺寸过大，请减小小图、间距或调整列数。' })
      return
    }
    setPreview({ photos, job: makeExportJob(photos, output) })
  }

  async function confirmExport() {
    if (!preview) return
    setPreview(null)
    updateSetting('format', preview.job.format)
    const path = await task('导出照片', () => native.export(preview.job))
    if (path) setNotice({ kind: 'success', text: `已导出 ${fileName(path)}` })
  }

  function move(from: number, to: number) {
    const next = movePhoto(photos, from, to)
    if (next === photos) return
    editProject({ photos: next })
  }

  function moveSelected(event: FormEvent) {
    event.preventDefault()
    if (selectedIndex < 0) return
    const target = clamp(Math.trunc(Number(moveTo) || selectedIndex + 1), 1, photos.length) - 1
    move(selectedIndex, target)
    setMoveTo(String(target + 1))
    if (target !== selectedIndex) {
      requestAnimationFrame(() => board.current?.querySelector(`[data-photo-id="${selected.id}"]`)
        ?.scrollIntoView({ block: 'nearest' }))
    }
  }

  function changeCrop(crop: Crop, group?: object) {
    if (!selected || busy.current || batchActive) return
    const next = constrainCrop(selected.asset, crop)
    if (next.x === selected.crop.x && next.y === selected.crop.y && next.zoom === selected.crop.zoom) return
    editProject({ photos: photos.map(photo => photo.id === selected.id ? { ...photo, crop: next } : photo) }, selectedId, group)
  }

  function cropStart(event: PointerEvent<HTMLDivElement>) {
    if (!selected || event.button !== 0 || busy.current || batchActive) return
    event.currentTarget.setPointerCapture(event.pointerId)
    cropGesture.current = {
      startX: event.clientX, startY: event.clientY, crop: selected.crop,
      scale: cropRect(selected.asset, selected.crop).width / event.currentTarget.clientWidth,
    }
  }

  function cropMove(event: PointerEvent<HTMLDivElement>) {
    const gesture = cropGesture.current
    if (!gesture || !selected) return
    changeCrop({
      ...gesture.crop,
      x: gesture.crop.x - (event.clientX - gesture.startX) * gesture.scale / selected.asset.width,
      y: gesture.crop.y - (event.clientY - gesture.startY) * gesture.scale / selected.asset.height,
    }, gesture)
  }

  function cropKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!selected || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 0.05 : 0.01
    const x = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0
    const y = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
    changeCrop({ ...selected.crop, x: selected.crop.x + x, y: selected.crop.y + y })
  }

  return <div className="app">
    <header className="app-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
        <div><h1>照片排版</h1><p title={projectPath ?? undefined}>{projectPath ? fileName(projectPath) : '未命名项目'}{dirty && ' · 未保存'}</p></div>
      </div>
      <nav aria-label="项目操作">
        <div className="history-actions" role="group" aria-label="编辑历史">
          <button type="button" title="Ctrl+Z" disabled={historyDisabled || !history.past.length} onClick={() => restoreHistory('undo')}><span aria-hidden="true">↶</span> 撤销</button>
          <button type="button" title="Ctrl+Y" disabled={historyDisabled || !history.future.length} onClick={() => restoreHistory('redo')}><span aria-hidden="true">↷</span> 重做</button>
        </div>
        <div className="project-actions" role="group" aria-label="项目文件">
          <button type="button" disabled={!!progress} onClick={() => askBefore('新建项目', () => loadProject({ photos: [], settings: DEFAULT_SETTINGS }, null))}>新建</button>
          <button type="button" disabled={!!progress} onClick={openProject}>打开项目</button>
          <button type="button" disabled={!!progress} onClick={() => void saveProject()}>保存项目</button>
        </div>
        <button className="primary import-button" type="button" disabled={!!progress} onClick={() => void importPhotos()}><span aria-hidden="true">＋</span> 导入照片</button>
      </nav>
    </header>

    <main ref={panels.container} className="workbench" style={{ gridTemplateColumns: `${panels.widths.left}px minmax(0, 1fr) ${panels.widths.right}px` }}>
      <SidePanel side="left" title="布局与导出" controls={panels.controls('left')}>
        <div className="sidebar-card">
          <fieldset disabled={!!progress}>
            <legend>排版</legend>
            <div className="preset-grid" aria-label="排版预设">
              {PRESETS.map(({ columns, rows }) => <button type="button" key={columns}
                aria-pressed={settings.columns === columns && settings.fixedRows === rows} onClick={() => changeLayout(columns, rows)}>
                {columns} × {rows}
              </button>)}
            </div>
            <div className="fields">
              <button type="button" className="auto-rows" aria-pressed={capacity === null} onClick={() => changeLayout(settings.columns, null)}>自动行数</button>
              <NumberField label="列数" unit="列" min={1} max={100} value={settings.columns}
                onChange={value => { if (value !== settings.columns) changeLayout(value, null) }} />
              {settings.format === 'pdf'
                ? <NumberField key="print-gap" label="打印间距" unit="mm" min={0} max={100} step={0.1} value={settings.printGapMm} onChange={value => updateSetting('printGapMm', value)} />
                : <NumberField key="pixel-gap" label="照片间距" unit="px" min={0} max={1000} value={settings.gap} onChange={value => updateSetting('gap', value)} />}
              <NumberField label="照片圆角" unit="%" min={0} max={50} value={settings.cornerRadius} onChange={value => updateSetting('cornerRadius', value)} />
            </div>
          </fieldset>
        </div>
        <div className="sidebar-card">
          <fieldset disabled={!!progress}>
            <legend>导出</legend>
            <div className="format-tabs" aria-label="导出格式">
              {FORMATS.map(({ id, label }) => <button key={id} type="button" aria-pressed={settings.format === id}
                onClick={() => updateSetting('format', id)}>{label}</button>)}
            </div>
            <p className="format-detail">{formatInfo.detail}</p>
            {settings.format === 'pdf'
              ? <NumberField key="print-size" label="小图边长" unit="mm" min={1} max={500} step={0.1} value={settings.tileMm} onChange={value => updateSetting('tileMm', value)} />
              : <NumberField key={settings.format === 'zip' ? 'zip-size' : 'pixel-size'} label="小图边长" unit="px" min={32} max={4096}
                value={settings.format === 'zip' ? settings.zipPx : settings.tilePx}
                onChange={value => updateSetting(settings.format === 'zip' ? 'zipPx' : 'tilePx', value)} />}
            <div className="output-info" aria-live="polite">
              <span>{settings.format === 'zip' ? '小图尺寸' : '成品尺寸'}</span>
              {photos.length === 0 ? <strong>—</strong> : <>
                <strong>{dimensions.page
                  ? `${numberText(dimensions.page.widthMm)} × ${numberText(dimensions.page.heightMm)} mm`
                  : `${numberText(dimensions.width)} × ${numberText(dimensions.height)} px`}</strong>
                {dimensions.page && <small>{numberText(dimensions.width)} × {numberText(dimensions.height)} px</small>}
                {settings.format === 'zip' && <small>{photos.length} 张 JPG</small>}
                {!sizeAllowed && <small className="size-error">成品尺寸过大，请减小小图、间距或调整列数。</small>}
              </>}
            </div>
            <button type="button" className="primary export-button" disabled={!exportable} onClick={() => showExportPreview()}>预览并导出 {formatInfo.label} <span aria-hidden="true">↓</span></button>
          </fieldset>
        </div>
      </SidePanel>

      <section className="workspace" aria-label="排版预览">
        <header className="workspace-header">
          <div className="workspace-title">
            <h2>排版预览</h2>
            <span>{photos.length} 张照片{rows > 0 && ` · ${settings.columns} 列 × ${settings.fixedRows ?? rows} 行`}</span>
            {capacity !== null && <span className={difference === 0 ? 'count-ready' : 'count-alert'} role="status">{countMessage}</span>}
          </div>
          <div className="workspace-zoom" role="group" aria-label="排版预览缩放">
            <div className="zoom-stepper">
              <button type="button" aria-label="缩小预览" title="缩小预览" disabled={zoomDisabled || zoomIndex === 0} onClick={() => changeZoom(ZOOM_LEVELS[zoomIndex - 1])}>−</button>
              <output aria-label="当前预览倍率">{zoom}%</output>
              <button type="button" aria-label="放大预览" title="放大预览" disabled={zoomDisabled || zoomIndex === ZOOM_LEVELS.length - 1} onClick={() => changeZoom(ZOOM_LEVELS[zoomIndex + 1])}>＋</button>
            </div>
            <button type="button" aria-pressed={zoom === 100} disabled={zoomDisabled} onClick={() => changeZoom(100)}>整版</button>
          </div>
        </header>
        <div ref={stage} className={`stage${sort.drag ? ' sorting' : ''}${batchActive ? ' batch-selecting' : ''}`}
          {...sort.handlers} onScroll={() => { if (photoMenu) setPhotoMenu(null) }}>
          <div className="board" ref={board} style={{ minWidth: width }}>
            {photos.length === 0 ? <div className="empty-stage">
              <div className="empty-mark" aria-hidden="true"><i /><i /><i /></div>
              <h3>拖入照片开始排版</h3>
              <p>支持 JPG、PNG、WebP 和照片 ZIP</p>
              <button className="primary" type="button" disabled={!!progress} onClick={() => void importPhotos()}><span aria-hidden="true">＋</span> 选择照片</button>
            </div> : <div ref={sort.gridRef} className="photo-grid" style={{ gridTemplateColumns: `repeat(${settings.columns}, minmax(0, 1fr))`, gridAutoRows: tile, gap, width }}>
              {sort.ordered.map((photo, index) => <div data-photo-id={photo.id} key={photo.id}
                className={`photo-slot${sort.drag?.photo.id === photo.id ? ' drag-placeholder' : ''}${capacity !== null && index >= capacity ? ' overflow-photo' : ''}`}>
                <button type="button" data-sort-index={index} className="photo-tile" aria-pressed={batchSelection ? batchSelection.has(photo.id) : selectedId === photo.id} style={{ borderRadius: corner }}
                  aria-label={`第 ${index + 1} 张，${photo.asset.name}${capacity !== null && index >= capacity ? '，超出固定版式' : ''}`} title={`第 ${index + 1} 张 · ${photo.asset.name}`}
                  disabled={!!progress} aria-haspopup="menu" aria-expanded={photoMenu?.id === photo.id}
                  onContextMenu={event => {
                    event.preventDefault()
                    const coordinates = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined
                    openPhotoMenu(event.currentTarget, photo.id, coordinates)
                  }}
                  onKeyDown={event => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                    event.preventDefault()
                    openPhotoMenu(event.currentTarget, photo.id)
                  }}
                  onClick={event => selectPhoto(photo, index, event.shiftKey)}>
                  <PhotoView photo={photo} key={photo.asset.id} />
                  {batchActive && <span className="batch-check" aria-hidden="true">{batchSelection?.has(photo.id) && '✓'}</span>}
                  <span className="photo-number">{photoNumber(index)}</span>
                </button>
              </div>)}
              {difference < 0 && Array.from({ length: -difference }, (_, index) => <div className="vacant-slot" aria-hidden="true" key={index} />)}
            </div>}
          </div>
        </div>
        <footer className="workspace-footer">
          {batchActive ? <>
            <span role="status">已选 {batchCount} 张 · Shift 连选</span>
            <div className="batch-actions">
              <button type="button" disabled={!!progress} onClick={() => {
                batchAnchor.current = null
                setBatchSelection(batchCount === photos.length ? new Set() : new Set(photos.map(photo => photo.id)))
              }}>{batchCount === photos.length ? '取消全选' : '全选'}</button>
              <button type="button" onClick={endBatchSelection}>取消</button>
              <button type="button" className="remove-photo" disabled={!batchCount || !!progress} onClick={() => {
                if (batchSelection) removePhotos(batchSelection)
              }}>移除选中照片</button>
            </div>
          </> : <>
            <span>{photos.length > 0 ? '点击选择照片 · 拖动照片调整顺序' : '照片和项目文件均保存在本机'}</span>
            {photos.length > 0 && <button type="button" disabled={!!progress || !!sort.drag} onClick={() => setBatchSelection(new Set())}>批量选择</button>}
          </>}
        </footer>
      </section>

      <SidePanel side="right" title="照片编辑" controls={panels.controls('right')}>
        <div className="sidebar-card">
          <fieldset disabled={!!progress || !selected || batchActive}>
            <legend className="visually-hidden">照片编辑</legend>
            {selected ? <>
              <div className="selected-photo">
                <span>{photoNumber(sort.drag?.to ?? selectedIndex)}</span>
                <div><strong title={selected.asset.name}>{selected.asset.name}</strong>
                  <small className="selected-dimensions">{selected.asset.width} × {selected.asset.height} px</small></div>
              </div>
              <div ref={cropPreview} className="crop-preview" tabIndex={progress || batchActive ? -1 : 0} aria-label="调整裁切位置，可拖动或使用方向键"
                onPointerDown={cropStart} onPointerMove={cropMove} onPointerUp={() => { cropGesture.current = null }}
                onPointerCancel={() => { cropGesture.current = null }}
                onLostPointerCapture={() => { cropGesture.current = null }} onKeyDown={cropKeyboard}>
                <PhotoView photo={selected} key={selected.asset.id} priority />
                {cropAssist && <span className="head-guide" aria-hidden="true" />}
              </div>
              <div className="crop-tools">
                <p className="crop-hint">{cropAssist ? '虚线为头顶参考线' : '拖动调整裁切'}</p>
                <button type="button" aria-pressed={cropAssist} onClick={() => setCropAssist(!cropAssist)}>裁切对照</button>
              </div>
              {cropAssist && <CropReference photo={selected} />}
              <label className="zoom-control">
                <span>缩放 <strong>{Math.round(selected.crop.zoom * 100)}%</strong></span>
                <input type="range" min={1} max={8} step={0.01} value={selected.crop.zoom}
                  onPointerDown={() => { sliderGesture.current = {} }}
                  onPointerUp={() => { sliderGesture.current = null }}
                  onPointerCancel={() => { sliderGesture.current = null }}
                  onLostPointerCapture={() => { sliderGesture.current = null }}
                  onBlur={() => { sliderGesture.current = null }}
                  onChange={event => changeCrop({ ...selected.crop, zoom: Number(event.target.value) }, sliderGesture.current ?? undefined)} />
              </label>
              <div className="edit-buttons">
                <button type="button" onClick={() => changeCrop(DEFAULT_CROP)}>重置裁切</button>
                <button type="button" onClick={() => void replacePhotoInProject(selected)}>替换照片</button>
                <button type="button" className="remove-photo" disabled={!!sort.drag} onClick={() => removePhotos(new Set([selected.id]))}>从项目移除</button>
              </div>
              <form className="move-form" onSubmit={moveSelected}>
                <label htmlFor="move-position">移动到第几张</label>
                <div><input ref={moveInput} id="move-position" type="number" min={1} max={photos.length} step={1}
                  value={moveTo} onChange={event => setMoveTo(event.target.value)} />
                  <button type="submit" disabled={photos.length < 2}>移动</button></div>
              </form>
            </> : <div className="edit-empty"><span className="edit-empty-icon" aria-hidden="true" /><p>选中一张照片后，可调整裁切、替换或移动位置。</p></div>}
          </fieldset>
        </div>
      </SidePanel>
    </main>

    {photoMenu && menuPhoto && <PhotoMenu anchor={photoMenu} title={`第 ${menuIndex + 1} 张 · ${menuPhoto.asset.name}`}
      onDismiss={() => setPhotoMenu(null)} actions={batchSelection ? [
        { label: batchSelection.has(menuPhoto.id) ? '取消勾选' : '勾选这张照片', run: () => selectPhoto(menuPhoto, menuIndex, false) },
      ] : [
        { label: '选中并编辑', run: () => focusPhotoEditor(menuPhoto.id) },
        { label: '移动到第几张…', disabled: photos.length < 2, run: () => focusPhotoEditor(menuPhoto.id, true) },
        { label: '替换照片…', run: () => void replacePhotoInProject(menuPhoto) },
        { label: '从项目移除', destructive: true, run: () => removePhotos(new Set([menuPhoto.id])) },
      ]} />}

    {sort.drag && <div ref={sort.ghostRef} className="drag-photo" aria-hidden="true"
      style={{ width: sort.drag.size, height: sort.drag.size, borderRadius: corner }}>
      <PhotoView photo={sort.drag.photo} priority /><span className="photo-number">{photoNumber(sort.drag.to)}</span>
    </div>}
    {dropActive && !preview && <div className="drop-overlay" role="status">松开鼠标导入照片</div>}
    {progress && <div className="progress-card" role="status">
      <span>{progress.label}</span>{progress.total > 0 && <><small>{progress.current} / {progress.total}</small>
        <progress value={progress.current} max={progress.total} aria-label="处理进度" /></>}
    </div>}
    {!progress && notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <div><strong>{notice.text}</strong><button type="button" title="关闭通知" aria-label="关闭通知" onClick={() => setNotice(null)}>×</button></div>
      {notice.details && <details open={notice.kind === 'error' || undefined}><summary>查看详情</summary>
        <ul>{notice.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul></details>}
    </div>}
    <dialog ref={confirmDialog} onCancel={() => setConfirm(null)}>
      <h2>保存当前项目？</h2><p>当前修改尚未保存。</p>
      <div className="dialog-actions">
        <button type="button" onClick={() => setConfirm(null)}>取消</button>
        <button type="button" onClick={() => { setConfirm(null); confirm?.run() }}>不保存</button>
        <button type="button" className="primary" onClick={() => {
          setConfirm(null)
          void saveProject().then(saved => { if (saved) confirm?.run() })
        }}>保存并{confirm?.label}</button>
      </div>
    </dialog>
    {preview && <ExportPreview preview={preview} onCancel={() => setPreview(null)} onExport={() => void confirmExport()} />}
  </div>
}
