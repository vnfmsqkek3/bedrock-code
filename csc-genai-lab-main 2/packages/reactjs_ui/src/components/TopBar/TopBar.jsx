import { Link } from 'react-router-dom'
import KBIcon from '../../assets/images/test-knowledge-base-icon.svg?react'
import styles from './TopBar.module.css'
import { getRuntimeConfig } from '../../utils/runtimeConfig'

const TopBar = ({ user, signOut }) => {
  // Region comes from runtime-config.json (deploy-time), so the chip follows
  // whatever region the site was deployed to instead of a hardcoded value.
  const region = getRuntimeConfig()?.region ?? ''
  return (
    <header className={styles.topbar}>
      <Link to="/bedrockagent" className={styles.brand}>
        <KBIcon className={styles.logo} />
        <span className={styles.appName}>MegazoneCloud GenAI LAB</span>
      </Link>
      <div className={styles.right}>
        {region && <span className={styles.regionChip}>{region}</span>}
        <button className={styles.avatar} onClick={signOut} title="로그아웃">
          {user?.signInDetails?.loginId?.charAt(0) || '개'}
        </button>
      </div>
    </header>
  )
}

export default TopBar
