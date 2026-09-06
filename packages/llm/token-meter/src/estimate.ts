/**
 * Fixed-density heuristic token pricing shared by the meter service and the
 * pure context-breakdown projection, so both surfaces price identical content
 * to identical numbers.
 *
 * @module @neo/dsh-token-meter/estimate
 */

import type { ContentBlock, Message } from '@neo/dsh-llm'
import type { EpochHeader } from '@neo/dsh-session'

/** Fixed text-density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4

/**
 * Pixels per image token along each axis: a 16 px vision patch merged 2×2 by
 * the projector (Qwen-VL family). One token per merged patch is the shape the
 * local multimodal stack prices, and a close enough fixed estimate for the
 * others: what matters is the order of magnitude, since the attachment
 * reference alone would price a screenshot like a short sentence.
 */
const IMAGE_PATCH_PX = 32

/** Floor for a degenerate image: special tokens and the smallest grid still cost something. */
const MIN_IMAGE_TOKENS = 64

/** Ceiling matching the projector's maximum pixel budget; larger images are downscaled. */
const MAX_IMAGE_TOKENS = 16_384

/**
 * Price one image by its merged-patch grid.
 * @param width - intrinsic width in pixels.
 * @param height - intrinsic height in pixels.
 * @returns the estimated vision tokens, clamped to the projector's floor and ceiling.
 */
function estimateImageTokens(width: number, height: number): number {
  const grid = Math.ceil(width / IMAGE_PATCH_PX) * Math.ceil(height / IMAGE_PATCH_PX)
  return Math.min(MAX_IMAGE_TOKENS, Math.max(MIN_IMAGE_TOKENS, grid))
}

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/**
 * Price content blocks recursively under the fixed density heuristic.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD
        break
      case 'image':
        tokens += estimateImageTokens(block.attachment.width, block.attachment.height) + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks retain a
        // conservative structural JSON price under the fixed heuristic.
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/**
 * Heuristically price one model-visible message.
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the fixed heuristic.
 */
export function estimateMessage(message: Message): number {
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the system-prompt part of a canonical request envelope.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic system-prompt tokens; 0 when absent.
 */
export function estimateSystemTokens(header: EpochHeader | undefined): number {
  if (header?.system === undefined) return 0
  return Math.ceil(header.system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of a canonical request envelope.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
 * Price the complete non-surface request envelope.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic system plus tool tokens.
 */
export function estimateHeader(header: EpochHeader | undefined): number {
  return estimateSystemTokens(header) + estimateToolsTokens(header)
}
