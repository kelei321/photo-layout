import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { cropRect, type Photo, type Rect } from './model'
import { native } from './native'

type PreviewResult = { url: string } | { failed: true } | null
type Preview = { result: PreviewResult; listeners: Set<(result: PreviewResult) => void> }
const cache = new Map<string, Preview>()
const queue: { id: string; preview: Preview }[] = []
const visibilityCallbacks = new WeakMap<Element, () => void>()
let observer: IntersectionObserver | undefined
let active = 0

function runPreviewQueue() {
  while (active < 3 && queue.length) {
    const { id, preview } = queue.shift()!
    if (!preview.listeners.size) continue
    active += 1
    void native.preview(id).then(bytes => {
      if (preview.listeners.size) preview.result = { url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })) }
    }).catch(error => {
      console.error(error)
      preview.result = { failed: true }
    }).finally(() => {
      for (const listener of preview.listeners) listener(preview.result)
      active -= 1
      runPreviewQueue()
    })
  }
}

function subscribe(id: string, update: (result: PreviewResult) => void, priority: boolean) {
  let entry = cache.get(id)
  if (!entry) {
    entry = { result: null, listeners: new Set() }
    cache.set(id, entry)
    queue.push({ id, preview: entry })
  }
  if (priority) {
    const index = queue.findIndex(job => job.preview === entry)
    if (index > 0) queue.unshift(...queue.splice(index, 1))
  }
  const current = entry
  current.listeners.add(update)
  update(current.result)
  runPreviewQueue()
  return () => {
    current.listeners.delete(update)
    if (!current.listeners.size) {
      if (current.result && 'url' in current.result) URL.revokeObjectURL(current.result.url)
      cache.delete(id)
    }
  }
}

function whenVisible(element: Element, callback: () => void) {
  observer ??= new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue
      observer?.unobserve(target)
      visibilityCallbacks.get(target)?.()
      visibilityCallbacks.delete(target)
    }
  }, { rootMargin: '48px' })
  visibilityCallbacks.set(element, callback)
  observer.observe(element)
  return () => {
    observer?.unobserve(element)
    visibilityCallbacks.delete(element)
  }
}

export default function PhotoView({ photo, source, priority = false }: { photo: Photo; source?: Rect; priority?: boolean }) {
  const [result, setResult] = useState<PreviewResult>(null)
  const element = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    setResult(null)
    let unsubscribe: (() => void) | undefined
    const load = () => { unsubscribe = subscribe(photo.asset.id, setResult, priority) }
    if (priority || !element.current || typeof IntersectionObserver === 'undefined') load()
    const stopWatching = !unsubscribe && element.current ? whenVisible(element.current, load) : undefined
    return () => {
      stopWatching?.()
      unsubscribe?.()
    }
  }, [photo.asset.id, priority])

  const { x, y, width, height } = source ?? cropRect(photo.asset, photo.crop)
  const style: CSSProperties = {
    width: `${photo.asset.width / width * 100}%`,
    height: `${photo.asset.height / height * 100}%`,
    left: `${-x / width * 100}%`,
    top: `${-y / height * 100}%`,
  }
  return <span ref={element} className="photo-view">
    {result && 'url' in result
      ? <img alt="" draggable={false} className="cropped-image" src={result.url} style={style} />
      : result
        ? <span className="photo-placeholder preview-failed" role="img" aria-label="照片预览失败" title="照片预览失败">!</span>
        : <span className="photo-placeholder" />}
  </span>
}
