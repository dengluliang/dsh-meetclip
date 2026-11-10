import { jsonResponse, requireBrowser } from './src/host/http.js'
import { registerAppRoutes } from './src/host/routes.js'
import { MeetClipRuntime } from './src/host/runtime.js'
import { registerTools } from './src/host/tools.js'
import { registerSkills } from './src/host/skills.js'

export const inject = ['webServer']

export function apply(ctx, rawConfig) {
  const runtime = new MeetClipRuntime(rawConfig)

  ctx.effect(() => () => {
    runtime.dispose().catch(() => {})
  })

  registerAppRoutes(ctx, runtime)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/meetclip/api',
    handler: async (req, res) => {
      const rejection = requireBrowser(ctx, req)
      if (rejection) {
        jsonResponse(res, rejection, { detail: rejection === 401 ? '本地页面会话无效' : '请求来源不被信任' })
        return
      }
      await runtime.backend.forward(req, res)
    }
  }))

  registerTools(ctx, runtime)
  registerSkills(ctx)

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'meetclip',
      order: 120,
      text: [
        'MeetClip is the user\'s local library of captured live streams, video links and meeting recordings, with timestamped transcripts, screenshots, marks, notes and calendar links.',
        'Use the meetclip_* tools to search it, read bounded transcript pages and perform the requested work.',
        'A queued task is not a finished record: report progress and identifiers, and read the record before claiming completion.',
        'Read notes before replacing them, because note writes need the current version. Destructive or cost-incurring actions require explicit user intent.',
        'AI minutes carry user interactions: a to-do with done=true was checked off by the user, and user_interactions lists the to-dos they completed plus the exact text they highlighted (with section/topic and time). Treat these as explicit user feedback: do not silently undo them, and prefer the user-highlighted passages when answering.',
        'When the user @-mentions a file under 会摘卡片/, read that file before answering. A card is either the digest of one MeetClip record (metadata, AI minutes, notes, marks and a bounded transcript preview, with a session_id for deeper meetclip_* calls), a registered Feishu document card (URL, document_id and a bounded text snapshot, with no session_id), a pack card listing the cards collected in a pack (member ids and types, but not one session_id), or a sticky-note / highlight / image / batch card that is itself the context. For a Feishu document card, use mcp__feishu__doc_read or mcp__feishu__doc_fetch when the snapshot is truncated or the latest revision matters; never look for a session_id there. For a pack card, read its member list and fetch individual members with meetclip_* tools when needed. Multiple cards may be @-mentioned; read each one.',
        'MeetClip may hold several libraries (for example work and life). Only the one shown as active by meetclip_status is searchable: never guess or invent records from another library, and when an id is missing tell the user it may live in another library and that switching happens in the MeetClip header.'
      ].join(' ')
    }))
  }

  runtime.cards.start()
  if (runtime.settings.autoStart) {
    runtime.backend.ensure()
      .then(() => runtime.cards.sync())
      .catch(() => {})
  }
}
