// Module Loader halves don't receive the `styles` builtin (that is reserved for
// dynamic client halves), so the package installs its own tagged style element.
export function installStyles(css, doc = globalThis.document) {
  if (!doc || !doc.head || typeof doc.createElement !== 'function') return () => {}
  const tag = doc.createElement('style')
  tag.dataset.meetclip = 'styles'
  tag.textContent = css
  doc.head.appendChild(tag)
  return () => {
    try { tag.remove() } catch {}
  }
}
