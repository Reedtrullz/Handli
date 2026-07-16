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
            <a href="/oppdag">Oppdag</a>
          </nav>
        </div>
      </header>

      <BasketWorkspace />

      <footer className="site-footer">
        <div>
          <p>© 2026 Handleplan • Uavhengig prissammenligning</p>
          <nav aria-label="Om Handleplan">
            <a href="/status">Datadekning</a>
            <a href="/om">Offentlig gode og rettelser</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
