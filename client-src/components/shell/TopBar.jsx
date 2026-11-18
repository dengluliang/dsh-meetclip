import { MeetClipIcon, SearchIcon } from '../Icon.jsx'
import { LibrarySwitcher } from './LibrarySwitcher.jsx'

const VIEWS = [
  { id: 'home', label: '首页' },
  { id: 'library', label: '资料库' }
]

export function TopBar({
  t, view, onView,
  libraries, activeLibrary, libraryBusy, onLibrarySelect, onLibraryCreate, onLibraryManage,
  onSearch, onHelp, onSettings, settingsDisabled = false, libraryMenuOpen = false
}) {
  return (
    <header className="mc-topbar">
      <div className="mc-topbar-brand" title={t('panel.title')}>
        <span className="mc-topbar-mark"><MeetClipIcon size={19} active /></span>
        <span>会摘</span>
      </div>
      <nav className="mc-topbar-nav" aria-label="会摘导航">
        {VIEWS.map((item) => (
          <button key={item.id} type="button" aria-current={view === item.id ? 'page' : undefined}
            data-active={view === item.id} onClick={() => onView(item.id)}>{item.label}</button>
        ))}
      </nav>
      <span className="mc-topbar-spacer" />
      {onSearch ? (
        <button type="button" className="mc-search-trigger" data-testid="topbar-search"
          onClick={onSearch} aria-label={t('topbar.search')} title={`${t('topbar.search')}（⌘K）`}>
          <SearchIcon size={14} />
          <span>{t('topbar.search')}</span>
          <kbd>⌘K</kbd>
        </button>
      ) : null}
      {onHelp ? (
        <button type="button" className="mc-topbar-tool mc-topbar-tool-text" aria-label="使用指南" title="使用指南"
          onClick={onHelp}>帮助</button>
      ) : null}
      {onSettings ? (
        <button type="button" className="mc-topbar-tool mc-topbar-tool-text" aria-label="设置"
          title={settingsDisabled ? '完成首次配置后可使用' : '会摘设置'}
          disabled={settingsDisabled} onClick={onSettings}>设置</button>
      ) : null}
      <LibrarySwitcher
        rows={libraries}
        active={activeLibrary}
        busy={libraryBusy}
        onSelect={onLibrarySelect}
        onCreate={onLibraryCreate}
        onManage={onLibraryManage}
        defaultOpen={libraryMenuOpen}
      />
    </header>
  )
}
