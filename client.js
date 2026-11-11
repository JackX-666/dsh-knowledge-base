/**
 * dsh-knowledge-base — browser half.
 *
 * Registers one `conversation.view` entry, so the knowledge base appears as a
 * tab beside Chat, Trajectory and Readme. The whole payload comes from the Host
 * projection (`useProjection('knowledgeBase')`): the tab never folds Session
 * events itself and never touches the file system.
 *
 * Left pane: one row per task document (task name, one-line purpose, status).
 * Right pane: the selected document rendered as light Markdown.
 */
window.__ModuleLoader__.load({
  id: 'dsh-knowledge-base',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PROJECTION_KEY = 'knowledgeBase'
    const CLASS = 'dsh-kb'
    const REFRESH_MS = 8000

    const DICT = {
      en: {
        tab: 'Knowledge',
        title: 'Knowledge base',
        subtitle: 'One document per task · shared across models',
        updated: 'updated',
        empty:
          'No knowledge document yet. Finish one turn and the plugin writes this task\'s document here; when the model calls `knowledge_base`, its distilled sections appear in the same file.',
        docs: 'Task documents',
        current: 'this session',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        copy: 'Copy document',
        copied: 'Copied',
        doc: 'Knowledge',
        resize: 'Drag to resize (arrow keys fine-tune)',
        noPurpose: '(no goal recorded yet)',
        sections: 'sections',
        status: {
          进行中: 'active',
          已完成: 'done',
          受阻: 'blocked',
        },
      },
      zh: {
        tab: '知识库',
        title: '知识库',
        subtitle: '每个任务一份文档 · 换模型也能接着干',
        updated: '更新于',
        empty:
          '还没有知识库文档。完成一轮对话后，插件会把本任务的文档写到这里；模型调用 knowledge_base 写入提炼内容后，同一份文件里就会出现完整结构。',
        docs: '任务文档',
        current: '本会话',
        refresh: '刷新',
        refreshing: '刷新中…',
        copy: '复制文档',
        copied: '已复制',
        doc: '知识库',
        resize: '拖动调整宽度（← → 微调）',
        noPurpose: '（还没有记录任务目的）',
        sections: '个小节',
        status: {
          进行中: '进行中',
          已完成: '已完成',
          受阻: '受阻',
        },
      },
    }

    const CSS = `
.${CLASS}-root{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;gap:10px;padding:14px 18px 18px;color:var(--dsw-alias-label-primary);font-family:inherit}
.${CLASS}-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.${CLASS}-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.${CLASS}-meta{font-size:12px;color:var(--dsw-alias-label-secondary)}
.${CLASS}-grow{flex:1 1 auto}
.${CLASS}-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:7px;padding:4px 10px;font-size:12px;line-height:1.5;cursor:pointer;font-family:inherit;white-space:nowrap}
.${CLASS}-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.${CLASS}-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.${CLASS}-btn[data-accent="1"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.${CLASS}-body{flex:1 1 auto;min-height:0;display:grid;gap:0;align-items:stretch}
.${CLASS}-split{position:relative;cursor:col-resize;touch-action:none;border-radius:4px}
.${CLASS}-split::after{content:'';position:absolute;left:50%;top:8px;bottom:8px;width:2px;transform:translateX(-50%);border-radius:1px;background:var(--dsw-alias-border-l1)}
.${CLASS}-split:hover::after,.${CLASS}-split:focus-visible::after{background:var(--dsw-alias-brand-primary);width:3px}
.${CLASS}-split:focus-visible{outline:none}
.${CLASS}-pane{min-height:0;display:flex;flex-direction:column;gap:8px}
.${CLASS}-pane-head{display:flex;align-items:center;gap:8px;height:20px;min-height:20px}
.${CLASS}-pane-label{font-size:11px;line-height:1;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLASS}-scroll{min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px}
.${CLASS}-list{display:flex;flex-direction:column;gap:4px}
.${CLASS}-item{appearance:none;width:100%;border:1px solid transparent;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;display:flex;flex-direction:column;gap:2px;padding:7px 9px;cursor:pointer}
.${CLASS}-item:hover{background:var(--dsw-alias-bg-layer-2)}
.${CLASS}-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.${CLASS}-item[data-active="1"]{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.${CLASS}-item-top{display:flex;align-items:center;gap:6px;min-width:0}
.${CLASS}-task{flex:1 1 auto;min-width:0;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLASS}-pill{flex:0 0 auto;font-size:10.5px;line-height:1.6;padding:0 6px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.${CLASS}-badge{flex:0 0 auto;font-size:10px;line-height:1.6;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.${CLASS}-purpose{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLASS}-stamp{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.${CLASS}-doc{font-size:13px;line-height:1.72;word-break:break-word;padding:10px 12px}
.${CLASS}-doc h1{font-size:16px;margin:0 0 8px}
.${CLASS}-doc h2{font-size:14px;margin:16px 0 6px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.${CLASS}-doc h3{font-size:13px;margin:12px 0 4px;color:var(--dsw-alias-label-primary)}
.${CLASS}-doc p{margin:4px 0;color:var(--dsw-alias-label-secondary)}
.${CLASS}-doc ul,.${CLASS}-doc ol{margin:4px 0;padding-left:18px}
.${CLASS}-doc li{margin:2px 0;color:var(--dsw-alias-label-secondary)}
.${CLASS}-doc blockquote{margin:6px 0;padding:2px 10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px}
.${CLASS}-doc code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 4px}
.${CLASS}-doc strong{color:var(--dsw-alias-label-primary);font-weight:600}
.${CLASS}-doc table{border-collapse:collapse;margin:6px 0;font-size:12px;width:100%}
.${CLASS}-doc th,.${CLASS}-doc td{border:1px solid var(--dsw-alias-border-l1);padding:3px 7px;text-align:left;vertical-align:top;color:var(--dsw-alias-label-secondary)}
.${CLASS}-doc th{color:var(--dsw-alias-label-primary);font-weight:600;background:var(--dsw-alias-bg-layer-2)}
.${CLASS}-empty{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary);max-width:52ch;line-height:1.7}
`

    function pad2(value) {
      return value < 10 ? `0${value}` : String(value)
    }

    function fmtDateTime(time) {
      const value = Number(time)
      if (!Number.isFinite(value) || value <= 0) return '—'
      const date = new Date(value)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function activeLocale(locale) {
      try {
        const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null
        const id = snapshot && (snapshot.id || snapshot.locale || snapshot.current)
        if (typeof id === 'string' && id) return id.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {}
      return 'en'
    }

    function tone(status) {
      if (status === '已完成') return 'var(--dsw-alias-state-success-primary)'
      if (status === '受阻') return 'var(--dsw-alias-state-error-primary)'
      return 'var(--dsw-alias-state-idle-primary)'
    }

    /** Inline `` `code` `` and `**bold**`, without any HTML injection. */
    function renderInline(text, keyPrefix) {
      const parts = String(text || '').split(/(`[^`]*`|\*\*[^*]+\*\*)/g)
      const nodes = []
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]
        if (!part) continue
        const key = `${keyPrefix}-${index}`
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          nodes.push(h('code', { key }, part.slice(1, -1)))
        } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          nodes.push(h('strong', { key }, part.slice(2, -2)))
        } else {
          nodes.push(h('span', { key }, part))
        }
      }
      return nodes
    }

    /** Line-based Markdown: headings, quotes, nested and ordered lists, tables. */
    function renderMarkdown(markdown) {
      const lines = String(markdown || '').split('\n')
      const block = []
      let bullets = []
      let ordered = []
      let listKey = 0
      let table = []
      let tableKey = 0

      const flushList = () => {
        if (bullets.length > 0) {
          block.push(h('ul', { key: `ul-${listKey}` }, bullets))
          bullets = []
        }
        if (ordered.length > 0) {
          block.push(h('ol', { key: `ol-${listKey}` }, ordered))
          ordered = []
        }
        if (block.length > 0) listKey += 1
      }

      const flushTable = () => {
        if (table.length === 0) return
        const rows = table.filter(row => !/^\|[\s:|-]+\|$/.test(row.trim()))
        const cells = rows.map(row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()))
        table = []
        if (cells.length === 0) return
        const head = cells[0]
        const body = cells.slice(1)
        block.push(h('table', { key: `tb-${tableKey}` },
          h('thead', null, h('tr', null, head.map((cell, index) => h('th', { key: `th-${index}` }, ...renderInline(cell, `th-${index}`))))),
          h('tbody', null, body.map((row, rowIndex) => h('tr', { key: `tr-${rowIndex}` },
            row.map((cell, cellIndex) => h('td', { key: `td-${cellIndex}` }, ...renderInline(cell, `td-${rowIndex}-${cellIndex}`))))),
        )))
        tableKey += 1
      }

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const trimmed = line.trim()
        if (!trimmed) {
          flushList()
          flushTable()
          continue
        }
        if (trimmed.startsWith('|')) {
          flushList()
          table.push(trimmed)
          continue
        }
        flushTable()
        if (trimmed.startsWith('#')) {
          flushList()
          const match = /^(#{1,4})\s+(.*)$/.exec(trimmed)
          if (match) {
            const level = match[1].length
            block.push(h(`h${level}`, { key: `h-${index}` }, ...renderInline(match[2], `i-${index}`)))
            continue
          }
        }
        if (trimmed.startsWith('> ')) {
          flushList()
          block.push(h('blockquote', { key: `q-${index}` }, ...renderInline(trimmed.slice(2), `i-${index}`)))
          continue
        }
        const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line)
        if (bullet) {
          const depth = Math.min(3, Math.floor(bullet[1].length / 2))
          bullets.push(h('li', {
            key: `li-${index}`,
            style: depth > 0 ? { marginLeft: `${depth * 12}px` } : undefined,
          }, ...renderInline(bullet[2], `i-${index}`)))
          continue
        }
        const item = /^(\s*)\d+[.)]\s+(.*)$/.exec(line)
        if (item) {
          const depth = Math.min(3, Math.floor(item[1].length / 2))
          ordered.push(h('li', {
            key: `li-${index}`,
            style: depth > 0 ? { marginLeft: `${depth * 12}px` } : undefined,
          }, ...renderInline(item[2], `i-${index}`)))
          continue
        }
        flushList()
        block.push(h('p', { key: `p-${index}` }, ...renderInline(trimmed, `i-${index}`)))
      }
      flushList()
      flushTable()
      return block
    }

    function normalize(value) {
      if (!value || typeof value !== 'object') return null
      const docs = Array.isArray(value.docs) ? value.docs.filter(doc => doc && typeof doc.task === 'string') : []
      return {
        task: typeof value.task === 'string' ? value.task : '',
        file: typeof value.file === 'string' ? value.file : '',
        dir: typeof value.dir === 'string' ? value.dir : 'knowledge-base',
        status: typeof value.status === 'string' ? value.status : '进行中',
        updatedAt: Number(value.updatedAt) || 0,
        markdown: typeof value.markdown === 'string' ? value.markdown : '',
        docs,
        total: Number(value.total) || docs.length,
        turns: Array.isArray(value.turns) ? value.turns : [],
      }
    }

    function copyText(text) {
      try {
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(() => true, () => false)
        }
      } catch {}
      return Promise.resolve(false)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined

        const dict = () => DICT[activeLocale(locale)]
        const t = key => dict()[key] || key

        function statusText(status) {
          const table = dict().status
          return (table && table[status]) || status || '—'
        }

        function KnowledgeView(props) {
          const readProjection = props && props.useProjection
          const value = readProjection ? readProjection(PROJECTION_KEY) : undefined
          const model = React.useMemo(() => normalize(value), [value])
          const [selected, setSelected] = React.useState('')
          const [copied, setCopied] = React.useState('')
          const [split, setSplit] = React.useState(320)
          const [bodyWidth, setBodyWidth] = React.useState(0)
          const [tick, setTick] = React.useState(0)
          const bodyRef = React.useRef(null)
          const docRef = React.useRef(null)
          const dragRef = React.useRef(null)
          const sessionId = props && props.sessionId

          React.useEffect(() => {
            if (!sessions || typeof sessions.refreshProjections !== 'function' || !sessionId) return undefined
            let alive = true
            const refresh = () => {
              if (!alive) return
              try {
                const outcome = sessions.refreshProjections(sessionId)
                if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {})
              } catch {}
            }
            refresh()
            const timer = setInterval(refresh, REFRESH_MS)
            const onVisible = () => {
              if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh()
            }
            if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
            return () => {
              alive = false
              clearInterval(timer)
              if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
            }
          }, [sessions, sessionId])

          React.useEffect(() => {
            const node = bodyRef.current
            if (!node || typeof ResizeObserver === 'undefined') return undefined
            const observer = new ResizeObserver(entries => {
              const width = entries && entries[0] ? entries[0].contentRect.width : 0
              if (width > 0) setBodyWidth(width)
            })
            observer.observe(node)
            return () => observer.disconnect()
          }, [model])

          React.useEffect(() => {
            if (!copied) return undefined
            const timer = setTimeout(() => setCopied(''), 1500)
            return () => clearTimeout(timer)
          }, [copied])

          React.useEffect(() => {
            const node = docRef.current
            if (node) node.scrollTop = 0
          }, [selected, tick])

          const docs = model ? model.docs : []
          const fallback = model && model.task ? model.task : (docs[0] ? docs[0].task : '')
          const activeTask = docs.some(doc => doc.task === selected) ? selected : fallback
          const active = docs.find(doc => doc.task === activeTask) || null

          const narrow = bodyWidth > 0 && bodyWidth < 760
          const maxLeft = Math.max(220, (bodyWidth || 900) - 300)
          const left = Math.max(200, Math.min(split, maxLeft))

          const startDrag = React.useCallback(event => {
            dragRef.current = { x: event.clientX, width: left }
            try {
              event.currentTarget.setPointerCapture(event.pointerId)
            } catch {}
          }, [left])

          const moveDrag = React.useCallback(event => {
            const drag = dragRef.current
            if (!drag) return
            const next = drag.width + (event.clientX - drag.x)
            setSplit(Math.max(200, Math.min(next, maxLeft)))
          }, [maxLeft])

          const endDrag = React.useCallback(event => {
            dragRef.current = null
            try {
              event.currentTarget.releasePointerCapture(event.pointerId)
            } catch {}
          }, [])

          const nudge = React.useCallback(event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const delta = event.key === 'ArrowLeft' ? -24 : 24
            setSplit(Math.max(200, Math.min(left + delta, maxLeft)))
          }, [left, maxLeft])

          const refresh = React.useCallback(() => {
            setTick(previous => previous + 1)
            if (!sessions || typeof sessions.refreshProjections !== 'function' || !sessionId) return
            try {
              const outcome = sessions.refreshProjections(sessionId)
              if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {})
            } catch {}
          }, [sessions, sessionId])

          const header = h('header', { className: `${CLASS}-head`, key: 'head' },
            h('h2', { className: `${CLASS}-title` }, t('title')),
            h('span', { className: `${CLASS}-meta` },
              model
                ? `${model.dir} · ${model.total} ${t('docs')}${model.updatedAt ? ` · ${t('updated')} ${fmtDateTime(model.updatedAt)}` : ''}`
                : t('subtitle')),
            h('span', { className: `${CLASS}-grow` }),
            h('button', { key: 'refresh', type: 'button', className: `${CLASS}-btn`, onClick: refresh }, t('refresh')),
            active
              ? h('button', {
                  key: 'copy',
                  type: 'button',
                  className: `${CLASS}-btn`,
                  'data-accent': '1',
                  onClick: () => copyText(active.markdown).then(ok => { if (ok) setCopied(active.task) }),
                }, copied === active.task ? t('copied') : t('copy'))
              : null,
          )

          if (!model || (docs.length === 0 && model.turns.length === 0)) {
            return h('section', { className: `${CLASS}-root` },
              h('style', { key: 'css' }, CSS),
              header,
              h('p', { className: `${CLASS}-empty` }, t('empty')),
            )
          }

          const list = h('div', { className: `${CLASS}-pane`, key: 'list' },
            h('div', { className: `${CLASS}-pane-head` },
              h('span', { className: `${CLASS}-pane-label` }, `${t('docs')} · ${docs.length}`),
            ),
            h('div', { className: `${CLASS}-scroll` },
              h('div', { className: `${CLASS}-list` },
                docs.length === 0
                  ? h('p', { className: `${CLASS}-empty` }, t('empty'))
                  : docs.map(doc => h('button', {
                      key: doc.task,
                      type: 'button',
                      className: `${CLASS}-item`,
                      'data-active': doc.task === activeTask ? '1' : '0',
                      'aria-pressed': doc.task === activeTask,
                      onClick: () => setSelected(doc.task),
                    },
                      h('span', { className: `${CLASS}-item-top` },
                        h('span', { className: `${CLASS}-task`, title: doc.task }, doc.task),
                        h('span', { className: `${CLASS}-pill`, style: { color: tone(doc.status) } }, statusText(doc.status)),
                        doc.current ? h('span', { className: `${CLASS}-badge` }, t('current')) : null,
                      ),
                      h('span', { className: `${CLASS}-purpose` }, doc.purpose || t('noPurpose')),
                      h('span', { className: `${CLASS}-stamp` },
                        `${fmtDateTime(doc.updatedAt)}${doc.sources > 1 ? ` · ${doc.sources} 会话` : ''}`),
                    )),
              ),
            ),
          )

          const content = h('div', { className: `${CLASS}-pane`, key: 'content' },
            h('div', { className: `${CLASS}-pane-head` },
              h('span', { className: `${CLASS}-pane-label` }, `${t('doc')} / ${active ? active.file : model.file || ''}`),
            ),
            h('div', { className: `${CLASS}-scroll ${CLASS}-doc`, ref: docRef },
              active ? renderMarkdown(active.markdown) : h('p', { className: `${CLASS}-empty` }, t('empty')),
            ),
          )

          return h('section', { className: `${CLASS}-root` },
            h('style', { key: 'css' }, CSS),
            header,
            h('div', {
              className: `${CLASS}-body`,
              ref: bodyRef,
              style: narrow
                ? { gridTemplateColumns: 'minmax(0,1fr)' }
                : { gridTemplateColumns: `${left}px 12px minmax(0,1fr)` },
            },
              list,
              narrow
                ? null
                : h('div', {
                    key: 'split',
                    className: `${CLASS}-split`,
                    role: 'separator',
                    'aria-orientation': 'vertical',
                    'aria-valuenow': Math.round(left),
                    'aria-label': t('resize'),
                    title: t('resize'),
                    tabIndex: 0,
                    onPointerDown: startDrag,
                    onPointerMove: moveDrag,
                    onPointerUp: endDrag,
                    onPointerCancel: endDrag,
                    onKeyDown: nudge,
                  }),
              content,
            ),
          )
        }

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'knowledge-base',
          order: 30,
          label: () => t('tab'),
        }, KnowledgeView))
      },
    }
  },
})
