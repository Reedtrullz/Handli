export const metadata = { title: "Personvern | Handleplan" };

export default function PrivacyPage() {
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
            <a href="/om">Om</a>
          </nav>
        </div>
      </header>

      <main className="trust-main">
        <header className="trust-hero">
          <p className="eyebrow">Åpenhetsutkast for beskyttet alfa</p>
          <h1>Personvern i Handleplan</h1>
          <p>
            Handleplan er laget for anonym bruk uten konto i selve appen. Denne norske
            erklæringen beskriver dagens grenser og det som må avklares før offentlig lansering.
          </p>
        </header>

        <section className="trust-card trust-pending" aria-labelledby="privacy-blocker">
          <h2 id="privacy-blocker">Ikke en ferdig juridisk erklæring</h2>
          <p>
            Juridisk operatør og behandlingsansvarlig, organisasjonsopplysninger,
            personvernkontakt, behandlingsgrunnlag og oppbevaring hos underleverandører er ikke
            fastsatt og godkjent. Offentlig lansering er blokkert til ekte opplysninger og en
            konfidensiell kanal for personvernkrav er publisert.
          </p>
          <p>Ikke legg personopplysninger eller personvernkrav i en offentlig GitHub-sak.</p>
        </section>

        <div className="trust-grid">
          <section className="trust-card">
            <h2>På enheten din</h2>
            <p>
              Handlelisten og bekvemmelighetsvalget ligger i nettleserens lokale lagring. En
              startet handletur og avkrysninger ligger i IndexedDB. Appskall og statiske filer
              kan ligge i service worker-bufferen, men API-svar skal ikke bufres der.
            </p>
            <p>Du kan fjerne dette ved å tømme nettstedsdata i nettleseren.</p>
          </section>

          <section className="trust-card">
            <h2>Når du søker og planlegger</h2>
            <p>
              Søketekst, produktidentifikatorer, mengder og nødvendige valg sendes til serveren
              for å beregne svaret. Appen skal ikke lage en varig serverprofil, søkehistorikk
              eller handlekurv. Full ende-til-ende bevisføring mot logger og driftssystemer er
              ennå ikke ferdig.
            </p>
          </section>

          <section className="trust-card">
            <h2>Cloudflare og VPS</h2>
            <p>
              Den beskyttede alfaen bruker Cloudflare Access. Cloudflare kan derfor behandle
              innloggingsidentitet, informasjonskapsler, IP-adresse, tidspunkt, URL og
              nettlesermetadata. Cloudflare og VPS-en kan behandle tekniske forespørselsdata.
              Faktisk konfigurasjon, databehandlergrunnlag og oppbevaring må dokumenteres.
            </p>
          </section>

          <section className="trust-card">
            <h2>Prisdata og Kassalapp</h2>
            <p>
              Databasen inneholder kilde-, produkt-, pris-, tilbuds-, deknings- og driftsbevis,
              ikke brukerprofiler. Kassalapp-kall utføres av planlagte bakgrunnsjobber og skal
              ikke videresende den handlendes IP-adresse, identitet, handlekurv, søk eller
              posisjon. Kassalapp vil teknisk kunne se kilde-IP-en til bakgrunnsjobben på
              Handleplans VPS. Rettighetene for varig offentlig bruk av kilden er fortsatt
              uavklart.
            </p>
          </section>

          <section className="trust-card">
            <h2>Frivillig ruteberegning</h2>
            <p>
              Ruting er ikke aktivert. En framtidig startadresse eller posisjon skal bare
              behandles kortvarig etter et uttrykkelig valg og aldri lagres i nettleseren,
              URL-er, informasjonskapsler, logger, analyse, varig buffer, database,
              monitorering eller sikkerhetskopi.
            </p>
            <p>
              Geokoder, rutetjeneste, avtaler og personvernvurdering er ikke valgt og godkjent,
              så funksjonen må forbli av.
            </p>
          </section>

          <section className="trust-card">
            <h2>Analyse, reklame og dine valg</h2>
            <p>
              Appen har ingen vedtatt atferdsanalyse, reklameprofilering eller salg av
              handledata. Du kan bruke kjernefunksjonen uten Handleplan-konto, avstå fra
              framtidig posisjonsdeling og tømme lokale nettstedsdata.
            </p>
          </section>
        </div>

        <section className="trust-card trust-pending">
          <h2>Dokumentasjon og åpne blokker</h2>
          <p>
            Den fullstendige erklæringen, komponentoversikten og kravene til innsyn, retting,
            sletting, begrensning, protest, dataportabilitet og klage ligger i prosjektets åpne
            dokumentasjon. De manglende kontakt- og operatøropplysningene er uttrykkelige
            lanseringsblokker, ikke skjulte plassholdere.
          </p>
          <ul>
            <li>
              <a href="https://github.com/Reedtrullz/Handli/blob/main/docs/privacy/personvern.md">
                Full norsk personvernerklæring
              </a>
            </li>
            <li>
              <a href="https://github.com/Reedtrullz/Handli/blob/main/docs/security/data-flow-threat-model.md">
                Dataflyt og trusselmodell
              </a>
            </li>
            <li><a href="/status">Gjeldende datadekning og lanseringsstatus</a></li>
          </ul>
        </section>
      </main>
    </div>
  );
}
