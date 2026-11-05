import { NavLink, useLocation } from 'react-router-dom'
import styles from './SideNav.module.css'

const NAV_ITEMS = [
  {
    section: '지식 베이스',
    items: [
      { label: 'Q&A 챗봇 (RAG)', path: '/bedrockagent' }
    ]
  },
  {
    section: '설정 (Setting)',
    items: [
      { label: '시스템 프롬프트', path: '/prompts' },
      { label: '가드레일', path: '/guardrails' },
      { label: '문서 관리', path: '/knowledgebase' }
    ]
  }
]

const SideNav = () => {
  const location = useLocation()

  return (
    <nav className={styles.sidenav}>
      {NAV_ITEMS.map((group, groupIdx) => (
        <div
          key={group.section}
          className={groupIdx > 0 ? styles.sectionGroup : undefined}
        >
          <span className={styles.sectionHeader}>{group.section}</span>
          {group.items.map(item => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => {
                // Handle root path — treat "/" as active for /bedrockagent
                const active = isActive || (item.path === '/bedrockagent' && location.pathname === '/')
                return active ? `${styles.item} ${styles.itemActive}` : styles.item
              }}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  )
}

export default SideNav
