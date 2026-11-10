import { clock } from '../lib/format.js'
import { highlightSpans, todoDone } from '../lib/minutesInteractions.js'
import {
  isWeak, minutesLabels, minutesSections, outcomesHeading, timelineSegments
} from '../lib/minutesView.js'

// 原生只读视图：结构化纪要 + 时间轴 + 原因卡片，可自由选择、分节复制。
// 标签与节顺序来自后端 payload（labels / section_order），这里只负责怎么摆。
//
// 用户互动：
// - 待办点一下就是完成（划掉），状态写回后端，`meetclip_minutes` 会带上 done；
// - 选中文字后由外层弹出右键菜单加高亮，这里把命中片段渲染成 <mark>，
//   高亮记录同样落在后端，Agent 读纪要与笔记时都能看到。

function TimeAnchor({ seconds, onSeek }) {
  if (seconds === null || seconds === undefined) return null
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  if (!Number.isFinite(value)) return null
  const label = clock(value)
  if (typeof onSeek !== 'function') return <span className="mc-minutes-time">{label}</span>
  return (
    <button type="button" className="mc-minutes-time" title={`跳到 ${label}`}
      onClick={() => onSeek(value)}>{label}</button>
  )
}

function textParts(text, highlights, onMark) {
  const source = String(text ?? '')
  const spans = highlightSpans(source, highlights)
  if (!spans.length) return source
  const nodes = []
  let cursor = 0
  spans.forEach((span, index) => {
    if (span.start > cursor) nodes.push(source.slice(cursor, span.start))
    nodes.push(
      <mark key={`h${index}`} className="mc-hl" data-highlight-id={span.id}
        title={span.quote ? `高亮：${span.quote}` : '高亮'}
        onClick={(event) => { event.stopPropagation(); onMark?.(event, span) }}>
        {source.slice(span.start, span.end)}
      </mark>
    )
    cursor = span.end
  })
  if (cursor < source.length) nodes.push(source.slice(cursor))
  return nodes
}

/** 所有正文都走这里，保证高亮在任何一节（摘要/主题/要点/结论/待办/术语）都能显示。 */
function Text({ text, highlights, onMark }) {
  const parts = textParts(text, highlights, onMark)
  if (typeof parts === 'string') return parts
  return <>{parts}</>
}

function WeakTag({ support, t }) {
  if (!isWeak(support)) return null
  return <span className="mc-minutes-weak">{t('minutes.weakSupport') || '依据较少'}</span>
}

function Section({ kind, title, onCopy, t, children }) {
  const bodyRef = React.useRef(null)
  return (
    <section className="mc-minutes-section" data-section={kind}>
      <div className="mc-minutes-section-head">
        <h2>{title}</h2>
        <button type="button" className="mc-minutes-section-copy"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCopy?.(`${title}\n\n${bodyRef.current?.innerText || ''}`.trim())}>
          {t('minutes.copySection') || '复制本节'}
        </button>
      </div>
      <div className="mc-minutes-section-body" ref={bodyRef}>{children}</div>
    </section>
  )
}

// 主题索引：上面一条按比例的分段条，下面是两列的时间 + 标题清单。
// 不做等宽分段——8 个主题塞进一行会把标题全截断，时间也显示不全。
function TopicTimeline({ minutes, onSeek, t, highlights, onMark }) {
  const segments = timelineSegments(minutes)
  if (!segments.length) return null
  const total = segments[segments.length - 1].end - segments[0].start
  const count = (t('minutes.timelineCount') || '{n} 个主题').replace('{n}', String(segments.length))
  return (
    <div className="mc-minutes-timeline">
      <div className="mc-minutes-timeline-head">
        <h2>{t('minutes.timeline') || '时间轴'}</h2>
        <span>{count} · {clock(total)}</span>
      </div>
      <div className="mc-minutes-timeline-bar" aria-hidden="true">
        {segments.map((segment, index) => (
          <span key={index} className="mc-minutes-timeline-bar-seg"
            data-current={segment.current ? 'true' : undefined}
            style={{ flexGrow: segment.span }} />
        ))}
      </div>
      <div className="mc-minutes-timeline-list">
        {segments.map((segment, index) => (
          <button type="button" key={index} className="mc-minutes-timeline-item"
            data-current={segment.current ? 'true' : undefined}
            title={`跳到 ${clock(segment.start)}`}
            onClick={() => onSeek?.(segment.start)}>
            <span className="mc-minutes-timeline-time">{clock(segment.start)}</span>
            <span className="mc-minutes-timeline-title">
              <Text text={segment.title} highlights={highlights} onMark={onMark} />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// 原因卡片：同一问题下的几条原因并列成卡片网格。
// 不画主轴、不画骨刺——主轴带箭头会被读成时间或因果顺序，骨刺既不对齐文字也不指向任何东西，
// 时间戳降级成卡片右上角的出处角标，只负责跳转。
function CauseCard({ branch, onSeek, t, highlights, onMark }) {
  return (
    <div className={isWeak(branch?.support) ? 'mc-causes-item is-weak' : 'mc-causes-item'}
      data-t={branch?.t === undefined || branch?.t === null ? undefined : branch.t}>
      <div className="mc-causes-head">
        <span className="mc-causes-label">
          <Text text={branch?.label} highlights={highlights} onMark={onMark} />
        </span>
        <TimeAnchor seconds={branch?.t} onSeek={onSeek} />
      </div>
      {branch?.detail ? (
        <p className="mc-causes-detail">
          <Text text={branch.detail} highlights={highlights} onMark={onMark} />
        </p>
      ) : null}
      <WeakTag support={branch?.support} t={t} />
    </div>
  )
}

function CausesBoard({ fishbone, branches, onSeek, t, highlights, onMark }) {
  const list = (branches || []).filter(Boolean)
  if (!list.length) return null
  return (
    <div className="mc-causes">
      <p className="mc-causes-question">
        <strong><Text text={fishbone?.question || '原因'} highlights={highlights} onMark={onMark} /></strong>
      </p>
      <div className="mc-causes-grid">
        {list.map((branch, index) => (
          <CauseCard key={index} branch={branch} onSeek={onSeek} t={t} highlights={highlights} onMark={onMark} />
        ))}
      </div>
    </div>
  )
}

function TopicList({ topics, labels, t, onSeek, highlights, onMark }) {
  return (topics || []).map((topic, index) => {
    const fishbone = topic?.fishbone
    const branches = fishbone?.branches || []
    return (
      <article className="mc-minutes-topic" key={`${topic?.start ?? index}-${topic?.title || index}`}
        data-topic={topic?.title || ''}
        data-t={topic?.start === undefined || topic?.start === null ? undefined : topic.start}>
        <h3 className="mc-minutes-topic-title">
          <TimeAnchor seconds={topic?.start} onSeek={onSeek} />
          <span><Text text={topic?.title} highlights={highlights} onMark={onMark} /></span>
        </h3>
        {topic?.summary ? (
          <p className="mc-minutes-topic-summary">
            <Text text={topic.summary} highlights={highlights} onMark={onMark} />
          </p>
        ) : null}
        {(topic?.points || []).length ? (
          <ul className="mc-minutes-points">
            {(topic.points || []).map((point, i) => (
              <li key={i} className={isWeak(point?.support) ? 'is-weak' : undefined}
                data-t={point?.t === undefined || point?.t === null ? undefined : point.t}>
                <TimeAnchor seconds={point?.t} onSeek={onSeek} />
                <span className="mc-minutes-text">
                  <Text text={point?.text} highlights={highlights} onMark={onMark} />
                </span>
                <WeakTag support={point?.support} t={t} />
              </li>
            ))}
          </ul>
        ) : null}
        {branches.length ? (
          <CausesBoard fishbone={fishbone} branches={branches} onSeek={onSeek} t={t}
            highlights={highlights} onMark={onMark} />
        ) : null}
      </article>
    )
  })
}

function Conclusions({ items, t, onSeek, highlights, onMark }) {
  return (
    <ol className="mc-minutes-list mc-minutes-conclusions">
      {(items || []).map((item, index) => (
        <li key={index} className={isWeak(item?.support) ? 'is-weak' : undefined}
          data-t={item?.t === undefined || item?.t === null ? undefined : item.t}>
          <span className="mc-minutes-index">{index + 1}</span>
          <span className="mc-minutes-text">
            <Text text={item?.text} highlights={highlights} onMark={onMark} />
          </span>
          <WeakTag support={item?.support} t={t} />
          <TimeAnchor seconds={item?.t} onSeek={onSeek} />
        </li>
      ))}
    </ol>
  )
}

function Todos({ items, t, interactions, onToggle, highlights, onMark }) {
  const interactive = typeof onToggle === 'function'
  return (
    <ul className="mc-minutes-list mc-minutes-todos">
      {(items || []).map((item, index) => {
        const done = todoDone(interactions, item?.text)
        const content = (
          <>
            <span className="mc-minutes-text">
              <Text text={item?.text} highlights={highlights} onMark={onMark} />
              {item?.owner ? `（${item.owner}）` : ''}
            </span>
            <WeakTag support={item?.support} t={t} />
          </>
        )
        return (
          <li key={index} className={isWeak(item?.support) ? 'is-weak' : undefined}
            data-done={done ? 'true' : 'false'}
            data-t={item?.t === undefined || item?.t === null ? undefined : item.t}>
            {interactive ? (
              <button type="button" role="checkbox" aria-checked={done}
                className="mc-minutes-box" title={done ? '标记为未完成' : '标记为已完成'}
                onClick={() => onToggle(item, index)} />
            ) : <span className="mc-minutes-box" aria-hidden="true" />}
            {content}
          </li>
        )
      })}
    </ul>
  )
}

function Terms({ items, labels, highlights, onMark }) {
  return (
    <ul className="mc-minutes-terms">
      {(items || []).map((term, index) => {
        const heard = (term?.heard || []).filter(Boolean)
        return (
          <li key={index}>
            <strong><Text text={term?.name} highlights={highlights} onMark={onMark} /></strong>
            {term?.note ? (
              <span className="mc-minutes-term-note">
                <Text text={term.note} highlights={highlights} onMark={onMark} />
              </span>
            ) : null}
            {heard.length ? (
              <span className="mc-minutes-heard">（{labels.heard || '听作'}：{heard.join('、')}）</span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

export function MinutesView({ minutes, t, onSeek, onCopy, interactions = null, onToggleTodo = null, onMark = null }) {
  const labels = minutesLabels(minutes)
  const sections = minutesSections(minutes)
  const conclusions = minutes?.conclusions || []
  const todos = minutes?.todos || []
  const topics = minutes?.topics || []
  const terms = minutes?.terms || []
  const active = interactions || minutes?.interactions || null
  const highlights = Array.isArray(active?.highlights) ? active.highlights : []

  const body = {
    summary: () => (
      <Section kind="summary" title={labels.summary} onCopy={(text) => onCopy?.(text, labels.summary)} t={t}>
        <p className="mc-minutes-summary">
          <Text text={minutes?.summary} highlights={highlights} onMark={onMark} />
        </p>
      </Section>
    ),
    topics: () => (topics.length ? (
      <Section kind="topics" title={labels.topics} onCopy={(text) => onCopy?.(text, labels.topics)} t={t}>
        <TopicList topics={topics} labels={labels} t={t} onSeek={onSeek}
          highlights={highlights} onMark={onMark} />
      </Section>
    ) : null),
    conclusions: () => (conclusions.length ? (
      <Section kind="conclusions" title={labels.conclusions} onCopy={(text) => onCopy?.(text, labels.conclusions)} t={t}>
        <Conclusions items={conclusions} t={t} onSeek={onSeek} highlights={highlights} onMark={onMark} />
      </Section>
    ) : null),
    todos: () => (todos.length ? (
      <Section kind="todos" title={labels.todos} onCopy={(text) => onCopy?.(text, labels.todos)} t={t}>
        <Todos items={todos} t={t} interactions={active} onToggle={onToggleTodo}
          highlights={highlights} onMark={onMark} />
      </Section>
    ) : null),
    terms: () => (terms.length ? (
      <Section kind="terms" title={labels.terms} onCopy={(text) => onCopy?.(text, labels.terms)} t={t}>
        <Terms items={terms} labels={labels} highlights={highlights} onMark={onMark} />
      </Section>
    ) : null),
    outcomes: () => {
      if (!conclusions.length && !todos.length) return null
      const title = outcomesHeading(labels, conclusions, todos)
      return (
        <Section kind="outcomes" title={title} onCopy={(text) => onCopy?.(text, title)} t={t}>
          {conclusions.length ? <Conclusions items={conclusions} t={t} onSeek={onSeek}
            highlights={highlights} onMark={onMark} /> : null}
          {todos.length ? <Todos items={todos} t={t} interactions={active} onToggle={onToggleTodo}
            highlights={highlights} onMark={onMark} /> : null}
        </Section>
      )
    }
  }

  return (
    <div className="mc-minutes-doc">
      {minutes?.title ? (
        <h1 className="mc-minutes-doc-title">
          <Text text={minutes.title} highlights={highlights} onMark={onMark} />
        </h1>
      ) : null}
      <TopicTimeline minutes={minutes} onSeek={onSeek} t={t} highlights={highlights} onMark={onMark} />
      {sections.map((key) => (body[key] ? <React.Fragment key={key}>{body[key]()}</React.Fragment> : null))}
    </div>
  )
}
