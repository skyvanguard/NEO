/**
 * Model-facing `list_dir` tool: the direct children of one directory, with
 * their kind and size. `glob` enumerates files only and never directory
 * entries, so discovering a tree's shape used to take a recursive glob and
 * some deduction; this is the primitive that answers "what is in here?" in
 * one call.
 *
 * @module dsh-tool-fs/list-dir
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { FsDirEntry } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { sessionResolveOptions } from './session-cwd.ts'

/** Entries a listing returns inline before it says how many more there were. */
export const LIST_DIR_MAX_ENTRIES = 500

/** One listed child as the model sees it. */
export interface ListedEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

/** Validated `list_dir` arguments. */
export interface ListDirInput {
  path: string
  includeHidden: boolean
}

/**
 * Validate value constraints the schema DSL can't express.
 * @param args - the schema-validated raw tool arguments.
 * @returns the camelCased input with `include_hidden` defaulted to false.
 */
export function parseListDirArgs(args: { path?: string; include_hidden?: boolean }): ListDirInput {
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  return { path: args.path ?? '.', includeHidden: args.include_hidden ?? false }
}

/** Directories first, then files, each group in code-point name order. */
function compareEntries(left: ListedEntry, right: ListedEntry): number {
  const rank = (entry: ListedEntry): number => entry.type === 'directory' ? 0 : entry.type === 'file' ? 1 : 2
  const byRank = rank(left) - rank(right)
  if (byRank !== 0) return byRank
  return left.name < right.name ? -1 : 1
}

/**
 * Project backend entries into the model-facing shape: hidden names dropped
 * unless asked for, directories first, capped at {@link LIST_DIR_MAX_ENTRIES}.
 * @param entries - the backend's children of the listed directory.
 * @param includeHidden - whether dot-prefixed names are kept.
 * @returns the listed entries plus how many were omitted by the cap.
 */
export function projectEntries(entries: readonly FsDirEntry[], includeHidden: boolean): { entries: ListedEntry[]; omitted: number } {
  const visible = entries
    .filter(entry => includeHidden || !entry.name.startsWith('.'))
    .map((entry): ListedEntry => ({ name: entry.name, type: entry.type, ...entry.size !== undefined ? { size: entry.size } : {} }))
    .sort(compareEntries)
  return { entries: visible.slice(0, LIST_DIR_MAX_ENTRIES), omitted: Math.max(0, visible.length - LIST_DIR_MAX_ENTRIES) }
}

/** Human-scale byte size for the listing. */
function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Format one listing for the model: one line per entry, a trailing slash on
 * directories, sizes on files, and a closing note when the cap cut the list.
 * @param displayPath - the listed directory as the backend displays it.
 * @param listing - the projected entries and omitted count.
 * @returns the model-facing text.
 */
export function formatListDirOutput(displayPath: string, listing: { entries: readonly ListedEntry[]; omitted: number }): string {
  if (listing.entries.length === 0) return `${displayPath} is empty`
  const lines = listing.entries.map(entry => entry.type === 'directory'
    ? `${entry.name}/`
    : entry.type === 'file'
      ? `${entry.name}${entry.size === undefined ? '' : `  (${formatSize(entry.size)})`}`
      : `${entry.name}  (other)`)
  const footer = listing.omitted > 0
    ? `\n… and ${listing.omitted} more ${listing.omitted === 1 ? 'entry' : 'entries'}; narrow the path or use glob.`
    : ''
  return `${displayPath}\n${lines.join('\n')}${footer}`
}

/**
 * Register the `list_dir` tool and its prompt guidance.
 * @param ctx - the plugin context; execution uses its `fs` service.
 */
export function applyListDirTool(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:list_dir',
    order: 103,
    text: 'Use list_dir to see what a directory contains (children with kind and size) before deciding what to read; glob returns files only and never directory entries.',
  })
  ctx.tools.register(defineTool({
    name: 'list_dir',
    description: 'List the direct children of a directory: subdirectories first, then files with their sizes. '
      + `Hidden entries are omitted unless asked for; at most ${LIST_DIR_MAX_ENTRIES} entries come back inline.`,
    parameters: {
      path: { type: 'string', description: 'Directory to list. Defaults to the session workspace; a relative path resolves against it.' },
      include_hidden: { type: 'boolean', description: 'Include dot-prefixed entries. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true, enum: ['file', 'directory', 'other'] },
                size: { type: 'integer' },
              },
            },
          },
          omitted: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatListDirOutput(value.path, { entries: value.entries, omitted: value.omitted }),
      }],
    },
    async execute(args: { path?: string; include_hidden?: boolean }, exec) {
      const input = parseListDirArgs(args)
      const target = await ctx.fs.resolve(input.path, sessionResolveOptions(exec, input.path))
      const listing = projectEntries(await ctx.fs.listDir(target, exec.signal), input.includeHidden)
      return { path: target.displayPath, entries: listing.entries, omitted: listing.omitted }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `List ${typeof args.path === 'string' ? args.path : '.'}`, locations: [] }
    },
  }))
}
