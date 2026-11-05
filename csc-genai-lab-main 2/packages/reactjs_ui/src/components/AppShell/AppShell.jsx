import { Outlet } from 'react-router-dom'
import TopBar from '../TopBar/TopBar'
import SideNav from '../SideNav/SideNav'
import styles from './AppShell.module.css'

const AppShell = ({ signOut, user }) => {
  return (
    <div className={styles.shell}>
      <TopBar user={user} signOut={signOut} />
      <div className={styles.body}>
        <SideNav />
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default AppShell
