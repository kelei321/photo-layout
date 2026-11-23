import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { movePhoto, sortIndexAt, type Photo } from './model'

type Drag = { photo: Photo; from: number; to: number; size: number }
type Gesture = Drag & {
  pointer: number
  stage: HTMLDivElement
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  x: number
  y: number
  active: boolean
}

export function usePhotoSort(photos: Photo[], { columns, gap, width }: { columns: number; gap: number; width: number }, disabled: boolean, {
  select, commit,
}: { select: (id: string) => void; commit: (from: number, to: number) => void }) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const frame = useRef(0)
  const gridRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const suppressClick = useRef(false)
  const layout = `${columns}:${gap}:${width}`
  const positions = useRef({ layout, items: new Map<string, { x: number; y: number }>() })
  const from = drag?.from
  const to = drag?.to
  const ordered = useMemo(() => from !== undefined && to !== undefined
    ? movePhoto(photos, from, to) : photos, [photos, from, to])

  useLayoutEffect(() => {
    const next = new Map<string, { x: number; y: number }>()
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const slot of gridRef.current?.children ?? []) {
      if (!(slot instanceof HTMLElement) || !slot.dataset.photoId) continue
      const id = slot.dataset.photoId
      const position = { x: slot.offsetLeft, y: slot.offsetTop }
      next.set(id, position)
      const before = positions.current.items.get(id)
      const tile = slot.firstElementChild
      if (reduceMotion || positions.current.layout !== layout || id === drag?.photo.id || !before || !tile
        || (before.x === position.x && before.y === position.y)) continue
      const transform = getComputedStyle(tile).transform
      const offset = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform)
      tile.getAnimations().forEach(animation => animation.cancel())
      const x = before.x - position.x + offset.m41
      const y = before.y - position.y + offset.m42
      tile.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], {
        duration: 190,
        easing: 'cubic-bezier(.2,.75,.25,1)',
      })
    }
    positions.current = { layout, items: next }
  }, [ordered, drag?.photo.id, layout])

  useEffect(() => {
    window.addEventListener('blur', clearGesture)
    return () => {
      window.removeEventListener('blur', clearGesture)
      cancelAnimationFrame(frame.current)
    }
  }, [])

  function followPointer(current: Gesture) {
    const ghost = ghostRef.current
    if (ghost) ghost.style.transform = `translate3d(${current.x - current.offsetX}px, ${current.y - current.offsetY}px, 0)`
  }

  useLayoutEffect(() => {
    if (drag && gesture.current) followPointer(gesture.current)
  }, [drag])

  function targetIndex(current: Gesture) {
    const grid = gridRef.current
    if (!grid) return -1
    const stage = current.stage.getBoundingClientRect()
    const { x, y } = current
    if (x < stage.left || x >= stage.right || y < stage.top || y >= stage.bottom) return -1
    const bounds = grid.getBoundingClientRect()
    const currentGap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0
    return sortIndexAt(x - bounds.left, y - bounds.top, bounds.width, currentGap, columns, photos.length)
  }

  function updateTarget(current: Gesture) {
    const index = targetIndex(current)
    if (index < 0 || index === current.to) return
    current.to = index
    setDrag({ photo: current.photo, from: current.from, to: index, size: current.size })
  }

  function scrollAtEdge() {
    const current = gesture.current
    if (!current?.active) return
    const stage = current.stage.getBoundingClientRect()
    const { x, y } = current
    const edge = Math.min(44, stage.width / 3, stage.height / 3)
    const { scrollLeft, scrollTop } = current.stage
    const scrollDelta = (position: number, low: number, high: number) => {
      if (position < low + edge) return -Math.ceil((low + edge - position) / 3)
      return Math.max(0, Math.ceil((position - high + edge) / 3))
    }
    if (x >= stage.left && x < stage.right && y >= stage.top && y < stage.bottom) {
      current.stage.scrollLeft += scrollDelta(x, stage.left, stage.right)
      current.stage.scrollTop += scrollDelta(y, stage.top, stage.bottom)
    }
    if (current.stage.scrollTop !== scrollTop || current.stage.scrollLeft !== scrollLeft) updateTarget(current)
    frame.current = requestAnimationFrame(scrollAtEdge)
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || disabled || photos.length < 2) return
    const target = event.target as HTMLElement
    const tile = target.closest<HTMLElement>('button[data-sort-index]')
      ?? target.closest('.photo-slot')?.querySelector<HTMLElement>('button[data-sort-index]')
    if (!tile) return
    const from = Number(tile.dataset.sortIndex)
    const { clientX: x, clientY: y } = event
    const bounds = tile.getBoundingClientRect()
    suppressClick.current = false
    gesture.current = {
      photo: photos[from], from, to: from, size: bounds.width, pointer: event.pointerId,
      stage: event.currentTarget, startX: x, startY: y, x, y,
      offsetX: x - bounds.left, offsetY: y - bounds.top, active: false,
    }
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current
    if (!current || event.pointerId !== current.pointer) return
    current.x = event.clientX
    current.y = event.clientY
    if (!current.active) {
      if (!event.buttons || Math.hypot(current.x - current.startX, current.y - current.startY) < 6) return
      current.active = true
      current.stage.setPointerCapture(current.pointer)
      select(current.photo.id)
      setDrag({ photo: current.photo, from: current.from, to: current.to, size: current.size })
      frame.current = requestAnimationFrame(scrollAtEdge)
    }
    followPointer(current)
    updateTarget(current)
  }

  function clearGesture() {
    const current = gesture.current
    if (!current) return
    gesture.current = null
    cancelAnimationFrame(frame.current)
    if (current.active) {
      suppressClick.current = true
      window.setTimeout(() => { suppressClick.current = false }, 0)
      setDrag(null)
      if (current.stage.hasPointerCapture(current.pointer)) current.stage.releasePointerCapture(current.pointer)
    }
  }

  function pointerEnd(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current
    if (!current || event.pointerId !== current.pointer) return
    let index = -1
    if (current.active && event.type === 'pointerup') {
      current.x = event.clientX
      current.y = event.clientY
      index = targetIndex(current)
    }
    clearGesture()
    if (index >= 0) commit(current.from, index)
  }

  return {
    gridRef, ghostRef, ordered, drag, cancel: clearGesture,
    click: (id: string) => { if (!suppressClick.current) select(id) },
    handlers: {
      onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: pointerEnd,
      onPointerCancel: pointerEnd, onLostPointerCapture: pointerEnd,
    },
  }
}
