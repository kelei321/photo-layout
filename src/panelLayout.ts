export type Side = 'left' | 'right'
export type PanelWidths = Record<Side, number>
export type CollapsedPanels = Record<Side, boolean>

export const PANEL_MIN = 176
export const PANEL_MAX = 460
export const COLLAPSED_WIDTH = 40
export const WORKSPACE_MIN = 320

export function fitPanelWidths(requested: PanelWidths, collapsed: CollapsedPanels, available: number): PanelWidths {
  const minimum = { left: collapsed.left ? COLLAPSED_WIDTH : PANEL_MIN, right: collapsed.right ? COLLAPSED_WIDTH : PANEL_MIN }
  const extra = {
    left: collapsed.left ? 0 : Math.max(0, Math.min(PANEL_MAX, requested.left) - minimum.left),
    right: collapsed.right ? 0 : Math.max(0, Math.min(PANEL_MAX, requested.right) - minimum.right),
  }
  const budget = Math.max(0, Math.floor(available - minimum.left - minimum.right))
  const desired = extra.left + extra.right
  if (desired <= budget) return { left: minimum.left + extra.left, right: minimum.right + extra.right }
  const left = Math.round(budget * extra.left / desired)
  return { left: minimum.left + left, right: minimum.right + budget - left }
}
