import { DiscoveryWorkspace } from "../../components/oppdag/discovery-workspace";

export const metadata = { title: "Oppdag | Handleplan" };

export default function OppdagPage() {
  return (
    <div className="app-frame">
      <header className="site-header">
        <div className="header-inner">
          <a className="wordmark" href="/planlegg" aria-label="Handleplan, Planlegg">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            Handleplan
          </a>
          <nav aria-label="Hovedmeny">
            <a href="/planlegg">Planlegg</a>
            <a className="active" href="/oppdag" aria-current="page">Oppdag</a>
          </nav>
        </div>
      </header>

      <DiscoveryWorkspace />

      <footer className="site-footer">
        <div>
          <p>© 2026 Handleplan • Uavhengig prissammenligning</p>
          <p>Tilbakemelding og personverninformasjon kommer senere.</p>
        </div>
      </footer>
    </div>
  );
}
