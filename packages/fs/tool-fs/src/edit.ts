/**
 * Model-facing literal edit, unique-match by default. It obtains an optional guard from the
 * single intent slot, calls `ctx.fs.editText` without a separate stat, then records the observed
 * version; no policy means an unconditional atomic edit.
 * @module @neo/tool-fs/src/edit
 */

import type { Context } from '@neo/cordis'
import { defineTool } from '@neo/tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@neo/tools'
import type {} from '@neo/fs'
import type {} from '@neo/system-prompt'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

/** Validated `edit` arguments after defaulting. */
interface EditInput {
  filePath: string
  /** The literal edits in application order; one for the classic three-field call. */
  edits: readonly LiteralEdit[]
}

/** One literal replacement. */
export interface LiteralEdit {
  oldString: string
  newString: string
  replaceAll: boolean
}

/** One entry of the `edits` array parameter. */
interface RawLiteralEdit {
  old_string: string
  new_string: string
  replace_all?: boolean
}

/**
 * The `edit` tool's validated arguments: the base parameters plus the two
 * escalation fields, advertised only under a confining `ctx.fs` (absent from
 * the schema otherwise, so the validator rejects them before `execute`).
 */
interface EditToolArgs {
  file_path: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
  edits?: RawLiteralEdit[]
  sandbox_permissions?: string
  justification?: string
}

/** Validate one literal edit's value constraints the schema DSL can't express. */
function parseLiteralEdit(edit: RawLiteralEdit, label: string): LiteralEdit {
  if (edit.old_string.length === 0) throw new Error(`${label}old_string must be a non-empty string`)
  if (edit.old_string === edit.new_string) throw new Error(`${label}old_string and new_string must differ`)
  return { oldString: edit.old_string, newString: edit.new_string, replaceAll: edit.replace_all ?? false }
}

/**
 * Validate value constraints the schema DSL can't express: a non-blank
 * `file_path`, and either the classic `old_string`/`new_string` pair or a
 * non-empty `edits` array — never both. Every edit needs a non-empty
 * `old_string` that differs from its `new_string` (an equal pair would be a
 * guaranteed no-op edit).
 * @param args - the schema-validated raw tool arguments.
 * @returns the camelCased input: the edits in application order.
 */
export function parseEditArgs(args: {
  file_path: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
  edits?: RawLiteralEdit[]
}): EditInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const single = args.old_string !== undefined || args.new_string !== undefined || args.replace_all !== undefined
  if (args.edits !== undefined) {
    if (single) throw new Error('pass either old_string/new_string or edits, not both')
    if (args.edits.length === 0) throw new Error('edits must contain at least one edit')
    return { filePath: args.file_path, edits: args.edits.map((edit, index) => parseLiteralEdit(edit, `edits[${index}]: `)) }
  }
  if (args.old_string === undefined || args.new_string === undefined) {
    throw new Error('old_string and new_string are required unless edits is given')
  }
  return {
    filePath: args.file_path,
    edits: [parseLiteralEdit({ old_string: args.old_string, new_string: args.new_string, ...args.replace_all !== undefined ? { replace_all: args.replace_all } : {} }, '')],
  }
}

/** Read one string field of a raw `edits` entry for display; anything else renders empty. */
function text(entry: unknown, field: 'old_string' | 'new_string'): string {
  if (typeof entry !== 'object' || entry === null) return ''
  const value = (entry as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

/**
 * The per-edit diffs of one logged `edit` call, for display. Pure over the raw
 * args (replayed from the log, so never trusted): an `edits` array yields one
 * diff per entry, the classic pair yields one; an empty `old_string` maps to
 * `oldText: null` (a whole-file replace diff).
 * @param args - the raw logged call arguments.
 * @returns the diffs in application order.
 */
export function editCallDiffs(args: Record<string, unknown>): { path: string; oldText: string | null; newText: string }[] {
  const path = String(args['file_path'])
  const edits = Array.isArray(args['edits'])
    ? args['edits'].map(edit => ({ old: text(edit, 'old_string'), new: text(edit, 'new_string') }))
    : [{ old: text(args, 'old_string'), new: text(args, 'new_string') }]
  return edits.map(edit => ({ path, oldText: edit.old || null, newText: edit.new }))
}

/**
 * Format an edit success (single-match or replace-all) as a Claude-style model-facing message.
 * @param displayPath - the backend-resolved path shown to the model.
 * @param replaceAll - selects the all-occurrences wording over the single-replacement one.
 * @returns the confirmation sentence the model sees as the tool result.
 */
export function formatEditOutput(displayPath: string, replaceAll: boolean, editCount = 1): string {
  if (editCount > 1) return `The file ${displayPath} has been updated. All ${editCount} edits were applied.`
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
}

/**
 * Register the `edit` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param sandbox - the shared sandbox-escalation API (advertisement, mode stamping, denial mapping).
 */
export function applyEditTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: 102,
    text: 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Several changes to one file go in a single call through the edits array: they apply in order and the file is written once, or not at all. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.',
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      old_string: { type: 'string', description: 'Literal text to replace. Must match exactly. Required unless edits is given.' },
      new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match. Required unless edits is given.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      edits: {
        type: 'array',
        description: 'Several literal edits to this file in one atomic call, applied in order (each matches the text the previous one produced). Use instead of old_string/new_string, not with them.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
            new_string: { type: 'string', required: true, description: 'Literal replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace all matches of this edit. Defaults to false.' },
          },
        },
      },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: formatEditOutput(value.path, args.replace_all === true, Array.isArray(args.edits) ? args.edits.length : 1),
      }],
      presentationMeta: (args, value) => ({
        diffs: computeHunkDiffs(args.file_path, value.before, value.after)
          .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: EditToolArgs, exec) {
      const input = parseEditArgs(args)
      // Resolve the per-call sandbox policy (approved mode > session override
      // > backend default, plus the session cwd root) BEFORE anything executes.
      const sandboxPolicy = await sandbox.resolvePolicy('edit', args, exec)
      const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, input.filePath, sandboxPolicy?.workspaceRoot))
      // Single-slot decision: the policy plugin returns { version: vObserved } or
      // throws FS_NOT_OBSERVED; the bare default is undefined (unconditional edit).
      // No stat — the bare default never manufactures a version basis. The intent
      // slot itself can throw FS_NOT_OBSERVED for an unread target, so it sits
      // inside the try: both that refusal and the provider's guarded-mutation
      // failure get the model-facing remedy below.
      let outcome
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        outcome = await ctx.fs.editText(
          target,
          input.edits.length === 1 ? input.edits[0] as LiteralEdit : input.edits,
          intent,
          exec.signal,
          sandboxPolicy,
        )
      } catch (error: unknown) {
        // A sandbox denial becomes the shared [sandbox: …] marker (the model
        // recognizes it from bash); stale/not-observed failures gain their
        // model-facing remedy; anything else passes through.
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy))
      }
      // Record the present observation (a no-op when no policy plugin listens).
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        path: target.displayPath,
        before: outcome.before,
        after: outcome.after,
      }
    },
    // Pure display: a diff card of the literal replacement (old_string → new_string), derived
    // from the call args. `oldText: old_string || null` matches claude-agent-acp's Edit arm;
    // new_string is a required arg here, so it maps straight to newText.
    presentCall(args): DiffCallView {
      const path = args.file_path
      return {
        card: 'diff',
        title: `Edit ${path}`,
        diffs: editCallDiffs(args),
        locations: [{ path }],
      }
    },
    // Applied metadata replaces the call-time snippet; errors or malformed replay metadata use
    // the generic result rendering.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
