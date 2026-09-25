import { Button, Tag } from '@/ui'
import { t } from '@/i18n'
import { DEMO_EMULATORS } from '@/data/demo'

export function Emulators() {
  return (
    <div className="content">
      <p className="muted">{t('emu.subtitle')}</p>
      <div className="emu-grid">
        {DEMO_EMULATORS.map((e) => (
          <div key={e.id} className="emu-card">
            <h3>{e.name}</h3>
            <div className="muted">{e.consoles}{e.version ? ` · ${e.version}` : ''}</div>
            <div className="emu-foot">
              <Tag>{t(`status.${e.status}`)}</Tag>
              <Button variant={e.status === 'notInstalled' ? 'primary' : 'default'}>
                {e.status === 'notInstalled' ? t('emu.install') : t('emu.configure')}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
