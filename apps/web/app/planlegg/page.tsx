import { BasketWorkspace } from "../../components/planlegg/basket-workspace";

export const metadata = { title: "Handleplan" };

export default function PlanleggPage() {
  return (
    <div className="app-frame">
      <header className="site-header">
        <div className="header-inner">
          <a className="wordmark" href="/planlegg" aria-label="Handleplan, Planlegg">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            Handleplan
          </a>
          <nav aria-label="Hovedmeny">
            <a className="active" href="/planlegg" aria-current="page">Planlegg</a>
            <span className="coming-later">Oppdag kommer senere</span>
          </nav>
        </div>
      </header>

      <BasketWorkspace />

      <footer className="site-footer">
        <div>
          <p>© 2026 Handleplan • Uavhengig prissammenligning</p>
          <p>Tilbakemelding og personverninformasjon kommer senere.</p>
        </div>
      </footer>
    </div>
  );
}
