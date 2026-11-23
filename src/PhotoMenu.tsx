import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { clamp } from './model'

export type MenuAnchor = { x: number; y: number; trigger: HTMLButtonElement }
type Action = { label: string; run: () => void; disabled?: boolean; destructive?: boolean }

export default function PhotoMenu({ anchor, title, actions, onDismiss }: {
  anchor: MenuAnchor
  title: string
  actions: Action[]
  onDismiss: () => void
}) {
  const menu = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const margin = 8
    const width = document.documentElement.clientWidth
    const height = document.documentElement.clientHeight
    element.style.left = `${clamp(anchor.x, margin, Math.max(margin, width - element.offsetWidth - margin))}px`
    element.style.top = `${clamp(anchor.y, margin, Math.max(margin, height - element.offsetHeight - margin))}px`
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [anchor])

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onDismiss()
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('blur', onDismiss)
    window.addEventListener('resize', onDismiss)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('blur', onDismiss)
      window.removeEventListener('resize', onDismiss)
    }
  }, [onDismiss])

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      event.stopPropagation()
      onDismiss()
      if (anchor.trigger.isConnected) anchor.trigger.focus({ preventScroll: true })
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !menu.current) return
    event.preventDefault()
    const items = [...menu.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const current = items.findIndex(item => item === event.target)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
    items[next]?.focus({ preventScroll: true })
  }

  return <div ref={menu} className="photo-menu" role="menu" aria-label={title} onKeyDown={navigate}>
    <p className="photo-menu-title" aria-hidden="true" title={title}>{title}</p>
    {actions.map(action => <button key={action.label} type="button" role="menuitem" tabIndex={-1}
      disabled={action.disabled} className={action.destructive ? 'remove-photo' : undefined} onClick={() => {
        onDismiss()
        if (anchor.trigger.isConnected) anchor.trigger.focus({ preventScroll: true })
        action.run()
      }}>{action.label}</button>)}
  </div>
}
