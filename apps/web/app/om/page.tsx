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
              sammenlignes deterministisk på total kjøpskostnad, antall butikker og godkjente
              bytter. Reisetid blir en egen faktor bare når du ber om en beregning. Planen kan
              bruke høyst tre butikker, og delvis dekning skal alltid kvalifisere «best»-påstander.
            </p>
            <p>Det finnes ingen betalt rangering, sponsede plasseringer eller skjult kjedebonus.</p>
            <a href="https://github.com/Reedtrullz/Handli/blob/main/docs/governance/public-good-governance.md">
              Les den reproduserbare rangerings- og styringspolicyen
            </a>
          </section>

          <section className="trust-card">
            <h2>Personvern først</h2>
            <p>
              Handlelisten ligger lokalt i nettleseren. Posisjonen din lagres ikke. Når
              ruteberegning blir aktivert, skal startpunktet brukes midlertidig og aldri legges i
              nettleserlagring, URL-er, logger eller varige rutebuffer.
            </p>
            <a href="/personvern">Les personvernerklæringen</a>
          </section>

          <section className="trust-card">
            <h2>Finansiering og påvirkning</h2>
            <p>
              Eventuelle bidrag eller sponsorater skal offentliggjøres og kan ikke påvirke
              rangeringen. Handleplan tar ikke betalt fra butikker for å bli anbefalt.
            </p>
            <p>
              Faktisk finansiering, eventuelle bindinger og ansvarlig eier av oversikten er ikke
              ferdig dokumentert. Det blokkerer offentlig lansering.
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

          <section className="trust-card">
            <h2>Åpen kildekode med tydelig grense</h2>
            <p>
              Handleplans egen kode er lisensiert under GNU Affero General Public License,
              versjon 3 eller senere (AGPL-3.0-or-later). Tredjeparts prisdata, tilbud, navn,
              varebilder, logoer, publikasjoner og andre verk følger ikke automatisk med under
              denne lisensen.
            </p>
            <a href="https://github.com/Reedtrullz/Handli/blob/main/LICENSE">Les kodelisensen</a>
          </section>

          <section className="trust-card">
            <h2>Sikkerhet og sensitive henvendelser</h2>
            <p>
              Ikke legg sårbarheter, nøkler, handlekurver, adresser eller posisjoner i en
              offentlig sak. En verifisert konfidensiell sikkerhets- og personvernkontakt er ennå
              ikke publisert og må finnes før offentlig lansering.
            </p>
            <a href="https://github.com/Reedtrullz/Handli/blob/main/SECURITY.md">
              Les sikkerhetspolicyen
            </a>
          </section>
        </div>

        <section className="trust-card trust-pending">
          <h2>Før offentlig lansering</h2>
          <p>
            Kildetillatelser, juridisk operatør og behandlingsansvarlig, ekte kontaktkanaler,
            finansieringsoversikt, personvern-/sikkerhets-/juridisk godkjenning og vurdering av
            tredjeparts vilkår, varemerker og bilder må fullføres før tilgangen åpnes. Den
            beskyttede alfaen er ikke en offentlig v1-lansering. Kodelisensen er valgt; den løser
            ikke disse andre kravene.
          </p>
          <a href="/status">Se gjeldende datadekning</a>
        </section>
      </main>
    </div>
  );
}
