export const metadata = { title: "Offentlig gode og rettelser | Handleplan" };

export default function AboutPage() {
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
            <a href="/status">Status</a>
            <a className="active" href="/om" aria-current="page">Om</a>
          </nav>
        </div>
      </header>

      <main className="trust-main">
        <header className="trust-hero">
          <p className="eyebrow">Åpen hensikt</p>
          <h1>Handleplan som et offentlig gode</h1>
          <p>
            Handleplan skal hjelpe folk å forstå avveiingen mellom lavere matkostnader og en
            enklere handletur, uten å selge oppmerksomheten eller favorisere en butikkjede.
          </p>
        </header>

        <div className="trust-grid">
          <section className="trust-card">
            <h2>Slik rangeres planer</h2>
            <p>
              Bare en komplett handlekurv kan anbefales. Faktiske, ikke-dominerte planer
              sammenlignes på total kjøpskostnad, antall butikker og godkjente bytter. Reisetid
              blir en egen faktor bare når du ber om en beregning.
            </p>
            <p>Det finnes ingen betalt rangering, sponsede plasseringer eller skjult kjedebonus.</p>
          </section>

          <section className="trust-card">
            <h2>Personvern først</h2>
            <p>
              Handlelisten ligger lokalt i nettleseren. Posisjonen din lagres ikke. Når
              ruteberegning blir aktivert, skal startpunktet brukes midlertidig og aldri legges i
              nettleserlagring, URL-er, logger eller varige rutebuffer.
            </p>
          </section>

          <section className="trust-card">
            <h2>Finansiering og påvirkning</h2>
            <p>
              Eventuelle bidrag eller sponsorater skal offentliggjøres og kan ikke påvirke
              rangeringen. Handleplan tar ikke betalt fra butikker for å bli anbefalt.
            </p>
          </section>

          <section className="trust-card">
            <h2>Feil og rettelser</h2>
            <p>
              Pris- og tilbudsfeil skal kunne spores tilbake til kilden og rettes uten å endre
              original dokumentasjon. Meld gjerne feil med varen, kjeden, området og tidspunktet.
            </p>
            <a
              className="secondary-button"
              href="https://github.com/Reedtrullz/Handli/issues/new"
              rel="noreferrer"
              target="_blank"
            >Meld en feil</a>
          </section>
        </div>

        <section className="trust-card trust-pending">
          <h2>Før offentlig lansering</h2>
          <p>
            Kildetillatelser, valgt åpen kildekode-lisens, ansvarlig operatør, fullstendig
            personvernerklæring og sikkerhetskontakt publiseres før tilgangen åpnes. Den
            beskyttede alfaen er ikke en offentlig v1-lansering.
          </p>
          <a href="/status">Se gjeldende datadekning</a>
        </section>
      </main>
    </div>
  );
}
