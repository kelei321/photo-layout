import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cropRect, DEFAULT_CROP, DEFAULT_SETTINGS, exportCountAllowed, exportDimensions, exportSizeAllowed, fixedCapacity,
  makeExportJob, movePhoto, previewGridSize, previewTileStyle, replacePhoto, sortIndexAt,
} from '../src/model.ts'
import { createHistory, historyAssets, projectHistory } from '../src/projectHistory.ts'
import { COLLAPSED_WIDTH, fitPanelWidths, PANEL_MAX, PANEL_MIN } from '../src/panelLayout.ts'

const portrait = { id: 'portrait', name: 'portrait.jpg', width: 301, height: 601 }
const photos = Array.from({ length: 100 }, (_, index) => ({
  id: String(index + 1), asset: { ...portrait, id: 'original-' + (index + 1) }, crop: DEFAULT_CROP,
}))

test('square crop respects source limits and zoom', () => {
  assert.deepEqual(cropRect(portrait, DEFAULT_CROP), { x: 0, y: 150, width: 301, height: 301 })
  assert.deepEqual(cropRect(portrait, { x: 0, y: 1, zoom: 2 }), { x: 0, y: 450, width: 151, height: 151 })
  assert.deepEqual(cropRect({ ...portrait, width: 1, height: 1 }, { x: 0, y: 1, zoom: 8 }), {
    x: 0, y: 0, width: 1, height: 1,
  })
})

test('move then replace slot 61 without changing other photos', () => {
  const moved = movePhoto(photos, 0, 60)
  assert.equal(moved[60], photos[0])
  assert.equal(moved[0], photos[1])
  const replaced = replacePhoto(moved, moved[60].id, portrait)
  assert.equal(replaced[60].id, '1')
  assert.equal(replaced[60].asset, portrait)
  assert.deepEqual(replaced[60].crop, DEFAULT_CROP)
  assert.ok(replaced.every((photo, index) => index === 60 || photo === moved[index]))
})

test('three 100-photo layouts fit their raster and incomplete rows remain blank', () => {
  for (const columns of [5, 10, 20]) {
    const job = makeExportJob(photos, { ...DEFAULT_SETTINGS, columns })
    assert.equal(job.width, columns * 612 - 12)
    assert.equal(job.height, 100 / columns * 612 - 12)
    assert.ok(exportSizeAllowed(job.width, job.height))
  }
  const job = makeExportJob(photos.slice(0, 11), DEFAULT_SETTINGS)
  assert.equal(job.tiles.length, 11)
  assert.deepEqual(job.tiles[10].destination, { x: 0, y: 612, width: 600, height: 600 })
  assert.equal(job.width, 6108)
  assert.equal(job.height, 1212)
  assert.equal(exportSizeAllowed(16_000, 16_000), false)
})

test('PDF uses physical page dimensions and 300 DPI raster boundaries', () => {
  const settings = { ...DEFAULT_SETTINGS, format: 'pdf' }
  const job = makeExportJob(photos, settings)
  assert.deepEqual(job.page, { widthMm: 209, heightMm: 209 })
  assert.equal(job.width, 2469)
  assert.equal(job.height, 2469)
  const last = job.tiles.at(-1).destination
  assert.equal(last.x + last.width, job.width)
  assert.equal(last.y + last.height, job.height)
  const gapless = makeExportJob(photos, { ...settings, printGapMm: 0 })
  const first = gapless.tiles[0].destination
  assert.equal(first.x + first.width, gapless.tiles[1].destination.x)
})

test('numbered ZIP uses the same crops and independent square destinations', () => {
  const zip = makeExportJob(photos, { ...DEFAULT_SETTINGS, format: 'zip', zipPx: 300 })
  const jpg = makeExportJob(photos, DEFAULT_SETTINGS)
  assert.deepEqual(exportDimensions(100, { ...DEFAULT_SETTINGS, format: 'zip', zipPx: 300 }), {
    width: 300, height: 300, page: null,
  })
  assert.deepEqual(zip.tiles.map(tile => tile.source), jpg.tiles.map(tile => tile.source))
  assert.ok(zip.tiles.every(tile => tile.destination.x === 0 && tile.destination.width === 300))
})

test('live sorting uses stable grid slots, including gaps, row wraps and a partial last row', () => {
  const hit = (x, y) => sortIndexAt(x, y, 320, 10, 3, 7)
  assert.equal(hit(25, 25), 0)
  assert.equal(hit(102, 25), 0)
  assert.equal(hit(108, 25), 1)
  assert.equal(hit(315, 40), 2)
  assert.equal(hit(25, 112), 3)
  assert.equal(hit(300, 260), 6)
  assert.equal(hit(320, 20), -1)
  assert.equal(hit(30, 320), -1)
  const order = photos.slice(0, 7)
  assert.deepEqual(movePhoto(order, 0, hit(300, 158)).map(photo => photo.id), ['2', '3', '4', '5', '6', '1', '7'])
  assert.equal(order[0].id, '1')
})

test('export preview positions come from the rounded export pixels', () => {
  assert.deepEqual(previewTileStyle({ x: 24, y: 12, width: 24, height: 24 }, { width: 96, height: 48 }), {
    left: '25%', top: '25%', width: '25%', height: '50%',
  })
  const pdf = makeExportJob(photos, { ...DEFAULT_SETTINGS, format: 'pdf' })
  const last = previewTileStyle(pdf.tiles.at(-1).destination, pdf)
  assert.ok(Math.abs(Number.parseFloat(last.left) + Number.parseFloat(last.width) - 100) < 1e-10)
  assert.notEqual(last.width, '10%')
})

test('workspace fits both scroll axes and scales only its displayed dimensions', () => {
  const viewport = { width: 490, height: 350 }
  const spacing = 0.05
  for (const [columns, rows] of [[5, 20], [10, 10], [20, 5], [1, 500]]) {
    const fitted = previewGridSize(viewport, columns, rows, spacing, 100)
    const height = rows * fitted.tile + (rows - 1) * fitted.gap
    assert.ok(fitted.width <= viewport.width && height <= viewport.height)
    assert.ok(fitted.width > viewport.width - 15 || height > viewport.height - 15)
    assert.ok(previewGridSize(viewport, columns, rows, spacing, 50).tile < fitted.tile)
    assert.ok(previewGridSize(viewport, columns, rows, spacing, 200).tile > fitted.tile)
  }
})

test('every export carries the project corner radius without changing photo geometry', () => {
  for (const format of ['jpg', 'png', 'pdf', 'zip']) {
    const settings = { ...DEFAULT_SETTINGS, format }
    const square = makeExportJob(photos, settings)
    const round = makeExportJob(photos, { ...settings, cornerRadius: 25 })
    assert.equal(square.cornerRadius, 0)
    assert.deepEqual(round, { ...square, cornerRadius: 25 })
  }
})

test('fixed presets require the exact count for a grid and leave ZIP independent', () => {
  const fixed = { ...DEFAULT_SETTINGS, fixedRows: 10 }
  assert.equal(fixedCapacity(fixed), 100)
  assert.equal(exportCountAllowed(99, fixed), false)
  assert.equal(exportCountAllowed(103, fixed), false)
  assert.equal(exportCountAllowed(100, fixed), true)
  assert.equal(exportCountAllowed(103, { ...fixed, format: 'zip' }), true)
  assert.equal(exportCountAllowed(103, DEFAULT_SETTINGS), true)
  assert.deepEqual(exportDimensions(99, fixed), exportDimensions(100, fixed))
  assert.throws(() => makeExportJob(photos.slice(0, 99), fixed), /照片数量/)
})

test('history keeps removed and replaced assets while undoable and releases abandoned branches', () => {
  const project = { photos: photos.slice(0, 3), settings: DEFAULT_SETTINGS }
  let history = createHistory(project)
  const replacement = { ...portrait, id: 'replacement' }
  const edit = (entries, before, after, group) => {
    const next = { ...project, photos: entries }
    history = projectHistory(history, { type: 'edit', project: next, before, after, group })
    return next
  }
  const removed = edit(project.photos.slice(2), '1', '3')
  assert.equal(historyAssets(history).size, 3)
  history = projectHistory(history, { type: 'saved', project: removed })
  history = projectHistory(history, { type: 'undo', selection: '3' })
  assert.equal(history.present.project, project)
  assert.equal(history.present.selection, '1')
  history = projectHistory(history, { type: 'redo', selection: '1' })
  assert.equal(history.present.project, history.saved)
  const replaced = replacePhoto(removed.photos, '3', replacement)
  edit(replaced, '3', '3')
  history = projectHistory(history, { type: 'undo', selection: '3' })
  assert.ok(historyAssets(history).has('replacement'))
  const group = {}
  edit([{ ...removed.photos[0], crop: { ...DEFAULT_CROP, zoom: 2 } }], '3', '3', group)
  edit([{ ...removed.photos[0], crop: { ...DEFAULT_CROP, zoom: 3 } }], '3', '3', group)
  assert.equal(history.future.length, 0)
  assert.ok(!historyAssets(history).has('replacement'))
  history = projectHistory(history, { type: 'undo', selection: '3' })
  assert.equal(history.present.project, removed)
})

test('side panel width follows the available space and reserves the collapsed rails', () => {
  const open = { left: false, right: false }
  const requested = { left: 310, right: 350 }
  assert.deepEqual(fitPanelWidths(requested, open, 800), requested)
  const fitted = fitPanelWidths(requested, open, 480)
  assert.equal(fitted.left + fitted.right, 480)
  assert.ok(fitted.left >= PANEL_MIN && fitted.right >= PANEL_MIN)
  assert.deepEqual(fitPanelWidths(requested, { ...open, right: true }, 480), { left: 310, right: COLLAPSED_WIDTH })
  assert.deepEqual(fitPanelWidths(requested, { left: true, right: true }, 480), { left: COLLAPSED_WIDTH, right: COLLAPSED_WIDTH })
  assert.deepEqual(fitPanelWidths({ left: 900, right: 60 }, open, 900), { left: PANEL_MAX, right: PANEL_MIN })
})
