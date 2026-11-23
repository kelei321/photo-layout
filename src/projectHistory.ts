import type { Project } from './model'

type Entry = { project: Project; selection: string | null }
type History = {
  past: Entry[]
  present: Entry
  future: Entry[]
  saved: Project
  group?: object
}
type Action =
  | { type: 'edit'; project: Project; before: string | null; after: string | null; group?: object }
  | { type: 'undo' | 'redo'; selection: string | null }
  | { type: 'load'; project: Project }
  | { type: 'saved'; project: Project }

const HISTORY_LIMIT = 30

export function createHistory(project: Project): History {
  return { past: [], present: { project, selection: project.photos[0]?.id ?? null }, future: [], saved: project }
}

export function projectHistory(state: History, action: Action): History {
  if (action.type === 'load') return createHistory(action.project)
  if (action.type === 'saved') return { ...state, saved: action.project, group: undefined }
  if (action.type === 'edit') {
    const present = { project: action.project, selection: action.after }
    const past = action.group && action.group === state.group
      ? state.past
      : [...state.past, { ...state.present, selection: action.before }].slice(-HISTORY_LIMIT)
    return { ...state, present, past, future: [], group: action.group }
  }
  const undo = action.type === 'undo'
  const present = (undo ? state.past : state.future).at(-1)
  if (!present) return state
  const leaving = { ...state.present, selection: action.selection }
  return {
    ...state, present, group: undefined,
    past: undo ? state.past.slice(0, -1) : [...state.past, leaving],
    future: undo ? [...state.future, leaving] : state.future.slice(0, -1),
  }
}

export function historyAssets(history: History) {
  const assets = new Set<string>()
  for (const { project } of [...history.past, history.present, ...history.future]) {
    for (const photo of project.photos) assets.add(photo.asset.id)
  }
  return assets
}
