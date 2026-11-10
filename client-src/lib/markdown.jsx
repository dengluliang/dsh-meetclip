const BLOCK_START = /^(#{1,6}\s+|```|>\s?|[-*+]\s+|\d+\.\s+|---+\s*$|\|)/

export function Markdown({ text, onQuote = null, resolveAsset = null, onSeek = null }) {
  const blocks = React.useMemo(() => parseBlocks(String(text || '')), [text])
  return <div className="mc-md">{blocks.map((block, index) => renderBlock(block, index, onQuote, resolveAsset, onSeek))}</div>
}

function parseBlocks(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }
    // AI 纪要段的边界写在 HTML 注释里，预览不显示。
    if (line.trimStart().startsWith('<!--')) {
      while (i < lines.length && !lines[i].includes('-->')) i += 1
      i += 1
      continue
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const body = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) { body.push(lines[i]); i += 1 }
      i += 1
      blocks.push({ type: 'code', lang, text: body.join('\n') })
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      i += 1
      continue
    }
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }
    if (/^>\s?/.test(line)) {
      const body = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i += 1 }
      blocks.push({ type: 'quote', text: body.join('\n') })
      continue
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items = []
      // 编号列表和项目列表是两种列表；不要求中间空行也能正确分开。
      const sameKind = (value) => (ordered ? /^\s*\d+\.\s+/.test(value) : /^\s*[-*+]\s+/.test(value))
      while (i < lines.length && sameKind(lines[i])) {
        const body = lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
        const task = ordered ? null : body.match(/^\[([ xX])\]\s+(.*)$/)
        if (task) items.push({ checked: task[1].toLowerCase() === 'x', text: task[2] })
        else items.push({ text: body })
        i += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const header = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i += 1 }
      blocks.push({ type: 'table', header, rows })
      continue
    }
    const paragraph = [line]
    i += 1
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
      paragraph.push(lines[i]); i += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
  }
  return blocks
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function renderBlock(block, index, onQuote, resolveAsset, onSeek) {
  if (block.type === 'code') {
    return <pre key={index} className="mc-md-code"><code>{block.text}</code></pre>
  }
  if (block.type === 'heading') {
    const tag = `h${Math.min(6, block.level + 1)}`
    return React.createElement(tag, { key: index, className: `mc-md-h${block.level}` }, inline(block.text, onQuote, resolveAsset, onSeek))
  }
  if (block.type === 'hr') return <hr key={index} className="mc-md-hr" />
  if (block.type === 'quote') {
    return <blockquote key={index} className="mc-md-quote">{inline(block.text, onQuote, resolveAsset, onSeek)}</blockquote>
  }
  if (block.type === 'list') {
    const tag = block.ordered ? 'ol' : 'ul'
    return React.createElement(tag, { key: index, className: 'mc-md-list' },
      block.items.map((item, itemIndex) => {
        const entry = typeof item === 'string' ? { text: item } : item
        return (
          <li key={itemIndex} className={entry.checked === undefined ? undefined : 'mc-md-task-item'}
            data-checked={entry.checked === undefined ? undefined : (entry.checked ? 'true' : 'false')}>
            {entry.checked === undefined ? null : (
              <span className="mc-md-task" data-checked={entry.checked ? 'true' : 'false'} aria-hidden="true" />
            )}
            {inline(entry.text, onQuote, resolveAsset, onSeek)}
          </li>
        )
      }))
  }
  if (block.type === 'table') {
    return (
      <table key={index} className="mc-md-table">
        <thead><tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell, onQuote, resolveAsset, onSeek)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell, onQuote, resolveAsset, onSeek)}</td>)}</tr>)}</tbody>
      </table>
    )
  }
  return <p key={index} className="mc-md-p">{inline(block.text, onQuote, resolveAsset, onSeek)}</p>
}

function inline(text, onQuote, resolveAsset, onSeek) {
  const nodes = []
  let rest = String(text || '')
  let key = 0
  const patterns = [
    { type: 'escape', re: /^\\([\\`*_[\]()#+\-.!|>])/ },
    { type: 'code', re: /^`([^`]+)`/ },
    { type: 'image', re: /^!\[([^\]]*)\]\(([^)\s]+)\)/ },
    { type: 'link', re: /^\[([^\]]+)\]\(([^)\s]+)\)/ },
    { type: 'bold', re: /^\*\*([^*]+)\*\*/ },
    { type: 'strike', re: /^~~([^~]+)~~/ },
    { type: 'italic', re: /^\*([^*]+)\*/ },
    { type: 'bold', re: /^__([^_]+)__/ },
    { type: 'italic', re: /^_([^_]+)_/ }
  ]
  while (rest.length > 0) {
    let matched = null
    for (const pattern of patterns) {
      const result = rest.match(pattern.re)
      if (result) { matched = { ...pattern, result }; break }
    }
    if (!matched) {
      const next = rest.search(/[\\`![*_~]/)
      if (next < 0) { nodes.push(rest); break }
      if (next === 0) { nodes.push(rest[0]); rest = rest.slice(1); continue }
      nodes.push(rest.slice(0, next))
      rest = rest.slice(next)
      continue
    }
    const [whole, one, two] = matched.result
    key += 1
    if (matched.type === 'escape') nodes.push(one)
    else if (matched.type === 'code') nodes.push(<code key={key} className="mc-md-inline-code">{one}</code>)
    else if (matched.type === 'bold') nodes.push(<strong key={key}>{inline(one, onQuote, resolveAsset, onSeek)}</strong>)
    else if (matched.type === 'italic') nodes.push(<em key={key}>{inline(one, onQuote, resolveAsset, onSeek)}</em>)
    else if (matched.type === 'strike') nodes.push(<del key={key}>{inline(one, onQuote, resolveAsset, onSeek)}</del>)
    else if (matched.type === 'image') nodes.push(renderImage(one, two, key, resolveAsset))
    else if (matched.type === 'link') nodes.push(renderLink(one, two, key, onQuote, onSeek))
    rest = rest.slice(whole.length)
  }
  return nodes.map((node, index) => typeof node === 'string' ? <React.Fragment key={`t${index}`}>{node}</React.Fragment> : node)
}

function renderImage(alt, source, key, resolveAsset) {
  let src = source
  if (!/^(https?:|data:image\/)/i.test(src) && resolveAsset) src = resolveAsset(src)
  if (!/^(https?:|data:image\/|\/meetclip\/)/i.test(src)) return <span key={key}>[{alt}]</span>
  return <img key={key} className="mc-md-image" src={src} alt={alt} loading="lazy" />
}

function renderLink(label, href, key, onQuote, onSeek) {
  const seek = /^meetclip:\/\/seek\/(\d+(?:\.\d+)?)$/.exec(href)
  if (seek) {
    if (!onSeek) return <span key={key}>{label}</span>
    return (
      <button key={key} type="button" className="mc-md-anchor" data-no-edit="true"
        onClick={(event) => { event.stopPropagation(); onSeek(Number(seek[1])) }}>
        {label}
      </button>
    )
  }
  if (href.startsWith('meetclip://quote/')) {
    return <span key={key}>{label}</span>
  }
  if (!/^(https?:|mailto:)/i.test(href)) return <span key={key}>{label}</span>
  return <a key={key} className="mc-md-link" href={href} target="_blank" rel="noreferrer noopener">{label}</a>
}
