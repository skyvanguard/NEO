// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AttachmentId } from '@neo/attachment'
import { FileCard } from '../src/FileCard.tsx'
import type { FileCardLabels } from '../src/FileCard.tsx'

afterEach(cleanup)

const labels: FileCardLabels = {
  file: 'Archivo',
  download: 'Descargar',
  downloading: 'Descargando…',
  downloadFailed: 'No se pudo descargar; hacé clic para reintentar',
}

const attachment = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'text/markdown',
  bytes: 18094,
  name: 'INFORME_GIVA_PARA_GERENCIA.md',
}

const sizeText = (bytes: number): string => `${Math.round(bytes / 1024)}KB`

describe('FileCard', () => {
  it('renders name, size and type without loading bytes eagerly', () => {
    const load = vi.fn().mockResolvedValue('blob:file')
    const view = render(<FileCard attachment={attachment} load={load} sizeText={sizeText} labels={labels} align="start" />)
    expect(view.getByText('INFORME_GIVA_PARA_GERENCIA.md')).toBeTruthy()
    expect(view.getByText('18KB · text/markdown')).toBeTruthy()
    expect(load).not.toHaveBeenCalled()
  })

  it('resolves bytes and triggers a browser download on click', async () => {
    const load = vi.fn().mockResolvedValue('blob:file-url')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const view = render(<FileCard attachment={attachment} load={load} sizeText={sizeText} labels={labels} align="start" />)
    fireEvent.click(view.getByRole('button', { name: 'Descargar: INFORME_GIVA_PARA_GERENCIA.md' }))
    await waitFor(() => { expect(click).toHaveBeenCalledOnce() })
    expect(load).toHaveBeenCalledWith(attachment)
    click.mockRestore()
  })

  it('shows a retry state when the download fails', async () => {
    const load = vi.fn().mockRejectedValue(new Error('denied'))
    const view = render(<FileCard attachment={attachment} load={load} sizeText={sizeText} labels={labels} align="start" />)
    fireEvent.click(view.getByRole('button', { name: 'Descargar: INFORME_GIVA_PARA_GERENCIA.md' }))
    await waitFor(() => { expect(view.getByText(labels.downloadFailed)).toBeTruthy() })
  })

  it('falls back to the file label for an unnamed attachment', () => {
    const { name: _named, ...unnamed } = attachment
    const view = render(<FileCard attachment={unnamed} load={vi.fn()} sizeText={sizeText} labels={labels} align="end" />)
    expect(view.getByText('Archivo')).toBeTruthy()
  })
})
