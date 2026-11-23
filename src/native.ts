import { invoke } from '@tauri-apps/api/core'
import type { Asset, Job, Project } from './model'

export type Imported = { assets: Asset[]; issues: string[]; issueCount: number }
export type Progress = { label: string; current: number; total: number }

export const native = {
  import: (capacity: number, paths: string[] | null = null, replacement = false) =>
    invoke<Imported | null>('import_photos', { capacity, paths, replacement }),
  preview: (id: string) => invoke<ArrayBuffer>('photo_preview', { id }),
  release: (ids: string[]) => invoke<void>('release_photos', { ids }),
  open: () => invoke<{ path: string; project: Project } | null>('open_project'),
  save: (path: string | null, project: Project) => invoke<string | null>('save_project', { path, project }),
  export: (job: Job) => invoke<string | null>('export_photos', { job }),
}
