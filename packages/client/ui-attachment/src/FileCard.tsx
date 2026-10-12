import { useCallback, useState } from 'react'
import type { FileAttachmentRef } from '@neo/attachment'
import { IconDownloadOutline16, IconPaperclipOutline16 } from '@neo/client-ui-primitives'
import css from './FileCard.module.css'

/** Loads a session-authorized durable file into a browser-consumable URL. */
export type FileLoader = (attachment: FileAttachmentRef) => Promise<string>

/** File-card strings the owner resolves from its own locale namespace. */
export interface FileCardLabels {
  /** Fallback display name for an unnamed file. */
  file: string
  /** Download-control label / tooltip. */
  download: string
  /** In-flight label while bytes resolve. */
  downloading: string
  /** Retry label shown when the download fails. */
  downloadFailed: string
}

/** Trigger a browser download for one already-resolved object URL. */
function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * A downloadable-file card for chat history (the ChatGPT/Claude-style artifact
 * tile). The card renders immediately from the reference metadata (name, size,
 * type); bytes are fetched only when the viewer clicks download, so large files
 * are never eagerly loaded.
 *
 * @param props.attachment - the durable file reference.
 * @param props.load - session-authorized URL loader (resolves bytes on demand).
 * @param props.sizeText - byte-count formatter supplied by the owner's locale.
 * @param props.labels - resolved strings (name fallback, download, retry).
 * @param props.align - `end` for the viewer's own messages, `start` otherwise.
 * @returns the file card with an idle/loading/failed download control.
 */
export function FileCard({ attachment, load, sizeText, labels, align }: {
  attachment: FileAttachmentRef
  load: FileLoader
  sizeText: (bytes: number) => string
  labels: FileCardLabels
  align: 'start' | 'end'
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const name = attachment.name ?? labels.file

  const download = useCallback(() => {
    setState('loading')
    void load(attachment)
      .then((url) => { triggerDownload(url, name); setState('idle') })
      .catch(() => { setState('error') })
  }, [attachment, load, name])

  const meta = state === 'error'
    ? labels.downloadFailed
    : `${sizeText(attachment.bytes)} · ${attachment.mediaType}`

  return (
    <div className={css.card} data-align={align} data-state={state}>
      <span className={css.icon} aria-hidden="true"><IconPaperclipOutline16 /></span>
      <span className={css.body}>
        <span className={css.name} title={name}>{name}</span>
        <span className={css.meta}>{meta}</span>
      </span>
      <button
        type="button"
        className={css.action}
        title={labels.download}
        aria-label={`${labels.download}: ${name}`}
        disabled={state === 'loading'}
        onClick={download}
      >
        {state === 'loading' ? <span className={css.spinner} /> : <IconDownloadOutline16 />}
      </button>
    </div>
  )
}
