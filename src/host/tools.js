import fs from 'node:fs'
import path from 'node:path'
import { workspaceStatus } from './workspace.js'

// 多资料空间：同一个 id 在别的库里很常见是「找不到」的真实原因。
const MISSING_RECORD_HINT = 'Not found in the active library. MeetClip can hold several libraries (work, life, …) and only the active one is searchable: call meetclip_status to see which one is active, and ask the user to switch in the MeetClip header if the record lives in another library.'

const MAX_TRANSCRIPT_ROWS = 200
const MAX_TRANSCRIPT_CHARS = 12_000
const MAX_LIST = 100

export function registerTools(ctx, runtime) {
  const tools = ctx.get('tools')
  if (!tools || !runtime.settings.tools) return
  const definitions = buildDefinitions(runtime, ctx)
  for (const definition of definitions) {
    ctx.effect(() => tools.register(definition))
  }
}

function buildDefinitions(runtime, ctx) {
  return [
    definition({
      name: 'meetclip_status',
      description: 'Read MeetClip backend, runtime, tool availability and data-directory status.',
      parameters: objectSchema({}),
      execute: async () => statusPayload(runtime, ctx)
    }),
    definition({
      name: 'meetclip_records',
      description: 'Browse, read and maintain MeetClip records (live captures, video links and meetings). Transcript text is returned in bounded pages.',
      parameters: objectSchema({
        action: enumField('Operation', ['list', 'get', 'transcript', 'search', 'rename', 'delete', 'retranscribe', 'cancel', 'export_markdown', 'export_zip'], true),
        session_id: stringField('Record id from meetclip_records.list or meetclip_search.'),
        query: stringField('Keyword for action=search; matched against this record only.'),
        offset: numberField('Zero-based transcript row offset for action=transcript (default 0).'),
        limit: numberField('Maximum transcript rows for action=transcript (default 80, max 200).'),
        title: stringField('New title for action=rename.'),
        asr_provider: enumField('Transcription provider for action=retranscribe.', ['local', 'mimo'])
      }),
      execute: async (args, exec) => {
        const action = String(args.action || 'list')
        if (action === 'list') return recordsList(runtime, args)
        const id = requireString(args.session_id, 'session_id')
        if (action === 'get') return recordGet(runtime, id)
        if (action === 'transcript') return recordTranscript(runtime, id, args)
        if (action === 'search') return recordSearch(runtime, id, args)
        if (action === 'rename') return recordRename(runtime, id, args)
        if (action === 'delete') return recordDelete(runtime, ctx, exec, args)
        if (action === 'retranscribe') return recordRetranscribe(runtime, id, args)
        if (action === 'cancel') return recordCancel(runtime, id)
        if (action === 'export_markdown') return recordExport(runtime, id, false)
        if (action === 'export_zip') return recordExport(runtime, id, true)
        return { ok: false, code: 'bad_action', message: `Unsupported action: ${action}` }
      }
    }),
    definition({
      name: 'meetclip_search',
      description: 'Search the whole MeetClip library by title, notes, transcripts, marks, OCR, speakers, sources and calendar text.',
      parameters: objectSchema({
        query: stringField('Keyword or phrase to find.', true),
        kind: enumField('Restrict to one kind.', ['all', 'live', 'link_video', 'meeting', 'calendar']),
        offset: numberField('Zero-based result offset (default 0).'),
        limit: numberField('Maximum results (default 10, max 20).')
      }),
      execute: async (args) => safe(async () => {
        const query = requireString(args.query, 'query')
        const limit = clampInt(args.limit, 10, 1, 20)
        const offset = clampInt(args.offset, 0, 0, 10_000)
        const kind = String(args.kind || 'all')
        const result = await json(runtime, `/api/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(kind)}&offset=${offset}&limit=${limit}`)
        return {
          ok: true,
          total: result?.total ?? 0,
          counts: result?.counts ?? {},
          has_more: Boolean(result?.has_more),
          results: (result?.results || []).slice(0, limit).map((row) => ({
            id: row.id,
            kind: row.kind,
            title: row.title,
            date: row.date,
            field: row.field,
            snippet: String(row.snippet || '').slice(0, 400),
            match_count: row.match_count,
            status: row.status,
            target: row.target
          }))
        }
      })
    }),
    definition({
      name: 'meetclip_capture',
      description: 'Create and control MeetClip work: check/start a Bilibili live capture, preview or add video links, import a local meeting file, inspect or cancel queued work.',
      parameters: objectSchema({
        action: enumField('Operation', ['precheck_live', 'start_live', 'preview_link', 'add_links', 'import_meeting', 'stop', 'cancel_task', 'queue_status'], true),
        url: stringField('Live or video URL for the URL actions.'),
        urls: arrayField('Video URLs for action=add_links (max 20).'),
        session_id: stringField('Record id for stop or cancel_task.'),
        path: stringField('Local audio/video path for import_meeting; must be inside MeetClip data or uploads.'),
        title: stringField('Optional title for start_live or import_meeting.'),
        language: stringField('Meeting language id, for example zh or en; empty means automatic.'),
        hotwords: stringField('Meeting hotwords separated by commas.'),
        transcription_mode: enumField('Video transcription preference.', ['auto', 'asr']),
        subtitle_track_id: stringField('Explicit subtitle track id when multiple tracks exist.')
      }),
      execute: async (args) => {
        const action = String(args.action || '')
        if (action === 'precheck_live') return safe(async () => ({ ok: true, result: await post(runtime, '/api/precheck', { url: requireString(args.url, 'url') }) }))
        if (action === 'start_live') return startLive(runtime, args)
        if (action === 'preview_link') return safe(async () => ({ ok: true, result: await post(runtime, '/api/link-videos/preview', { url: requireString(args.url, 'url') }) }))
        if (action === 'add_links') return addLinks(runtime, args)
        if (action === 'import_meeting') return importMeeting(runtime, args)
        if (action === 'stop') return stopRecord(runtime, args)
        if (action === 'cancel_task') return cancelTask(runtime, args)
        if (action === 'queue_status') return queueStatus(runtime)
        return { ok: false, code: 'bad_action', message: `Unsupported action: ${action}` }
      }
    }),
    definition({
      name: 'meetclip_marks',
      description: 'Read and edit timestamped marks (bookmarks with notes) on one MeetClip record.',
      parameters: objectSchema({
        action: enumField('Operation', ['list', 'add', 'update', 'delete'], true),
        session_id: stringField('Record id.', true),
        mark_id: numberField('Mark id for update/delete.'),
        ts: numberField('Media timestamp in seconds for add.'),
        note: stringField('Mark note or annotation.')
      }),
      execute: async (args) => {
        const action = String(args.action || 'list')
        const id = requireString(args.session_id, 'session_id')
        if (action === 'list') return safe(async () => {
          const detail = await json(runtime, `/api/sessions/${encodeURIComponent(id)}`)
          return { ok: true, session_id: id, marks: (detail.marks || []).map(compactMark) }
        })
        if (action === 'add') return safe(async () => {
          const value = await post(runtime, `/api/sessions/${encodeURIComponent(id)}/marks`, {
            ts: number(args.ts, 0), note: String(args.note || '')
          })
          return { ok: true, mark_id: value.id, session_id: id }
        })
        if (action === 'update') return safe(async () => {
          const markId = number(args.mark_id, null)
          if (!markId) return { ok: false, code: 'missing_argument', message: 'mark_id is required for update' }
          await patch(runtime, `/api/marks/${markId}`, { ts: number(args.ts, 0), note: String(args.note || '') })
          return { ok: true, mark_id: markId }
        })
        if (action === 'delete') return safe(async () => {
          const markId = number(args.mark_id, null)
          if (!markId) return { ok: false, code: 'missing_argument', message: 'mark_id is required for delete' }
          await del(runtime, `/api/marks/${markId}`)
          return { ok: true, mark_id: markId }
        })
        return { ok: false, code: 'bad_action', message: `Unsupported action: ${action}` }
      }
    }),
    definition({
      name: 'meetclip_notes',
      description: 'Read or replace the Markdown notes of a MeetClip record. Notes may contain an auto-managed AI minutes block between <!-- meetclip:minutes:begin --> and <!-- meetclip:minutes:end -->; preserve it unless intentionally replacing. Replacing requires the current notes_version; a stale version is rejected instead of overwriting.',
      parameters: objectSchema({
        action: enumField('Operation', ['get', 'set'], true),
        session_id: stringField('Record id.', true),
        notes: stringField('Full Markdown content for action=set.'),
        version: numberField('Current notes_version for action=set.')
      }),
      execute: async (args) => {
        const action = String(args.action || 'get')
        const id = requireString(args.session_id, 'session_id')
        if (action === 'get') return safe(async () => {
          const detail = await json(runtime, `/api/sessions/${encodeURIComponent(id)}`)
          return { ok: true, session_id: id, notes: detail.notes || '', version: detail.notes_version ?? 0 }
        })
        if (action === 'set') {
          if (args.version === undefined || args.version === null) {
            return { ok: false, code: 'missing_version', message: 'Read the notes first and pass the returned version.' }
          }
          return safe(async () => {
            try {
              const value = await patch(runtime, `/api/sessions/${encodeURIComponent(id)}/notes`, {
                notes: String(args.notes ?? ''), version: Number(args.version)
              })
              return { ok: true, session_id: id, version: value.notes_version, saved: true }
            } catch (error) {
              if (error?.status === 409) {
                const detail = await json(runtime, `/api/sessions/${encodeURIComponent(id)}`)
                return {
                  ok: false,
                  code: 'version_conflict',
                  message: String(error.message || 'Notes changed elsewhere'),
                  current_version: detail.notes_version ?? 0
                }
              }
              throw error
            }
          })
        }
        return { ok: false, code: 'bad_action', message: `Unsupported action: ${action}` }
      }
    }),
    definition({
      name: 'meetclip_minutes',
      description: 'Read or regenerate the AI minutes of one MeetClip record: a summary, topics with time anchors (seconds), conclusions, to-dos with owners, and a glossary of names/terms with their misheard variants. The template follows the record kind (meeting notes, video notes or live notes); regenerating also replaces the auto-managed minutes block inside the record notes. Results are bounded. Regenerating spends the user\'s AI quota and needs approval.',
      parameters: objectSchema({
        action: enumField('Operation', ['get', 'regenerate'], true),
        session_id: stringField('Record id.', true),
        mode: enumField('Regenerate mode: final rewrites from the whole transcript, live only adds what is new.', ['final', 'live'])
      }),
      execute: async (args, exec) => {
        const action = String(args.action || 'get')
        const id = requireString(args.session_id, 'session_id')
        if (action === 'get') return safe(async () => {
          const data = await json(runtime, `/api/sessions/${encodeURIComponent(id)}/minutes`)
          return boundedMinutes(data, id)
        })
        if (action === 'regenerate') {
          const approval = await requireApproval(ctx, exec, 'meetclip_minutes', `Regenerate AI minutes for ${id}`)
          if (approval) return approval
          return safe(async () => {
            const mode = String(args.mode || 'final')
            await post(runtime, `/api/sessions/${encodeURIComponent(id)}/minutes`, { mode })
            return {
              ok: true, session_id: id, queued: true,
              message: 'Minutes are being regenerated in the background; read them again in a few seconds.'
            }
          })
        }
        return { ok: false, code: 'bad_action', message: `Unsupported action: ${action}` }
      }
    }),
    definition({
      name: 'meetclip_settings',
      description: 'Read MeetClip speech-engine, model, dependency and meeting-option status. Configuration changes remain in the MeetClip settings page.',
      parameters: objectSchema({
        action: enumField('Operation', ['get'], true)
      }),
      execute: async () => safe(async () => {
        const [engine, deps, options, asr] = await Promise.all([
          json(runtime, '/api/asr/engines'),
          json(runtime, '/api/deps'),
          json(runtime, '/api/meeting/options'),
          json(runtime, '/api/asr/status')
        ])
        return {
          ok: true,
          engine: { provider: engine.default_provider, has_api_key: engine.has_api_key, ready: engine.ready },
          deps,
          meeting: {
            asr_ready: options.asr_ready
          },
          models: {
            asr: { state: asr.state, ready: asr.ready }
          }
        }
      })
    }),
    definition({
      name: 'meetclip_calendar',
      description: 'Read and maintain MeetClip calendar events, their local notes, linked records and quote references. Remote (Feishu) events are read-only.',
      parameters: objectSchema({
        action: enumField('Operation', ['range', 'get', 'create', 'update', 'delete', 'restore', 'link', 'unlink', 'notes_get', 'notes_set', 'quote', 'export'], true),
        event_id: stringField('Calendar event id.'),
        start: numberField('Range start or event start (epoch seconds).'),
        end: numberField('Range end or event end (epoch seconds).'),
        title: stringField('Event title.'),
        all_day: booleanField('Whether the event is all-day.'),
        start_date: stringField('Event start date, YYYY-MM-DD.'),
        end_date: stringField('Event end date, YYYY-MM-DD.'),
        timezone: stringField('IANA time zone, default Asia/Shanghai.'),
        location: stringField('Location.'),
        description: stringField('Description.'),
        session_ids: arrayField('Record ids to link.'),
        session_id: stringField('Record id for unlink or quote.'),
        quote_start: numberField('Media timestamp in seconds for the quote.'),
        text: stringField('Quote text.'),
        notes: stringField('Full Markdown notes for notes_set.'),
        version: numberField('Current notes version for notes_set.'),
        limit: numberField('Maximum events for range (default 200).')
      }),
      execute: async (args, exec) => {
        const action = String(args.action || 'range')
        if (action === 'range') return calendarRange(runtime, args)
        if (action === 'create') return calendarCreate(runtime, args)
        let id
        try { id = requireString(args.event_id, 'event_id') }
        catch (error) { return { ok: false, code: error.code || 'missing_argument', message: String(error.message || error) } }
        if (action === 'get') return calendarGet(runtime, id)
        if (action === 'update') return calendarUpdate(runtime, id, args)
        if (action === 'delete') {
          const approval = await requireApproval(ctx, exec, 'meetclip_calendar', `Delete calendar event ${id}`)
          if (approval) return approval
          return safe(async () => { await del(runtime, `/api/calendar/events/${encodeURIComponent(id)}`); return { ok: true, event_id: id, deleted: true } })
        }
        if (action === 'restore') return safe(async () => { await post(runtime, `/api/calendar/events/${encodeURIComponent(id)}/restore`, {}); return { ok: true, event_id: id, restored: true } })
        if (action === 'link') return safe(async () => {
          const ids = Array.isArray(args.session_ids) ? args.session_ids.map(String) : []
          if (ids.length === 0) return { ok: false, code: 'missing_argument', message: 'session_ids is required' }
          const value = await post(runtime, `/api/calendar/events/${encodeURIComponent(id)}/links`, { session_ids: ids })
          return { ok: true, event_id: id, records: (value.records || []).map((row) => ({ id: row.id, title: row.title })) }
        })
        if (action === 'unlink') return safe(async () => {
          const sessionId = requireString(args.session_id, 'session_id')
          await del(runtime, `/api/calendar/events/${encodeURIComponent(id)}/links/${encodeURIComponent(sessionId)}`)
          return { ok: true, event_id: id, unlinked: sessionId }
        })
        if (action === 'notes_get') return safe(async () => {
          const event = await json(runtime, `/api/calendar/events/${encodeURIComponent(id)}`)
          return { ok: true, event_id: id, notes: event.notes || '', version: event.notes_version ?? 0 }
        })
        if (action === 'notes_set') return safe(async () => {
          if (args.version === undefined || args.version === null) return { ok: false, code: 'missing_version', message: 'Read the event notes first and pass the returned version.' }
          const value = await patch(runtime, `/api/calendar/events/${encodeURIComponent(id)}/notes`, { notes: String(args.notes ?? ''), version: Number(args.version) })
          return { ok: true, event_id: id, version: value.notes_version }
        })
        if (action === 'quote') return safe(async () => {
          const sessionId = requireString(args.session_id, 'session_id')
          const text = requireString(args.text, 'text')
          const event = await json(runtime, `/api/calendar/events/${encodeURIComponent(id)}`)
          const value = await post(runtime, `/api/calendar/events/${encodeURIComponent(id)}/quotes`, {
            session_id: sessionId,
            start: Number(args.quote_start) || 0,
            text,
            version: event.notes_version ?? 0
          })
          return { ok: true, event_id: id, notes_version: value.notes_version, quotes: (value.quotes || []).length }
        })
        if (action === 'export') return safe(async () => {
          const value = await json(runtime, `/api/calendar/events/${encodeURIComponent(id)}/export`)
          const markdown = String(value.markdown || '')
          return { ok: true, event_id: id, markdown: markdown.length > 20_000 ? markdown.slice(0, 20_000) : markdown, truncated: markdown.length > 20_000 }
        })
        return { ok: false, code: 'bad_action', message: `Unsupported action: ${action}` }
      }
    })
  ]
}

function definition(input) {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    isConcurrencySafe: () => input.name === 'meetclip_status' || input.name === 'meetclip_search' || input.name === 'meetclip_settings',
    timeoutMs: input.name === 'meetclip_capture' ? 120_000 : 60_000,
    execute: async (args, exec) => input.execute(args || {}, exec)
  }
}

async function statusPayload(runtime, ctx) {
  const status = await runtime.status()
  return {
    ok: true,
    version: status.version,
    backend: status.backend,
    cards: status.cards,
    env: { ready: status.env.ready, mlx: status.env.mlx, version: status.env.version, job: status.env.job?.state || null },
    locations: status.locations,
    // 多资料空间：只有激活的那个能被检索；别的空间要用界面切换后才看得到。
    library: status.library,
    libraries: (status.libraries || []).map((row) => ({
      id: row.id, name: row.name, active: Boolean(row.active), exists: Boolean(row.exists), records: row.records
    })),
    sharedDir: status.sharedDir || null,
    workspace: await workspaceStatus(ctx, runtime.settings.dataDir),
    tools: ['meetclip_status', 'meetclip_records', 'meetclip_search', 'meetclip_capture', 'meetclip_marks',
            'meetclip_notes', 'meetclip_minutes', 'meetclip_calendar', 'meetclip_settings']
  }
}

async function recordsList(runtime, args) {
  return safe(async () => {
    const rows = await json(runtime, '/api/sessions')
    const limit = clampInt(args.limit, 40, 1, MAX_LIST)
    const items = (rows || []).slice(0, limit).map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind || 'live',
      status: row.status,
      created_at: row.created_at,
      started_at: row.started_at,
      duration: row.duration,
      transcripts: row.transcripts,
      marks: row.marks,
      screenshots: row.screenshots,
      queue_position: row.queue_position,
      queue_paused: row.queue_paused
    }))
    return { ok: true, total: rows.length, returned: items.length, has_more: rows.length > items.length, records: items }
  })
}

async function recordGet(runtime, id) {
  return safe(async () => {
    const detail = await json(runtime, `/api/sessions/${encodeURIComponent(id)}`)
    const first = transcriptPage(detail, 0, 12)
    return {
      ok: true,
      record: summary(detail),
      transcript_preview: first.rows,
      transcript_total: first.total,
      transcript_has_more: first.has_more,
      next: first.has_more ? 'Call meetclip_records action=transcript with offset for more.' : undefined
    }
  })
}

async function recordTranscript(runtime, id, args) {
  return safe(async () => {
    const detail = await json(runtime, `/api/sessions/${encodeURIComponent(id)}`)
    const offset = clampInt(args.offset, 0, 0, 1_000_000)
    const limit = clampInt(args.limit, 80, 1, MAX_TRANSCRIPT_ROWS)
    const page = transcriptPage(detail, offset, limit)
    return {
      ok: true,
      session_id: id,
      total: page.total,
      offset,
      returned: page.rows.length,
      has_more: page.has_more,
      next_offset: page.has_more ? offset + page.rows.length : null,
      truncated: page.truncated,
      rows: page.rows
    }
  })
}

async function recordSearch(runtime, id, args) {
  return safe(async () => {
    const query = requireString(args.query, 'query')
    const rows = await json(runtime, `/api/sessions/${encodeURIComponent(id)}/search?q=${encodeURIComponent(query)}`)
    return {
      ok: true,
      session_id: id,
      total: rows?.length ?? 0,
      results: (rows || []).slice(0, 50).map((row) => ({ kind: row.kind, id: row.id, ts: row.ts, text: String(row.text || '').slice(0, 500) }))
    }
  })
}

async function recordRename(runtime, id, args) {
  return safe(async () => {
    const title = requireString(args.title, 'title')
    const value = await patch(runtime, `/api/sessions/${encodeURIComponent(id)}`, { title })
    return { ok: true, session_id: id, title: value.title }
  })
}

async function recordRetranscribe(runtime, id, args) {
  return safe(async () => {
    const payload = {}
    if (args.asr_provider) payload.asr_provider = String(args.asr_provider)
    const result = await post(runtime, `/api/sessions/${encodeURIComponent(id)}/retranscribe`, payload)
    return { ok: true, session_id: id, queued: true, queue_position: result?.queue_position ?? null, message: 'Retranscription queued; previous text is kept until the new run succeeds.' }
  })
}

async function recordCancel(runtime, id) {
  return safe(async () => {
    const detail = await json(runtime, `/api/sessions/${encodeURIComponent(id)}`)
    if (detail.kind === 'link_video') {
      await post(runtime, `/api/link-videos/${encodeURIComponent(id)}/cancel`, {})
    } else {
      await post(runtime, `/api/sessions/${encodeURIComponent(id)}/cancel`, {})
    }
    return { ok: true, session_id: id, cancelled: true }
  })
}

async function recordExport(runtime, id, zip) {
  return safe(async () => {
    const result = await json(runtime, `/api/sessions/${encodeURIComponent(id)}/export`)
    if (zip) return { ok: true, session_id: id, zip_path: result.zip }
    const markdown = String(result.markdown || '')
    return {
      ok: true,
      session_id: id,
      markdown: markdown.length > 20_000 ? markdown.slice(0, 20_000) : markdown,
      truncated: markdown.length > 20_000,
      zip_path: result.zip
    }
  })
}

async function startLive(runtime, args) {
  return safe(async () => {
    const url = requireString(args.url, 'url')
    const created = await post(runtime, '/api/sessions', { url, title: args.title ? String(args.title) : '' })
    try {
      const started = await post(runtime, `/api/sessions/${encodeURIComponent(created.id)}/start`, {})
      return { ok: true, session_id: created.id, title: created.title, queued: true, queue_position: started?.queue_position ?? null }
    } catch (error) {
      return {
        ok: false,
        session_id: created.id,
        code: error?.code || 'start_failed',
        message: String(error?.message || error),
        hint: 'The record exists but capture did not start; stop it or retry from the MeetClip page.'
      }
    }
  })
}

async function addLinks(runtime, args) {
  return safe(async () => {
    const urls = Array.isArray(args.urls) ? args.urls : []
    if (urls.length === 0) return { ok: false, code: 'missing_argument', message: 'urls must contain at least one link' }
    if (urls.length > 20) return { ok: false, code: 'too_many', message: 'At most 20 links at a time' }
    const items = urls.map((url) => ({
      url: String(url),
      transcription_mode: args.transcription_mode === 'asr' ? 'asr' : 'auto',
      subtitle_track_id: args.subtitle_track_id ? String(args.subtitle_track_id) : null
    }))
    const body = { items }
    const result = await post(runtime, '/api/link-videos/batch', body)
    return {
      ok: Boolean(result?.ok),
      results: (result?.results || []).map((row) => ({
        ok: row.ok, id: row.id, url: row.url, title: row.title, duplicate: row.duplicate, message: row.message
      }))
    }
  })
}

async function importMeeting(runtime, args) {
  return safe(async () => {
    const rawPath = requireString(args.path, 'path')
    const target = path.resolve(rawPath)
    const roots = [path.resolve(runtime.settings.uploadDir), path.resolve(runtime.settings.dataDir)]
    const allowed = roots.some((root) => target === root || target.startsWith(root + path.sep))
    if (!allowed) return { ok: false, code: 'path_not_allowed', message: 'import_meeting only accepts files under MeetClip uploads or data.' }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, code: 'missing_file', message: 'File not found' }
    if (fs.statSync(target).size > 8 * 1024 ** 3) return { ok: false, code: 'too_large', message: 'File exceeds 8 GB' }
    const body = {
      path: target,
      title: args.title ? String(args.title) : '',
      language: args.language ? String(args.language) : '',
      hotwords: args.hotwords ? String(args.hotwords) : ''
    }
    const result = await post(runtime, '/api/meetings/import', body)
    return { ok: true, session_id: result.id, queued: true, queue_position: result.queue_position ?? null }
  })
}

async function stopRecord(runtime, args) {
  return safe(async () => {
    const id = requireString(args.session_id, 'session_id')
    await post(runtime, `/api/sessions/${encodeURIComponent(id)}/stop`, {})
    return { ok: true, session_id: id, stopping: true, note: 'Saved media is kept; processing may continue separately.' }
  })
}

async function cancelTask(runtime, args) {
  return safe(async () => {
    const id = requireString(args.session_id, 'session_id')
    const detail = await json(runtime, `/api/sessions/${encodeURIComponent(id)}`)
    if (detail.kind === 'link_video') {
      await post(runtime, `/api/link-videos/${encodeURIComponent(id)}/cancel`, {})
    } else {
      await post(runtime, `/api/sessions/${encodeURIComponent(id)}/cancel`, {})
    }
    return { ok: true, session_id: id, cancelled: true }
  })
}

async function queueStatus(runtime) {
  return safe(async () => {
    const rows = await json(runtime, '/api/sessions')
    const active = (rows || []).filter((row) => ['recording', 'processing', 'queued', 'pending'].includes(row.status))
    const queued = active.filter((row) => row.queue_position || row.status === 'queued')
    return {
      ok: true,
      active: active.map((row) => ({ id: row.id, title: row.title, status: row.status, queue_position: row.queue_position })),
      queued: queued.map((row) => ({ id: row.id, title: row.title, queue_position: row.queue_position })),
      paused: queued.some((row) => row.queue_paused)
    }
  })
}

function boundedMinutes(data, sessionId) {
  const clip = (text, size) => String(text || '').slice(0, size)
  const topics = (data?.topics || []).slice(0, 8).map((topic) => ({
    start: Number(topic.start) || 0,
    title: clip(topic.title, 120),
    summary: clip(topic.summary, 400),
    points: (topic.points || []).slice(0, 4).map((point) => ({
      text: clip(point.text, 240),
      t: point.t === null || point.t === undefined ? null : Number(point.t),
      support: Number(point.support) || 0
    })),
    fishbone: topic.fishbone?.branches?.length ? {
      question: clip(topic.fishbone.question, 200),
      branches: topic.fishbone.branches.slice(0, 5).map((branch) => ({
        label: clip(branch.label, 60),
        detail: clip(branch.detail, 200),
        t: branch.t === null || branch.t === undefined ? null : Number(branch.t),
        support: Number(branch.support) || 0
      }))
    } : null
  }))
  const items = (rows) => (rows || []).slice(0, 10).map((item) => ({
    text: clip(item.text, 300),
    owner: item.owner ? clip(item.owner, 60) : null,
    t: item.t === null || item.t === undefined ? null : Number(item.t),
    support: Number(item.support) || 0
  }))
  const interactions = data?.interactions || {}
  const doneKeys = new Set(Object.entries(interactions.todos || {})
    .filter(([, value]) => value && value.done !== false)
    .map(([key]) => key))
  const todoKey = (text) => String(text || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
    .replace(/[。．.!！?？,，;；:：、·\-—_~～…"'“”‘’()（）\[\]【】<>《》]+$/, '').slice(0, 120)
  const todoItems = items(data?.todos).map((item) => ({ ...item, done: doneKeys.has(todoKey(item.text)) }))
  const checkedTodos = Object.values(interactions.todos || {})
    .filter((value) => value && typeof value === 'object' && value.done)
    .map((value) => ({ text: clip(value.text, 300), at: value.at || null }))
  const highlights = (interactions.highlights || []).slice(0, 20).map((item) => ({
    quote: clip(item.quote, 300),
    t: item.t === null || item.t === undefined ? null : Number(item.t),
    section: clip(item.section, 40) || '',
    topic: clip(item.topic, 120) || '',
    at: item.at || null
  }))
  return {
    ok: Boolean(data && (data.summary || topics.length)),
    session_id: sessionId,
    scenario: data?.scenario || 'meeting',
    title: clip(data?.title, 120) || '',
    summary: clip(data?.summary, 800),
    state: data?.state || 'idle',
    state_text: data?.state_text || '',
    final: Boolean(data?.final),
    covered: Number(data?.covered) || 0,
    updated_at: data?.updated_at || null,
    topics,
    conclusions: items(data?.conclusions),
    todos: todoItems,
    user_interactions: {
      checked_todos: checkedTodos,
      highlights,
      counts: { todos: checkedTodos.length, highlights: highlights.length }
    },
    terms: (data?.terms || []).slice(0, 20).map((term) => ({
      name: clip(term.name, 80),
      note: clip(term.note, 160),
      heard: (term.heard || []).slice(0, 5).map((value) => clip(value, 80))
    }))
  }
}

function transcriptPage(detail, offset, limit) {
  const rows = Array.isArray(detail?.transcripts) ? detail.transcripts : []
  const speakers = detail?.speakers || {}
  const page = []
  let chars = 0
  let index = offset
  while (index < rows.length && page.length < limit && chars < MAX_TRANSCRIPT_CHARS) {
    const row = rows[index]
    const text = String(row.text || '')
    page.push({
      index,
      start: row.start,
      end: row.end,
      speaker: row.speaker ? (speakers[row.speaker] || row.speaker) : null,
      text
    })
    chars += text.length
    index += 1
  }
  return {
    rows: page,
    total: rows.length,
    has_more: index < rows.length,
    truncated: index < rows.length && page.length >= limit && chars >= MAX_TRANSCRIPT_CHARS
  }
}

function summary(detail) {
  return {
    id: detail.id,
    title: detail.title,
    kind: detail.kind || 'live',
    status: detail.status,
    duration: detail.duration,
    source_url: detail.source_url,
    created_at: detail.created_at,
    started_at: detail.started_at,
    transcripts: Array.isArray(detail.transcripts) ? detail.transcripts.length : 0,
    marks: Array.isArray(detail.marks) ? detail.marks.length : 0,
    screenshots: Array.isArray(detail.screenshots) ? detail.screenshots.length : 0,
    notes_version: detail.notes_version ?? 0,
    has_notes: Boolean(detail.notes),
    media_path: detail.media_path || null,
    queue_position: detail.queue_position ?? null
  }
}

async function calendarRange(runtime, args) {
  return safe(async () => {
    const now = Math.floor(Date.now() / 1000)
    const start = Number.isFinite(Number(args.start)) ? Number(args.start) : now - 30 * 86400
    const end = Number.isFinite(Number(args.end)) ? Number(args.end) : now + 30 * 86400
    if (end <= start) return { ok: false, code: 'bad_range', message: 'end must be after start' }
    const limit = clampInt(args.limit, 200, 1, 500)
    const value = await json(runtime, `/api/calendar/range?start=${start}&end=${end}`)
    const events = (value.events || []).slice(0, limit)
    return {
      ok: true,
      start,
      end,
      events: events.map(compactEvent),
      has_more: (value.events || []).length > events.length,
      unlinked_records: (value.records || []).slice(0, 50).map((row) => ({
        id: row.id, title: row.title, kind: row.kind, status: row.status, calendar_date: row.calendar_date
      }))
    }
  })
}

async function calendarGet(runtime, id) {
  return safe(async () => {
    const value = await json(runtime, `/api/calendar/events/${encodeURIComponent(id)}`)
    return {
      ok: true,
      event: compactEvent(value),
      records: (value.records || []).map((row) => ({ id: row.id, title: row.title, kind: row.kind, status: row.status })),
      quotes: (value.quotes || []).map((row) => ({ id: row.id, title: row.title, start: row.start, text: String(row.text || '').slice(0, 300), available: Boolean(row.available) })),
      notes: value.notes || '',
      notes_version: value.notes_version ?? 0
    }
  })
}

function eventBody(args, current = {}) {
  const title = String(args.title ?? current.title ?? '').trim()
  if (!title) { const error = new Error('title is required'); error.code = 'missing_argument'; throw error }
  const allDay = args.all_day === undefined ? Boolean(current.all_day) : args.all_day === true
  const startDate = String(args.start_date ?? current.start_date ?? '')
  const endDate = String(args.end_date ?? current.end_date ?? '')
  const start = Number(args.start ?? current.start)
  const end = Number(args.end ?? current.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    const error = new Error('start and end must be finite epoch seconds with end after start')
    error.code = 'bad_range'
    throw error
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    const error = new Error('start_date and end_date must be YYYY-MM-DD')
    error.code = 'bad_date'
    throw error
  }
  return {
    title,
    start,
    end,
    all_day: allDay,
    start_date: startDate,
    end_date: endDate,
    timezone: String(args.timezone ?? current.timezone ?? 'Asia/Shanghai'),
    location: String(args.location ?? current.location ?? ''),
    description: String(args.description ?? current.description ?? ''),
    cancelled: current.cancelled === true
  }
}

async function calendarCreate(runtime, args) {
  return safe(async () => {
    const body = eventBody(args)
    const value = await post(runtime, '/api/calendar/events', body)
    return { ok: true, event: compactEvent(value) }
  })
}

async function calendarUpdate(runtime, id, args) {
  return safe(async () => {
    const current = await json(runtime, `/api/calendar/events/${encodeURIComponent(id)}`)
    if (current.source !== 'local') return { ok: false, code: 'remote_read_only', message: 'Feishu events are read-only; edit them in Feishu.' }
    const body = eventBody(args, current)
    const value = await patch(runtime, `/api/calendar/events/${encodeURIComponent(id)}`, body)
    return { ok: true, event: compactEvent(value) }
  })
}

function compactEvent(event) {
  return {
    id: event.id,
    title: event.title,
    source: event.source,
    start: event.start,
    end: event.end,
    all_day: Boolean(event.all_day),
    start_date: event.start_date,
    end_date: event.end_date,
    timezone: event.timezone,
    location: event.location || '',
    description: String(event.description || '').slice(0, 1000),
    cancelled: Boolean(event.cancelled),
    record_count: event.record_count ?? null,
    notes_version: event.notes_version ?? 0,
    response_status: event.response_status || null,
    is_recurring: Boolean(event.is_recurring)
  }
}

async function requireApproval(ctx, exec, toolName, reason) {
  const approval = ctx.get('approval')
  if (!approval || typeof approval.request !== 'function') {
    return { ok: false, code: 'approval_unavailable', message: 'This installation has no approval answerer; perform the action from the MeetClip page.' }
  }
  if (!exec?.agent) {
    return { ok: false, code: 'approval_unavailable', message: 'Deletion needs an interactive session; perform it from the MeetClip page.' }
  }
  try {
    const outcome = await approval.request({
      agent: exec.agent,
      toolName,
      reason,
      displayReason: { en: reason, zh: reason },
      signal: exec.signal
    })
    if (outcome === 'allowed-once') return null
    return { ok: false, code: 'not_approved', message: `The user did not approve this action (${outcome}).` }
  } catch (error) {
    return { ok: false, code: 'approval_failed', message: String(error?.message || error) }
  }
}

async function recordDelete(runtime, ctx, exec, args) {
  const id = requireString(args.session_id, 'session_id')
  const approval = await requireApproval(ctx, exec, 'meetclip_records', `Delete record ${id}`)
  if (approval) return approval
  return safe(async () => {
    await del(runtime, `/api/sessions/${encodeURIComponent(id)}`)
    return { ok: true, session_id: id, deleted: true }
  })
}

function compactMark(mark) {
  return { id: mark.id, ts: mark.ts, note: mark.note || '' }
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function stringField(description, required = false) {
  return { type: 'string', description }
}

function enumField(description, values, required = false) {
  return { type: 'string', description, enum: values }
}

function numberField(description) {
  return { type: 'number', description }
}

function booleanField(description) {
  return { type: 'boolean', description }
}

function arrayField(description, required = false) {
  return { type: 'array', description, items: { type: 'string' } }
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${name} is required`)
    error.code = 'missing_argument'
    error.status = 400
    throw error
  }
  return value.trim()
}

function number(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

async function json(runtime, pathname) {
  return runtime.backend.json(pathname)
}

async function post(runtime, pathname, body) {
  return runtime.backend.json(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  })
}

async function patch(runtime, pathname, body) {
  return runtime.backend.json(pathname, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  })
}

async function del(runtime, pathname) {
  return runtime.backend.json(pathname, { method: 'DELETE' })
}

async function safe(operation) {
  try {
    return await operation()
  } catch (error) {
    const status = error?.status
    const missing = status === 404 || /not found|不存在|没有找到/i.test(String(error?.message || ''))
    return {
      ok: false,
      code: error?.code || 'error',
      message: String(error?.message || error),
      status,
      // 多资料空间下「找不到」常见于记录在另一个空间里，给出可执行的下一步。
      hint: missing ? MISSING_RECORD_HINT : undefined
    }
  }
}
