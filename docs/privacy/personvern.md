# Personvernerklæring for Handleplan

**Status:** norsk åpenhetsutkast for beskyttet alfa, sist oppdatert 17. juli
2026. Utkastet er ikke juridisk godkjent og er ikke grunnlag for å åpne
tjenesten offentlig.

## Behandlingsansvarlig og kontakt

Juridisk operatør og behandlingsansvarlig er ikke fastsatt eller publisert.
Organisasjonsnummer, postadresse, personvernkontakt og konfidensiell kanal for
innsyn, sletting, protest og klage mangler. Disse opplysningene og en juridisk
vurdering må være på plass før offentlig lansering. Ikke legg personopplysninger
eller personvernkrav i en offentlig GitHub-sak.

## Hva tjenesten behandler

Handleplan er laget for anonym bruk uten konto i selve appen.

- **På enheten:** handleliste og bekvemmelighetsvalg lagres i nettleserens
  lokale lagring. En startet handletur og avkrysninger lagres i IndexedDB.
  Service worker-bufferen inneholder appskall og statiske filer, ikke API-svar.
  Du kan fjerne dette ved å tømme nettstedsdata i nettleseren.
- **Ved planlegging og søk:** produktidentifikatorer, mengder, søketekst og
  nødvendige valg sendes til Handleplan-serveren og behandles for å svare.
  Appen skal ikke lagre handlekurven eller søket varig på serveren, men full
  ende-til-ende dokumentasjon med sentineltester er ikke ferdig.
- **Beskyttet alfa:** Cloudflare Access kan behandle innloggingsidentitet,
  informasjonskapsler, IP-adresse, tidspunkt, URL og enhets-/nettlesermetadata.
  Cloudflare og VPS-infrastruktur kan behandle tekniske forespørselsmetadata.
  Faktisk konfigurasjon, databehandlergrunnlag og oppbevaringstid må
  dokumenteres før offentlig lansering.
- **Pris- og driftsdata:** PostgreSQL inneholder kilde-, produkt-, pris-,
  tilbuds-, deknings- og driftsbevis. Den offentlige webrollen er skrivebeskyttet.
  Databasen skal ikke inneholde handlekurv, søkehistorikk eller startposisjon.
- **Kassalapp:** planlagte bakgrunnsjobber kan hente katalog- og prisdata.
  Handleplan skal ikke videresende den handlendes IP-adresse, identitet,
  handlekurv, søk eller posisjon til Kassalapp. Kassalapp vil teknisk kunne se
  kilde-IP-en til bakgrunnsjobben på Handleplans VPS.
  Kildetillatelse for varig offentlig bruk er fortsatt uavklart, og kilden kan
  derfor ikke gi grunnlag for offentlig rangering nå.
- **Analyse og reklame:** appen har ingen vedtatt atferdsanalyse,
  reklameprofilering eller salg av handledata. Ny analyse krever en egen,
  dokumentert beslutning og rettslig vurdering.

## Frivillig ruteberegning

Ruteberegning er ikke aktivert. Hvis den innføres, skal den være frivillig og
først starte etter et tydelig valg. Et startpunkt, en adresse, koordinater,
posisjonsnavn eller startnær rutegeometri skal aldri skrives til lokal lagring,
URL, informasjonskapsel, app-/proxylogg, analyse, varig buffer, database,
monitorering eller sikkerhetskopi. Bare nødvendige koordinater skal behandles
kortvarig i minnet og sendes til den valgte geokoder/rutetjenesten. Det
offentlige svaret skal bare inneholde valgte butikkstopp og samlet tid/avstand.

Geokoder og rutetjeneste, databehandlerrolle, behandlingsgrunnlag,
oppbevaring, produksjonskvote og avtalevilkår er ikke valgt og godkjent.
Funksjonen må forbli av til dette og automatiske ikke-lagringstester er
godkjent. Hvis ruting feiler, skal appen gå tilbake til en sammenhengende
prisbasert plan uten å lagre startpunktet.

## Formål, grunnlag, deling og oppbevaring

Det tilsiktede formålet er å beregne og forklare en forespurt handleplan, sikre
tjenesten og holde kilde-/prisbevis etter dokumenterte tillatelser. Rettslig
grunnlag for Cloudflare, eventuell ruting, sikkerhetslogging og den endelige
offentlige tjenesten er ikke juridisk vurdert og kan derfor ikke oppgis som
avklart.

Lokale appdata beholdes til brukeren tømmer nettstedsdata. Appserveren skal
ikke ha en varig brukerprofil. Oppbevaring hos Cloudflare, i framtidig
monitorering og i sikkerhetskopier er ikke ferdig definert. Pris-/kildedata
beholdes bare etter kildetillatelsen og produktets revisjonskrav. Ingen
persondata skal selges eller deles for målrettet reklame.

## Dine valg og rettigheter

Du kan bruke kjernefunksjonen uten Handleplan-konto, avstå fra framtidig
posisjonsdeling og tømme lokale nettstedsdata. En virkelig privat kontakt for
innsyn, retting, sletting, begrensning, protest, dataportabilitet og klage skal
publiseres med identiteten til behandlingsansvarlig. Før det finnes, er denne
delen ufullstendig og offentlig lansering blokkert.

Se [dataflyt og trusselmodell](../security/data-flow-threat-model.md) for
komponentgrenser og [offentlig-gode-styring](../governance/public-good-governance.md)
for finansiering, rangering og rettelser.
