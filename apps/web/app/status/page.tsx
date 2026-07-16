import coverageManifest from "../../../../docs/data/launch-coverage.v1.json";

export const metadata = { title: "Datadekning og status | Handleplan" };

const PRICE_CLASS_LABELS = {
  ordinary: "Ordinære priser",
  official_offer: "Offisielle tilbud",
} as const;

const STATUS_LABELS = {
  blocked: "Blokkert",
  partial: "Delvis dokumentert",
  suspended: "Midlertidig stanset",
  unknown: "Ukjent dekning",
  verified: "Verifisert",
} as const;

function statusLabel(status: string): string {
  return STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? "Ukjent dekning";
}

function priceClassLabel(priceClass: string): string {
  return PRICE_CLASS_LABELS[priceClass as keyof typeof PRICE_CLASS_LABELS]
    ?? "Ukjent dataklasse";
}

export default function StatusPage() {
  return (
    <div className="app-frame trust-shell">
      <header className="site-header">
        <div className="header-inner">
          <a className="wordmark" href="/planlegg" aria-label="Handleplan, Planlegg">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            Handleplan
          </a>
          <nav aria-label="Hovedmeny">
            <a href="/planlegg">Planlegg</a>
            <a href="/oppdag">Oppdag</a>
            <a className="active" href="/status" aria-current="page">Status</a>
            <a href="/om">Om</a>
          </nav>
        </div>
      </header>

      <main className="trust-main">
        <header className="trust-hero">
          <p className="eyebrow">Beskyttet alfa</p>
          <h1>Datadekning og status</h1>
          <p>
            Ingen region er lanseringsklar. Handleplan viser bare resultater blant prisene
            som kan verifiseres, og holder ukjent dekning synlig.
          </p>
          <dl className="status-metadata">
            <div><dt>Manifest</dt><dd>{coverageManifest.manifestVersion}</dd></div>
            <div><dt>Sist vurdert</dt><dd>16. juli 2026</dd></div>
            <div><dt>Lanseringsport</dt><dd>Ikke bestått</dd></div>
          </dl>
        </header>

        <section className="trust-card" aria-labelledby="status-blockers">
          <h2 id="status-blockers">Det som fortsatt blokkerer lansering</h2>
          <ul>
            <li>Kassalapp-tilgang og rettigheter for varig offentlig bruk er ikke avklart.</li>
            <li>Ingen rettighetsklar kilde for offisielle tilbud er aktivert.</li>
            <li>Ingen region har fullført måling med representative handlekurver.</li>
          </ul>
        </section>

        <div className="status-region-list">
          {coverageManifest.candidateRegions.map((region) => {
            const rows = coverageManifest.coverage.filter(({ regionId }) => regionId === region.id);
            const eligible = rows.filter(({ launchEligible }) => launchEligible).length;
            const headingId = `region-${region.id}`;
            return (
              <section
                className="trust-card status-region"
                aria-labelledby={headingId}
                key={region.id}
              >
                <div className="status-region-heading">
                  <div>
                    <p className="eyebrow">Kandidatregion</p>
                    <h2 id={headingId}>{region.name}</h2>
                  </div>
                  <strong>{eligible} av {rows.length} dataløp er lanseringsklare</strong>
                </div>
                <div className="status-chain-grid">
                  {coverageManifest.requiredChains.map((chain) => {
                    const chainRows = rows.filter(({ chainId }) => chainId === chain.id);
                    return (
                      <article key={chain.id}>
                        <h3>{chain.displayName}</h3>
                        <dl>
                          {chainRows.map((row) => (
                            <div key={row.priceClass}>
                              <dt>{priceClassLabel(row.priceClass)}</dt>
                              <dd>{statusLabel(row.coverageStatus)}</dd>
                            </div>
                          ))}
                        </dl>
                      </article>
                    );
                  })}
                </div>
                <details>
                  <summary>Kjente hull i {region.name}</summary>
                  <ul>{region.knownGaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
                </details>
              </section>
            );
          })}
        </div>

        <p className="trust-footnote">
          Statusen kommer fra manifest {coverageManifest.manifestVersion}. Kildetilstedeværelse
          dokumenterer ikke prisdekning, tilbudsrettigheter eller lagerstatus.
        </p>
      </main>
    </div>
  );
}
