/**
 * dsh-knowledge-base — Host half.
 *
 * The knowledge base is a directory of Markdown documents, one per task
 * (`<workspace>/knowledge-base/<任务名>.md`). It exists so that a different
 * model can pick a task up later: every document carries the task goal, the
 * operating rules, the method, the permission boundaries, the name → path
 * mappings and the current state. It is deliberately separate from any
 * execution record (`README.dsh.md`, logs, transcripts): the knowledge base
 * holds distilled knowledge, never a running log of what was done.
 *
 * Three Host responsibilities:
 *
 * 1. A `sessionProjections` unit folds committed Session events into the
 *    current task and its document. The model's own `knowledge_base` tool calls
 *    are in the log, so the view is reconstructable after a restart.
 * 2. A `knowledge_base` tool reads and writes documents. The model supplies the
 *    distilled sections; the plugin owns the file layout, the naming rule, the
 *    index and the automatic conversation journal.
 * 3. After every finished turn the document is re-rendered from the projection
 *    (new journal entries, refreshed header) and `index.md` is rewritten, so a
 *    conversation is captured even when the model never called the tool.
 *
 * Sections the model did not supply are taken from the document already on
 * disk, so a hand-written or earlier-model document is never silently emptied.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_CONFIG = {
  /** Workspace-relative directory that holds one document per task. */
  dir: 'knowledge-base',
  /** Re-render the task document after every finished turn. */
  autoWrite: true,
  /** Inject the short knowledge-base instruction into the system prompt. */
  injectPrompt: true,
  /** How many turns the automatic journal keeps, newest last. */
  maxTurns: 60,
  /** Documents carried to the client view, newest first. */
  maxDocs: 40,
  /** Per-document character cap on the wire (the current task is served whole). */
  maxDocChars: 8000,
}

const TOOL_NAME = 'knowledge_base'
const KEY = 'knowledgeBase'

const STATUSES = ['进行中', '已完成', '受阻']

/** Section keys, headings, and how their items are rendered. */
const SECTIONS = [
  ['purpose', '1. 任务目的', 'bullet'],
  ['rules', '2. 操作规则', 'bullet'],
  ['methods', '3. 方法与流程', 'ordered'],
  ['boundaries', '4. 权限边界', 'bullet'],
  ['mappings', '5. 映射', 'bullet'],
  ['decisions', '6. 关键决策与结论', 'bullet'],
  ['next', '7. 当前状态与下一步', 'bullet'],
]

const JOURNAL_HEADING = '8. 对话纪要（自动生成）'

const STATUS_LABEL = {
  completed: '完成',
  running: '进行中',
  aborted: '已中止',
  blocked: '受阻',
  error: '出错',
  'max-tokens': '长度超限',
  interrupted: '已中断',
  forked: '已分叉',
}

const PROMPT = [
  '## 知识库',
  '',
  '本工作区用 `knowledge-base/<任务名>.md` 记录每个任务的知识（任务目的、操作规则、方法、权限边界、映射、当前状态），',
  '供换模型或新会话接手同一任务；执行流水账、Readme、日志都不属于知识库。',
  '',
  '- 理解任务后先用 `knowledge_base` 写一次骨架；关键决策、边界变化、阶段完成时再更新，只覆盖你传入的小节。',
  '- 每个任务一份文档，文件名就是任务名；不要用 write/edit 直接改知识库文件。',
  '- 第 7 节「当前状态与下一步」必须做到：任何模型读完就能接着干。',
].join('\n')

/** Doubles as a Zod-compatible schema when the real `zod` cannot be resolved. */
const passthrough = {
  parse(value) {
    return value
  },
  safeParse(value) {
    return { success: true, data: value }
  },
}

export const inject = ['tools', 'sessionProjections']

export async function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) }
  const maxTurns = Math.max(1, Number(cfg.maxTurns) || DEFAULT_CONFIG.maxTurns)
  const maxDocs = Math.max(1, Number(cfg.maxDocs) || DEFAULT_CONFIG.maxDocs)
  const maxDocChars = Math.max(1000, Number(cfg.maxDocChars) || DEFAULT_CONFIG.maxDocChars)
  const dirName = String(cfg.dir || DEFAULT_CONFIG.dir)
  const schema = await resolveSchema()

  if (cfg.injectPrompt !== false) {
    try {
      const prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
      if (prompt && typeof prompt.section === 'function') {
        prompt.section({ name: 'knowledge-base', order: 880, text: PROMPT })
      }
    } catch (error) {
      report(ctx, 'prompt section unavailable', error)
    }
  }

  /** session id → workspace directory, learned from live Session headers. */
  const cwdBySession = new Map()

  const taskOf = (state) => {
    if (!state) return ''
    if (state.task) return state.task
    const store = state.cwd ? peekStore(state.cwd, dirName) : null
    const known = store ? store.bySession.get(state.sid) : ''
    if (known) return known
    return deriveTaskName(state.turns.length > 0 ? state.turns[0].question : '')
  }

  const handle = await ctx.sessionProjections.register({
    key: KEY,
    stateSchema: schema,
    stateVersion: 1,
    init(header) {
      return {
        v: 1,
        sid: String(header.id || ''),
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        task: '',
        status: '进行中',
        taskSinceTurn: 0,
        updated: Number(header.createdAt) || 0,
        sections: emptySections(),
        turns: [],
      }
    },
    apply(state, event) {
      return fold(state, event, maxTurns)
    },
    wire: {
      viewSchema: schema,
      view(state) {
        const cwd = state.cwd || ''
        const store = cwd ? peekStore(cwd, dirName) : null
        const task = taskOf(state)
        const parsed = store && task ? store.docs.get(task) : null
        const live = task
          ? buildDoc(state, parsed && !parsed.foreign ? parsed : null, task, cwd)
          : null
        const markdown = live ? renderDoc(live) : ''
        const docs = []
        if (store) {
          for (const entry of store.docs.values()) {
            if (entry.task === task || entry.foreign) continue
            docs.push({
              task: entry.task,
              file: entry.file,
              status: entry.status,
              updatedAt: entry.updatedAt,
              purpose: entry.purpose,
              sources: entry.sources.length,
              current: false,
              markdown: clip(entry.markdown, maxDocChars),
            })
          }
        }
        if (live) {
          docs.unshift({
            task,
            file: fileNameFor(task),
            status: live.status,
            updatedAt: live.updatedAt,
            purpose: firstLine(live.sections.purpose),
            sources: live.sources.length,
            current: true,
            markdown,
          })
        }
        docs.sort((left, right) => Number(right.current) - Number(left.current) || right.updatedAt - left.updatedAt)
        return {
          v: 1,
          sid: state.sid,
          cwd,
          dir: dirName,
          task,
          file: task ? fileNameFor(task) : '',
          status: live ? live.status : '进行中',
          updatedAt: live ? live.updatedAt : state.updated,
          markdown,
          docs: docs.slice(0, maxDocs),
          total: docs.length,
          turns: state.turns.slice(-24).map(turn => ({
            turn: turn.turn,
            start: turn.start,
            end: turn.end,
            status: turn.status,
            question: turn.question,
            answer: turn.answer,
            keywords: turn.keywords,
            writes: turn.writes.slice(0, 8),
            tools: countTools(turn.tools).slice(0, 6),
            errors: turn.errors,
          })),
        }
      },
    },
  })

  const chains = new Map()

  /** Serialize writes per directory so two sessions cannot interleave a document. */
  const schedule = (session, state) => {
    if (cfg.autoWrite === false) return
    const header = session && session.header
    if (!header || header.origin === 'subagent') return
    const cwd = state.cwd || cwdOf(ctx, session)
    if (!cwd) return
    const id = String(session.id)
    const previous = chains.get(id) || Promise.resolve()
    const next = previous
      .then(() => persist(ctx, cwd, dirName, state))
      .catch(error => report(ctx, 'write failed', error))
    chains.set(id, next)
    next.then(() => {
      if (chains.get(id) === next) chains.delete(id)
    })
  }

  ctx.on('session/event', (session, event) => {
    if (!session || !event) return
    const header = session.header
    if (header && typeof header.cwd === 'string' && header.cwd) cwdBySession.set(String(session.id), header.cwd)
    if (event.type === 'turn/start') {
      const store = header && header.cwd ? storeFor(header.cwd, dirName) : null
      if (store) ensureScan(store, false).catch(error => report(ctx, 'scan failed', error))
      return
    }
    if (event.type !== 'turn/end') return
    const state = typeof handle.stateOf === 'function' ? handle.stateOf(session) : undefined
    if (state) schedule(session, state)
  })

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Read and maintain this workspace\'s task knowledge base: one Markdown document per task under `knowledge-base/`, holding the task goal, rules, method, permission boundaries, mappings and current state so any model can continue the task. '
      + 'A `write` replaces only the sections you pass and appends your note to the automatic conversation journal. '
      + 'Use it instead of editing those files directly; execution records (Readme, logs, transcripts) do not belong here.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'read', 'list'],
          description: 'write = create or update one task document; read = return one document; list = list every task document.',
        },
        task: {
          type: 'string',
          description: 'Task name, also the document file name (write requires it on the first call). Reuse the same name for the same task.',
        },
        status: {
          type: 'string',
          enum: STATUSES,
          description: 'Task status shown in the document header and the index.',
        },
        purpose: {
          type: 'array',
          items: { type: 'string' },
          description: 'Why the task exists and what outcome counts as done.',
        },
        rules: {
          type: 'array',
          items: { type: 'string' },
          description: 'Operating rules the next model must follow (must / must not), one per item.',
        },
        methods: {
          type: 'array',
          items: { type: 'string' },
          description: 'The working method as ordered steps.',
        },
        boundaries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Permission boundaries: allowed, forbidden, and needs-confirmation, one per item.',
        },
        mappings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Name → target mappings: paths and their purpose, tools and what they do, terms and their meaning.',
        },
        decisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Settled decisions and conclusions with their reason.',
        },
        next: {
          type: 'array',
          items: { type: 'string' },
          description: 'Current state and next steps — the handoff block a new model reads first.',
        },
        note: {
          type: 'string',
          description: 'One line describing this update; appended to the conversation journal.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'message'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          task: { type: 'string' },
          file: { type: 'string' },
          text: { type: 'string' },
          docs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['task', 'status', 'file', 'updated', 'purpose'],
              properties: {
                task: { type: 'string' },
                status: { type: 'string' },
                file: { type: 'string' },
                updated: { type: 'string' },
                purpose: { type: 'string' },
              },
            },
          },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        const text = value && typeof value.message === 'string' ? value.message : '知识库已更新'
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      return runTool(ctx, cfg, dirName, cwdBySession, args, exec)
    },
    presentCall(args) {
      const action = String((args && args.action) || 'write')
      const title = action === 'read' ? 'Read knowledge document' : action === 'list' ? 'List knowledge documents' : 'Update knowledge document'
      return { card: 'generic', title, kind: action === 'read' ? 'read' : 'edit', rawInput: args }
    },
  })
}

/** Real Zod when it resolves; a pass-through schema otherwise. */
async function resolveSchema() {
  try {
    const module = await import('zod')
    const z = module && (module.z || module.default)
    if (z && typeof z.unknown === 'function') return z.unknown()
  } catch {}
  return passthrough
}

function report(ctx, message, error) {
  try {
    const logger = ctx.logger || ctx.get('logger')
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[dsh-knowledge-base] ${message}`, error)
      return
    }
  } catch {}
  try {
    console.warn(`[dsh-knowledge-base] ${message}`, error)
  } catch {}
}

function cwdOf(ctx, session) {
  const header = session && session.header
  if (header && typeof header.cwd === 'string' && header.cwd) return header.cwd
  try {
    const service = ctx.get('workingDirectory')
    if (service && typeof service.get === 'function') {
      const value = service.get(session)
      if (value) return value
    }
    if (service && typeof service.defaultDirectory === 'string') return service.defaultDirectory
  } catch {}
  return ''
}

// ---------------------------------------------------------------------------
// Store: one in-memory snapshot of a knowledge-base directory per workspace
// ---------------------------------------------------------------------------

const stores = new Map()

function storeKey(cwd, dirName) {
  return `${String(cwd).toLowerCase()}|${String(dirName).toLowerCase()}`
}

function storeFor(cwd, dirName) {
  const key = storeKey(cwd, dirName)
  let store = stores.get(key)
  if (!store) {
    store = {
      dir: join(cwd, dirName),
      docs: new Map(),
      bySession: new Map(),
      rev: 0,
      scanning: null,
      scannedAt: 0,
    }
    stores.set(key, store)
  }
  return store
}

/** Read-only lookups during a projection view: never starts I/O. */
function peekStore(cwd, dirName) {
  return stores.get(storeKey(cwd, dirName)) || null
}

function ensureScan(store, force) {
  if (store.scanning) return store.scanning
  if (!force && store.scannedAt > 0 && Date.now() - store.scannedAt < 2000) return Promise.resolve()
  store.scanning = (async () => {
    const docs = new Map()
    const bySession = new Map()
    try {
      const entries = await readdir(store.dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
        if (/^(index|readme)\.md$/i.test(entry.name)) continue
        const text = await readFile(join(store.dir, entry.name), 'utf8').catch(() => '')
        if (!text) continue
        const parsed = parseDoc(text, entry.name)
        if (!parsed.task || docs.has(parsed.task)) continue
        docs.set(parsed.task, parsed)
        for (const sid of parsed.sources) bySession.set(sid, parsed.task)
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        store.scanning = null
        throw error
      }
    }
    store.docs = docs
    store.bySession = bySession
    store.rev += 1
    store.scannedAt = Date.now()
    store.scanning = null
  })()
  return store.scanning
}

async function persist(ctx, cwd, dirName, state) {
  const store = storeFor(cwd, dirName)
  await ensureScan(store, false).catch(() => {})
  const task = state.task || store.bySession.get(state.sid) || deriveTaskName(state.turns.length > 0 ? state.turns[0].question : '')
  if (!task) return
  const parsed = store.docs.get(task)
  if (parsed && parsed.foreign) return
  const doc = buildDoc(state, parsed || null, task, cwd)
  const text = renderDoc(doc)
  const file = fileNameFor(task)
  await mkdir(store.dir, { recursive: true })
  await writeFile(join(store.dir, file), text, 'utf8')
  const entry = parseDoc(text, file)
  store.docs.set(entry.task, entry)
  store.bySession.set(state.sid, entry.task)
  store.rev += 1
  await writeIndex(store)
}

async function writeIndex(store) {
  const entries = Array.from(store.docs.values())
    .filter(entry => !entry.foreign)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const lines = [
    '# 知识库索引',
    '',
    `> 每个任务一份文档，文件名就是任务名。共 ${entries.length} 个任务，更新于 ${fmtDateTime(Date.now())}。`,
    '> 换模型或新会话接手时，先打开对应任务文档的第 7 节。',
    '',
    '| 任务 | 状态 | 更新 | 来源会话数 | 文档 |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const entry of entries) {
    lines.push(`| ${entry.task} | ${entry.status} | ${fmtDateTime(entry.updatedAt)} | ${entry.sources.length} | \`${entry.file}\` |`)
  }
  lines.push('')
  await writeFile(join(store.dir, 'index.md'), lines.join('\n'), 'utf8')
}

// ---------------------------------------------------------------------------
// Document model: parse a Markdown document back into sections
// ---------------------------------------------------------------------------

function emptySections() {
  const sections = {}
  for (const [key] of SECTIONS) sections[key] = []
  return sections
}

export function parseDoc(text, file) {
  const source = String(text || '')
  const title = source.match(/^#\s*知识库\s*·\s*(.+)$/m)
  const task = title ? sanitizeTaskName(title[1]) : sanitizeTaskName(file.replace(/\.md$/i, ''))
  const parsed = {
    task,
    file: String(file || (task ? fileNameFor(task) : '')),
    status: '进行中',
    updatedAt: 0,
    sources: [],
    sections: emptySections(),
    journal: '',
    markdown: source,
    purpose: '',
    foreign: !title,
  }
  if (!title) return parsed

  const status = source.match(/状态：([^·\n]+)/)
  if (status) {
    const value = status[1].trim()
    if (STATUSES.includes(value)) parsed.status = value
  }
  const updated = source.match(/更新：(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
  if (updated) {
    parsed.updatedAt = new Date(
      Number(updated[1]),
      Number(updated[2]) - 1,
      Number(updated[3]),
      Number(updated[4]),
      Number(updated[5]),
    ).getTime()
  }
  const sources = source.match(/来源会话：([^\n]+)/)
  if (sources) {
    parsed.sources = sources[1]
      .split(/[、,，\s]+/)
      .map(value => value.trim())
      .filter(Boolean)
      .slice(0, 20)
  }

  const lines = source.split('\n')
  let current = ''
  let inJournal = false
  const journal = []
  for (const line of lines) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      const name = heading[1].trim()
      if (name.startsWith(JOURNAL_HEADING)) {
        inJournal = true
        current = ''
        continue
      }
      inJournal = false
      current = ''
      for (const [key, heading] of SECTIONS) {
        if (name === heading) {
          current = key
          break
        }
      }
      continue
    }
    if (inJournal) {
      journal.push(line)
      continue
    }
    if (!current) continue
    const trimmed = line.trim()
    if (!trimmed || trimmed === '- （待补充）') continue
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed)
    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed)
    const value = bullet ? bullet[1] : ordered ? ordered[1] : ''
    if (value) parsed.sections[current].push(value.trim())
  }
  parsed.journal = journal.join('\n').trim()
  parsed.purpose = firstLine(parsed.sections.purpose)
  return parsed
}

/** Merge: the live session supplies what it knows; the file keeps the rest. */
export function buildDoc(state, parsed, task, cwd) {
  const sections = emptySections()
  const live = state.sections || emptySections()
  for (const [key] of SECTIONS) {
    const fromSession = Array.isArray(live[key]) ? live[key] : []
    const stored = parsed && Array.isArray(parsed.sections[key]) ? parsed.sections[key] : []
    sections[key] = fromSession.length > 0 ? fromSession : stored
  }
  const sources = []
  for (const sid of [state.sid].concat(parsed ? parsed.sources : [])) {
    if (sid && !sources.includes(sid)) sources.push(sid)
  }
  const since = Number(state.taskSinceTurn) || 0
  const turns = state.turns.filter(turn => turn.turn >= since)
  return {
    task,
    cwd,
    status: state.status || (parsed && parsed.status) || '进行中',
    updatedAt: state.updated || (parsed && parsed.updatedAt) || Date.now(),
    sources,
    sections,
    turns,
    journal: parsed ? parsed.journal : '',
  }
}

export function renderDoc(doc, journalOverride) {
  const lines = []
  lines.push(`# 知识库 · ${doc.task}`, '')
  const sources = doc.sources.length > 0 ? ` · 来源会话：${doc.sources.join('、')}` : ''
  lines.push(`> 状态：${doc.status} · 更新：${fmtDateTime(doc.updatedAt)}${sources}`)
  lines.push(`> 工作区：\`${doc.cwd || '(未记录)'}\``)
  lines.push('> 用法：换模型或新会话接手同一任务时，先读第 7 节，再读第 2、4 节确认规则与边界；第 8 节由插件按对话自动维护。')
  lines.push('')

  for (const [key, title, kind] of SECTIONS) {
    lines.push(`## ${title}`, '')
    const items = Array.isArray(doc.sections[key]) ? doc.sections[key] : []
    if (items.length === 0) {
      lines.push('- （待补充）')
    } else if (kind === 'ordered') {
      for (let index = 0; index < items.length; index += 1) lines.push(`${index + 1}. ${items[index]}`)
    } else {
      for (const item of items) lines.push(`- ${item}`)
    }
    lines.push('')
  }

  lines.push(`## ${JOURNAL_HEADING}`, '')
  const turns = Array.isArray(doc.turns) ? doc.turns : []
  if (turns.length === 0) {
    const extra = typeof journalOverride === 'string' ? journalOverride.trim() : doc.journal
    lines.push(extra || '_本任务还没有对话记录。_', '')
  } else {
    let day = ''
    for (const turn of turns) {
      const stamp = turn.start || doc.updatedAt
      const currentDay = fmtDay(stamp)
      if (currentDay !== day) {
        day = currentDay
        lines.push(`### ${day}`, '')
      }
      const label = turn.keywords ? ` · ${turn.keywords}` : ''
      lines.push(`- **${fmtTime(turn.start || doc.updatedAt)} · 任务 ${turn.turn}${label} · ${statusLabel(turn.status)}**`)
      lines.push(`  - 问了什么：${turn.question || '（未记录到用户消息）'}`)
      lines.push(`  - 做了什么：${turn.answer || '（未记录到回答）'}`)
      if (turn.writes.length > 0) lines.push(`  - 改动：${turn.writes.slice(0, 8).map(path => `\`${path}\``).join('、')}`)
      else if (turn.files.length > 0) lines.push(`  - 读到：${turn.files.slice(0, 6).map(path => `\`${path}\``).join('、')}`)
      const tools = countTools(turn.tools)
      if (tools.length > 0) lines.push(`  - 工具：${tools.slice(0, 6).map(tool => `${tool.name}×${tool.count}`).join('、')}`)
      if (turn.errors > 0) lines.push(`  - 失败次数：${turn.errors}`)
      lines.push('')
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function runTool(ctx, cfg, dirName, cwdBySession, args, exec) {
  const input = args && typeof args === 'object' ? args : {}
  const action = String(input.action || 'write')
  const sid = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
  let cwd = (sid && cwdBySession.get(sid)) || ''
  if (!cwd) {
    try {
      const service = ctx.get('workingDirectory')
      if (service && typeof service.defaultDirectory === 'string') cwd = service.defaultDirectory
    } catch {}
  }
  if (!cwd) throw new Error('无法确定当前会话的工作区目录，知识库不可用')

  const store = storeFor(cwd, dirName)
  await ensureScan(store, true).catch(error => report(ctx, 'scan failed', error))

  if (action === 'list') {
    const docs = Array.from(store.docs.values())
      .filter(entry => !entry.foreign)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(entry => ({
        task: entry.task,
        status: entry.status,
        file: entry.file,
        updated: fmtDateTime(entry.updatedAt),
        purpose: entry.purpose || snap(entry.sections.purpose[0] || ''),
      }))
    const message = docs.length === 0
      ? `知识库目录 \`${join(cwd, dirName)}\` 里还没有任务文档。`
      : [`知识库共 ${docs.length} 个任务文档（\`${join(cwd, dirName)}\`）：`, ...docs.map(doc => `- ${doc.task} · ${doc.status} · ${doc.updated} · ${doc.purpose}`)].join('\n')
    return { ok: true, action, docs, message }
  }

  if (action === 'read') {
    const task = sanitizeTaskName(input.task) || store.bySession.get(sid) || ''
    if (!task) throw new Error('read 需要 task（任务名）')
    const entry = store.docs.get(task)
    if (!entry) throw new Error(`没有找到任务「${task}」的知识库文档；可先用 list 查看现有任务`)
    const file = entry.file
    const text = await readFile(join(store.dir, file), 'utf8').catch(() => entry.markdown)
    return {
      ok: true,
      action,
      task: entry.task,
      file,
      text: clip(text, 16000),
      message: clip(text, 16000),
    }
  }

  const task = sanitizeTaskName(input.task) || store.bySession.get(sid) || ''
  if (!task) throw new Error('write 需要 task（任务名），它会作为文档文件名')
  const parsed = store.docs.get(task)
  if (parsed && parsed.foreign) {
    throw new Error(`知识库文件 ${parsed.file} 不是本插件生成的文档，请改名或删除后再写入`)
  }

  const provided = readSections(input)
  const sections = emptySections()
  for (const [key] of SECTIONS) {
    const value = provided[key]
    const fallback = parsed && Array.isArray(parsed.sections[key]) ? parsed.sections[key] : []
    sections[key] = value.length > 0 ? value : fallback
  }
  const status = STATUSES.includes(input.status) ? input.status : (parsed && parsed.status) || '进行中'
  const sources = []
  for (const value of (parsed ? parsed.sources : []).concat([sid])) {
    if (value && !sources.includes(value)) sources.push(value)
  }
  const doc = {
    task,
    cwd,
    status,
    updatedAt: Date.now(),
    sources,
    sections,
    turns: [],
    journal: parsed ? parsed.journal : '',
  }
  const note = typeof input.note === 'string' ? snap(input.note, 240) : ''
  const journal = [doc.journal, note ? `- **${fmtDateTime(doc.updatedAt)} · 模型更新**：${note}` : '']
    .filter(Boolean)
    .join('\n')
  const text = renderDoc(doc, journal)
  const file = fileNameFor(task)
  await mkdir(store.dir, { recursive: true })
  await writeFile(join(store.dir, file), text, 'utf8')
  const entry = parseDoc(text, file)
  store.docs.set(entry.task, entry)
  store.bySession.set(sid, entry.task)
  store.rev += 1
  await writeIndex(store)

  const message = `知识库已写入：\`${join(cwd, dirName, file)}\`\n任务「${entry.task}」· 状态 ${status} · 目的 ${sections.purpose.length} 条 / 规则 ${sections.rules.length} 条 / 方法 ${sections.methods.length} 步 / 边界 ${sections.boundaries.length} 条 / 映射 ${sections.mappings.length} 条 / 决策 ${sections.decisions.length} 条 / 下一步 ${sections.next.length} 条${note ? `\n纪要：${note}` : ''}`
  return {
    ok: true,
    action,
    task: entry.task,
    file,
    message,
  }
}

function readSections(input) {
  const out = emptySections()
  for (const [key] of SECTIONS) {
    const value = input[key]
    if (typeof value === 'string') {
      const line = cleanLine(value)
      if (line) out[key] = [line]
      continue
    }
    if (!Array.isArray(value)) continue
    out[key] = value
      .slice(0, 24)
      .map(item => cleanLine(item))
      .filter(Boolean)
  }
  return out
}

function cleanLine(value) {
  const text = String(value == null ? '' : value)
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[-*]\s+/, '')
    .trim()
  return text.length > 400 ? `${text.slice(0, 399)}…` : text
}

// ---------------------------------------------------------------------------
// Fold: committed Session events → one record per Turn + the current task
// ---------------------------------------------------------------------------

export function fold(state, event, maxTurns) {
  const type = event && event.type
  if (typeof type !== 'string') return state
  const data = event.data || {}
  switch (type) {
    case 'turn/start':
      return openTurn(state, Number(data.turn) || 0, event.time, maxTurns)
    case 'user/message':
      return addQuestion(state, readText(data.content))
    case 'assistant/message':
      return addAnswer(state, readText(data.message && data.message.content))
    case 'tool/call':
      return onToolCall(state, data, event.time)
    case 'tool/result':
      return data.error ? bumpError(state) : state
    case 'turn/end':
      return closeTurn(state, Number(data.turn) || 0, event.time, data.reason)
    default:
      return state
  }
}

function openTurn(state, turn, time, maxTurns) {
  const turns = state.turns.concat([{
    turn,
    start: Number(time) || 0,
    end: 0,
    status: 'running',
    question: '',
    keywords: '',
    answer: '',
    tools: [],
    files: [],
    writes: [],
    errors: 0,
  }])
  const trimmed = turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns
  return { ...state, turns: trimmed }
}

function lastOpenIndex(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].status === 'running') return index
  }
  return -1
}

function replaceTurn(state, index, patch) {
  const turns = state.turns.slice()
  turns[index] = { ...turns[index], ...patch }
  return { ...state, turns }
}

function addQuestion(state, text) {
  const index = lastOpenIndex(state.turns)
  const question = snap(text, 300)
  if (index < 0 || !question) return state
  if (state.turns[index].question) return state
  return replaceTurn(state, index, { question, keywords: labelFor(question) })
}

function addAnswer(state, text) {
  const index = lastOpenIndex(state.turns)
  if (index < 0) return state
  const answer = snap(text, 500)
  if (!answer) return state
  return replaceTurn(state, index, { answer })
}

function onToolCall(state, data, time) {
  if (!data || data.name !== TOOL_NAME) return state
  let args
  try {
    args = JSON.parse(String(data.arguments || ''))
  } catch {
    return state
  }
  if (!args || typeof args !== 'object' || args.action !== 'write') return state
  const task = sanitizeTaskName(args.task)
  const changed = task && task !== state.task
  const sections = changed ? emptySections() : { ...state.sections }
  const provided = readSections(args)
  for (const [key] of SECTIONS) {
    if (provided[key].length > 0) sections[key] = provided[key]
  }
  const patch = { sections, updated: Number(time) || state.updated }
  if (task) patch.task = task
  if (STATUSES.includes(args.status)) patch.status = args.status
  if (changed) patch.taskSinceTurn = state.turns.length > 0 ? state.turns[state.turns.length - 1].turn : 0
  return { ...state, ...patch }
}

function bumpError(state) {
  const index = lastOpenIndex(state.turns)
  if (index < 0) return state
  return replaceTurn(state, index, { errors: state.turns[index].errors + 1 })
}

function closeTurn(state, turn, time, reason) {
  let index = -1
  for (let cursor = state.turns.length - 1; cursor >= 0; cursor -= 1) {
    if (state.turns[cursor].turn === turn) {
      index = cursor
      break
    }
  }
  if (index < 0) return state
  const status = reason && typeof reason.kind === 'string' ? reason.kind : 'completed'
  const next = replaceTurn(state, index, { end: Number(time) || 0, status })
  return { ...next, updated: Number(time) || next.updated }
}

// ---------------------------------------------------------------------------
// Event payload helpers
// ---------------------------------------------------------------------------

function readText(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function snap(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

function clip(text, max) {
  const value = String(text || '')
  return value.length > max ? `${value.slice(0, max)}\n\n…（已截断，共 ${value.length} 字符）` : value
}

function firstLine(items) {
  const value = Array.isArray(items) ? items.find(item => item && item.trim()) : ''
  return value ? snap(value, 90) : ''
}

function countTools(tools) {
  const counts = new Map()
  for (const name of tools || []) counts.set(name, (counts.get(name) || 0) + 1)
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

function statusLabel(status) {
  return STATUS_LABEL[status] || status || '未知'
}

function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

function fmtDateTime(time) {
  const date = new Date(Number(time) || Date.now())
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function fmtDay(time) {
  const date = new Date(Number(time) || Date.now())
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function fmtTime(time) {
  const date = new Date(Number(time) || Date.now())
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

// ---------------------------------------------------------------------------
// Task naming: one document per task, named by the task
// ---------------------------------------------------------------------------

const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'])

/**
 * A task name doubles as the document file name, so it must be one safe path
 * segment. Separators, Windows-reserved characters, and trailing dots go away.
 */
export function sanitizeTaskName(input) {
  let name = String(input == null ? '' : input)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (name.length > 48) name = name.slice(0, 48).trim()
  if (!name) return ''
  if (RESERVED.has(name.toUpperCase())) name = `${name}_任务`
  return name
}

export function fileNameFor(task) {
  const name = sanitizeTaskName(task) || '未命名任务'
  return `${name}.md`
}

const FILLERS = [
  '我想要', '我觉得', '我认为', '我需要', '我希望', '最好能', '最好是', '我想', '我要',
  '帮我', '帮忙', '请你', '请帮', '麻烦你', '麻烦', '能否', '能不能', '可以帮', '给我',
  '咱们', '我们', '现在', '目前', '另外', '然后', '接着', '顺便', '这个', '那个', '这些', '那些',
  '就是', '请', '你', '我', '再', '在', '把', '将', '给', '对', '向', '从', '用', '和', '跟',
]

const QUANTIFIERS = ['一下', '一个', '一些', '一份', '一套', '个', '份', '套', '下', '条', '种']

const ACTIONS = [
  '创建', '新建', '制作', '实现', '开发', '增加', '新增', '添加', '修复', '修改', '改成', '改为',
  '删除', '移除', '重构', '优化', '调整', '升级', '安装', '配置', '迁移', '测试', '检查', '编写',
  '生成', '导出', '导入', '整理', '清理', '排查', '部署', '接入', '替换', '合并', '拆分', '补充',
  '完善', '支持', '分析', '比较', '对比', '解释', '说明', '转换', '打包', '发布', '运行', '调试',
  '验证', '设计', '规划', '梳理', '写', '做',
]

const PREAMBLE = /^(the approval policy|time sampled|elapsed since|current runtime context|current dsh|current deepseek|approval prompts|browser time zone|you are an ai agent|tokens prefixed with)/i
const EDGE_NOISE = /^[\s，,。.：:、；;！!？?~～\-—'"“”‘’`*#]+/
const CJK = /^[\u4e00-\u9fa5]+$/

/** Deterministic verb + object label used when the model has not named the task. */
export function deriveTaskName(text) {
  const raw = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .filter(line => !PREAMBLE.test(line.trim()))
    .join('\n')
    .trim()
  if (!raw) return ''
  let value = raw.slice(0, 200)
  for (let guard = 0; guard < 6; guard += 1) {
    const trimmed = value.replace(EDGE_NOISE, '')
    const filler = FILLERS.find(item => trimmed.startsWith(item))
    const next = filler ? trimmed.slice(filler.length) : trimmed
    if (next === trimmed) {
      value = trimmed
      break
    }
    value = next
  }
  value = value.replace(EDGE_NOISE, '')

  let action = ''
  for (const word of ACTIONS) {
    if (value.startsWith(word)) {
      action = word
      value = value.slice(word.length).replace(EDGE_NOISE, '')
      break
    }
  }
  for (let guard = 0; guard < 3; guard += 1) {
    const quantifier = QUANTIFIERS.find(item => value.startsWith(item))
    if (!quantifier) break
    value = value.slice(quantifier.length).replace(EDGE_NOISE, '')
  }
  value = value.replace(/^的/u, '')

  const tokens = (value.match(/[A-Za-z][A-Za-z0-9_.+#-]*|[\u4e00-\u9fa5]+/g) || [])
  const chinese = tokens.filter(token => CJK.test(token) && token.length >= 2)
    .map(token => token.split(/[的了是在时，、：:；;]/u)[0].replace(/[上中里]$/u, ''))
    .filter(token => token.length >= 2 && token.length <= 8)
  const latin = tokens.filter(token => /^[A-Za-z][A-Za-z0-9_.+#-]*$/.test(token) && token.length >= 2)

  const object = chinese[0] || latin.slice(0, 2).join(' ') || ''
  const label = [action, object].filter(Boolean).join('')
  const fallback = action || object || value.replace(EDGE_NOISE, '').slice(0, 8)
  return sanitizeTaskName(label || fallback).slice(0, 20)
}

/** Short keyword label for one turn, so a journal line reads at a glance. */
function labelFor(question) {
  const derived = deriveTaskName(question)
  return derived.length > 0 && derived.length <= 20 ? derived : snap(question, 18)
}
