import { SettingsStorage } from './SettingsStorage.jsx'

export function SettingsCapture({ t }) {
  const [defaultKind, setDefaultKind] = React.useState(() => localStorage.getItem('meetclip.newKindDefault') || 'remember')

  return (
    <section className="mc-section">
      <div className="mc-section-title">{t('settings.capture') || '采集'}</div>
      <div className="mc-card">
        <label className="mc-form-row">
          <span>新建默认类型</span>
          <select className="mc-input mc-select" value={defaultKind}
            onChange={(event) => {
              const value = event.target.value
              setDefaultKind(value)
              localStorage.setItem('meetclip.newKindDefault', value)
            }}>
            <option value="remember">记住上次</option>
            <option value="launch">发布会</option>
            <option value="video">视频</option>
            <option value="meeting">会议</option>
          </select>
        </label>
      </div>
      <SettingsStorage t={t} />
    </section>
  )
}
