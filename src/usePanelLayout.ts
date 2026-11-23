import { useLayoutEffect, useRef, useState } from 'react'
import { clamp } from './model'
import { fitPanelWidths, PANEL_MAX, PANEL_MIN, WORKSPACE_MIN, type CollapsedPanels, type PanelWidths, type Side } from './panelLayout'

export function usePanelLayout() {
  const container = useRef<HTMLElement>(null)
  const [metrics, setMetrics] = useState({ available: 960, compact: false })
  const [requested, setRequested] = useState<Partial<PanelWidths>>({})
  const [collapsed, setCollapsed] = useState<CollapsedPanels>({ left: false, right: false })
  const defaults = metrics.compact ? { left: 198, right: 212 } : { left: 230, right: 254 }
  const widths = fitPanelWidths({ ...defaults, ...requested }, collapsed, metrics.available)

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0
      setMetrics({
        available: entry.contentRect.width - gap * 2 - WORKSPACE_MIN,
        compact: element.clientWidth <= 1050,
      })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  function controls(side: Side) {
    const other = side === 'left' ? 'right' : 'left'
    const maximum = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor(metrics.available - widths[other])))
    return {
      width: widths[side],
      collapsed: collapsed[side],
      maximum,
      toggle: () => setCollapsed(current => ({ ...current, [side]: !current[side] })),
      resize: (width: number) => {
        const next = clamp(Math.round(width), PANEL_MIN, maximum)
        if (next === widths[side]) return
        setRequested(current => ({
          ...current,
          [side]: next,
          ...(collapsed[other] ? {} : { [other]: widths[other] }),
        }))
      },
    }
  }

  return {
    container, widths, controls,
    expand: (side: Side) => setCollapsed(current => current[side] ? { ...current, [side]: false } : current),
  }
}
