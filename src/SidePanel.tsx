import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { PANEL_MIN, type Side } from './panelLayout'

type Controls = {
  width: number
  collapsed: boolean
  maximum: number
  toggle: () => void
  resize: (width: number) => void
}

export default function SidePanel({ side, title, controls, children }: {
  side: Side; title: string; controls: Controls; children: ReactNode
}) {
  const { width, collapsed, maximum, toggle, resize } = controls
  const gesture = useRef<{ pointer: number; x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const direction = side === 'left' ? 1 : -1
  const label = `${collapsed ? '展开' : '折叠'}${title}`
  const content = `panel-${side}-content`

  function stop(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointer !== event.pointerId) return
    gesture.current = null
    setDragging(false)
  }

  return <aside className={`side-panel side-panel-${side}${collapsed ? ' panel-collapsed' : ''}`} aria-label={title}>
    <header className="panel-header">
      <span aria-hidden="true">{title}</span>
      <button type="button" className="panel-toggle" aria-label={label} title={label}
        aria-expanded={!collapsed} aria-controls={content} onClick={toggle}>
        <span aria-hidden="true">{(side === 'left') === !collapsed ? '‹' : '›'}</span>
      </button>
    </header>
    <div id={content} className={`sidebar ${side === 'left' ? 'settings-sidebar' : 'edit-sidebar'}`} hidden={collapsed}>{children}</div>
    {!collapsed && <div className={`panel-divider${dragging ? ' divider-dragging' : ''}`} role="separator" tabIndex={0}
      aria-label={`调整${title}宽度`} aria-orientation="vertical" aria-controls={content}
      aria-valuemin={PANEL_MIN} aria-valuemax={maximum} aria-valuenow={width} aria-valuetext={`${width} 像素`}
      title={`拖动调整${title}宽度`}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return
        event.preventDefault()
        const focused = document.activeElement
        if (focused instanceof HTMLElement && focused.classList.contains('panel-divider')) focused.blur()
        event.currentTarget.setPointerCapture(event.pointerId)
        gesture.current = { pointer: event.pointerId, x: event.clientX, width }
        setDragging(true)
      }}
      onPointerMove={event => {
        const start = gesture.current
        if (start?.pointer === event.pointerId) resize(start.width + (event.clientX - start.x) * direction)
      }}
      onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        if (event.key === 'Home') resize(PANEL_MIN)
        else if (event.key === 'End') resize(maximum)
        else resize(width + (event.key === 'ArrowRight' ? 16 : -16) * direction)
      }} />}
  </aside>
}
