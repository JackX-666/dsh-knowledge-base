// Offline self-check for dsh-knowledge-base — no browser, no DSH instance needed.
//
//   node scripts/verify.mjs
//
// Covers: the client module factory, the conversation.view registration and label,
// a full render of the knowledge view, Path-safety of task names, the Session-log
// fold, document rendering and re-parsing, section merge retention, and foreign-file
// protection.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok   ${name}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// --- minimal React so the component can run outside the browser ------------
function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity) }
}
const react = {
  createElement,
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: effect => {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  },
  useMemo: factory => factory(),
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
}

// --- load the client half ---------------------------------------------------
let handoff = null
const fakeWindow = { __ModuleLoader__: { load: value => { handoff = value } } }
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
new Function('window', clientSource)(fakeWindow)
check('client registers a module factory', handoff && handoff.id === 'dsh-knowledge-base', String(handoff && handoff.id))

let registration = null
const plugin = handoff.factory(spec => {
  if (spec === 'react') return react
  throw new Error(`unexpected require(${spec})`)
})
check('client exports inject+apply', Array.isArray(plugin.inject) && plugin.inject.includes('slots') && typeof plugin.apply === 'function')

const ctx = {
  get: name => (name === 'locale' ? { getLocale: () => ({ id: 'zh' }) } : undefined),
  slots: {
    inject: (owner, callback) => callback(),
    register: (options, component) => {
      registration = { options, component }
    },
  },
}
plugin.apply(ctx)
check(
  'registers the Knowledge tab in conversation.view',
  registration && registration.options.name === 'conversation.view' && registration.options.id === 'knowledge-base' && registration.options.order === 30,
)
check('tab label is localized', registration.options.label() === '知识库')

// --- Host half --------------------------------------------------------------
const host = await import(pathToFileURL(join(root, 'index.js')).href)
check('host exports apply/inject', typeof host.apply === 'function' && host.inject.includes('tools') && host.inject.includes('sessionProjections'))
check('task names are path safe', host.sanitizeTaskName('a/b:c*?') === 'a b c' && host.sanitizeTaskName('CON') === 'CON_任务')
check('document name is the task name', host.fileNameFor('制作知识库插件') === '制作知识库插件.md')

// A committed Session log must fold into the very document the tool wrote.
const T0 = Date.parse('2026-11-10T10:00:00+08:00')
const sections = { purpose: [], rules: [], methods: [], boundaries: [], mappings: [], decisions: [], next: [] }
let state = { v: 1, sid: 's1', cwd: 'C:\\work', task: '', status: '进行中', taskSinceTurn: 0, updated: 0, sections, turns: [] }
const events = [
  { type: 'turn/start', data: { turn: 1 }, time: T0 },
  { type: 'user/message', data: { content: [{ type: 'text', text: '帮我做一个知识库插件' }] }, time: T0 },
  {
    type: 'tool/call',
    data: {
      turn: 1, step: 1, callId: 'c1', name: 'knowledge_base',
      arguments: JSON.stringify({
        action: 'write', task: '制作插件', status: '进行中',
        purpose: ['做一个插件'], rules: ['必须A', '禁止B'], methods: ['第一步', '第二步'],
        boundaries: ['可做X'], mappings: ['路径 → 用途'], decisions: ['决定Y'], next: ['下一步Z'], note: '首次写入',
      }),
    },
    time: T0 + 1000,
  },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '插件做好了。' }] } }, time: T0 + 2000 },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 3000 },
]
for (const event of events) state = host.fold(state, event, 60)
check('fold picks up the tool task name', state.task === '制作插件', state.task)
check('fold keeps every supplied section', state.sections.rules.length === 2 && state.sections.methods.length === 2 && state.sections.mappings[0] === '路径 → 用途')
check('fold records the turn', state.turns.length === 1 && state.turns[0].status === 'completed' && state.turns[0].question.includes('知识库插件'))

const markdown = host.renderDoc(host.buildDoc(state, null, '制作插件', 'C:\\work'))
const reparse = host.parseDoc(markdown, '制作插件.md')
check('rendered document reparses to the same task', reparse.task === '制作插件' && reparse.foreign === false)
check('rendered document reparses every section', reparse.sections.rules.length === 2 && reparse.sections.next[0] === '下一步Z')
check('rendered document carries the automatic journal', reparse.journal.includes('问了什么') && reparse.journal.includes('做了什么'))
check('rendered document carries the header fields', reparse.sources.includes('s1') && reparse.updatedAt > 0 && reparse.status === '进行中')

// A section the model did not send must survive from the file.
const merged = host.buildDoc({ ...state, sections: { ...sections, rules: [] } }, reparse, '制作插件', 'C:\\work')
check('merge keeps stored sections the session does not supply', merged.sections.rules.length === 2)

// A foreign Markdown file in the knowledge directory is never rewritten.
const foreign = host.parseDoc('# 随手记\n\n- 一些别的内容\n', '随手记.md')
check('foreign documents are flagged', foreign.foreign === true && foreign.task === '随手记')

// --- the view renders one document -----------------------------------------
const view = {
  v: 1,
  sid: state.sid,
  cwd: state.cwd,
  dir: 'knowledge-base',
  task: '制作插件',
  file: '制作插件.md',
  status: '进行中',
  updatedAt: Date.parse('2026-11-10T10:03:00+08:00'),
  markdown,
  total: 1,
  docs: [{
    task: '制作插件',
    file: '制作插件.md',
    status: '进行中',
    updatedAt: Date.parse('2026-11-10T10:03:00+08:00'),
    purpose: '做一个插件',
    sources: 1,
    current: true,
    markdown,
  }],
  turns: [{ turn: 1, start: T0, status: 'completed', question: '帮我做一个知识库插件', answer: '插件做好了。', keywords: '制作插件', writes: [], tools: [], errors: 0 }],
}

let tree
try {
  tree = registration.component({
    useProjection: key => (key === 'knowledgeBase' ? view : undefined),
    sessionId: 's1',
  })
  check('view renders', Boolean(tree))
} catch (error) {
  check('view renders', false, error && error.message)
}

const texts = []
const classes = new Set()
const walk = node => {
  if (node == null || node === false) return
  if (Array.isArray(node)) return node.forEach(walk)
  if (typeof node === 'string' || typeof node === 'number') {
    texts.push(String(node))
    return
  }
  if (typeof node === 'object' && node.type) {
    if (node.props && typeof node.props.className === 'string') classes.add(node.props.className)
    walk(node.children)
  }
}
walk(tree)
const flat = texts.join('\n')
check('renders the document title', flat.includes('知识库 · 制作插件'))
check('renders the boundary section', flat.includes('4. 权限边界'))
check('renders the mapping row text', flat.includes('路径 → 用途'))
check('renders the task list row', flat.includes('本会话'))
check('no literal markdown headings leaked', !flat.includes('## 1. 任务目的'))
check('uses the plugin class prefix', [...classes].every(name => name.startsWith('dsh-kb')))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
