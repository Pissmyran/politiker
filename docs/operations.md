# Drift

## Kontroller före push

Från `app/`:

```bash
npm ci
npm run validate
```

`validate` kör enhetstesterna, testerna av produktionskontrollen, syntaxkontrollen av skripten i `public/`, de lokala D1-migreringarna, typgenereringen, typkontrollen och `wrangler deploy --dry-run`.

För `kontakter/`: `pip install -r requirements-dev.txt requests pypdf dnspython` och `python -m pytest -q` i den katalogen.

## Lokal utveckling

```bash
cd app
npm run dev
```

## Driftsättning

Produktionen driftsätts från en renderad kopia, antingen från din dator eller med Workers Builds när en PR mergas till `main`; se `README.md`. CI på GitHub kör inga tester: kör kontrollerna ovan själv före varje push. Workflows bygger dokumentationen (Pages och wiki), skapar release och publicerar Docker-imagen, och CodeQL skannar koden. Det finns ingen förhandsmiljö. Kontaktregistret uppdateras separat, inte vid driftsättning.

## Publicera Docker-imagen

`.github/workflows/docker.yml` bygger och publicerar imagen när en versionstagg (`v1.2.3`) pushas, eller när `release.yml` anropar den.

- **Namn:** Docker Hub-namnrymden kommer från repo-variabeln `DOCKERHUB_USERNAME` och repo-namnet från GitHub (`github.event.repository.name`). Inget av dem står i workflowen. Imagen heter `docker.io/<DOCKERHUB_USERNAME>/<repo>`.
- **Token:** hemligheten `DOCKERHUB_TOKEN` ligger i miljön `release`.
- **Saknad variabel:** körningen stoppas direkt med ett tydligt fel, innan något byggs eller publiceras. GitHub-releasen finns redan då. Sätt variabeln och kör om workflowen.
- **Taggar:** den exakta versionen pushas först. De rörliga taggarna (`minor`, `major`, `latest`) flyttas bara av den nyaste stabila releasen de står för; en prerelease flyttar ingen, och en äldre stabil release flyttar bara de av `minor`- och `major`-taggarna i sin egen serie där den fortfarande är nyast, aldrig `latest`. En misslyckad push av en rörlig tagg stoppar inte de andra men gör jobbet rött, och en omkörning pushar den exakta versionen och bara de rörliga taggar releasen fortfarande har rätt att flytta. Om listan över releasetaggar inte kan hämtas blir jobbet rött och rörliga taggar som redan pushats ligger kvar. En version som ännu saknar `v`-releasetagg (till exempel en manuell körning på en outgiven version) flyttar ingen rörlig tagg, och det gör inte heller en version vars tagg pekar på en annan commit än den som publiceras. Tidigare pushar av rörliga taggar kan redan ha lyckats när en uppslagning misslyckas, så kontrollera de rörliga taggarna innan du åtgärdar.
- **Samtidighet:** varje release har en egen körning, och ingen körning ersätts eller avbryts. Före och efter varje push av en rörlig tagg görs en ny uppslagning av releasetaggarna; dyker en nyare release upp medan taggen pushas blir jobbet rött, och den nyare releasens workflow körs om så att taggen pekar på den.
- **Missad release:** `release.yml` körs vid varje push till `main` men skapar bara en release när versionen saknar `v`-tagg. Dess `release`-grupp rymmer en väntande körning, så om flera versionshöjningar mergas inom några sekunder kan en tidigare väntande körning ersättas och den versionen får varken tagg, release eller image. Vänta tills varje versions `Release`-körning är klar innan nästa versionshöjning mergas. Åtgärda inom 30 dagar genom att köra om den ersatta `Release`-körningen under Actions. Finns taggen redan men imagen saknas hoppar en omkörning över Docker; kör då workflowen `Docker` manuellt på versionstaggen. Efter 30 dagar skapar du den saknade releasen med `gh release create v<version> --target <ursprunglig commit>` och kör sedan `Docker` manuellt på den taggen.

## Migreringar

Migreringarna ligger i `infra/migrations/`. Workers Builds kör dem inte, så de körs för hand från en renderad kopia:

```bash
node tools/render.mjs <din-fil.env> build
npx wrangler d1 migrations apply DB --remote --cwd build/app
```

1. Schemaändringar görs bara med nya migreringar.
2. En migrering som lägger till körs före deployen av den nya Workern, en som tar bort efter.
3. Kör `npm run validate` först; den provar migreringarna lokalt.

## Kontroll efter driftsättning

```bash
node build/scripts/verify-production.mjs
```

Den kontrollerar att startsidan svarar `200`, och skiljer en blockering i Cloudflares kant (till exempel en utmaning) från ett fel i Workern. Varje kontroll görs upp till fem gånger.

## Felsökning av utskick

Kontrollera i den här ordningen:

1. utskickets state i D1;
2. kön: väntande jobb och nya försök;
3. DLQ;
4. `CredentialRateLimiter` och e-postkontots gräns;
5. felet från e-postleverantören.

Kör aldrig om ett jobb i kön först; utskickets state i D1 och kön måste stämma överens, annars kan ett brev skickas två gånger.

### Fel på ett sparat e-postkonto

1. **Bekräfta inloggningen:** känsliga åtgärder kräver en inloggning som är högst 15 minuter gammal. Sidan ber om lösenord och tvåstegsverifiering, eller skickar ett konto som bara använder Google eller Microsoft dit, utan att du loggas ut.
2. **"Det sparade SMTP-lösenordet kan inte dekrypteras":** det sparade lösenordet går inte att läsa med nuvarande `MAIL_CRED_KEY`. Byt aldrig `MAIL_CRED_KEY` för att felsöka; använd **Uppdatera lösenord**, som provar och krypterar om lösenordet.
3. **Fel `535` från servern:** SMTP-servern avvisade inloggningen. Många leverantörer kräver ett appspecifikt lösenord.
4. **Leverans:** först när kontot loggar in är det dags att titta på utskickets state, kön och mottagarnas svar.

**Uppdatera lösenord** provar det nya lösenordet mot servern innan det sparas, så ett misslyckat försök ändrar inget.

## Bilagor

Kontrollera bindningen, objektnyckeln och kopplingen i D1 innan något raderas eller skrivs om i R2. Använd aldrig bilagornas innehåll för felsökning.

## Inloggning och sessioner

Kontrollera i den här ordningen: route, sessionen i KV, kontot i D1 och sist lösenords-, TOTP- eller OAuth-flödet. Gör aldrig en privat route publik för att lösa ett inloggningsfel.

Lägg aldrig inloggningsuppgifter, nycklar, mejlinnehåll eller privata API-data i loggar.

## Konfiguration av kodgranskning

`.coderabbit.yaml` använder `inheritance: true` för att ärva
`pissmyran/coderabbit/.coderabbit.yaml`. Bara projektspecifika granskningsråd finns
lokalt. De omfattar även bilagor och dokumentimport, webbläsarbeteende och
tillgänglighet, apptester, återhämtning av kön, migreringar, låsfiler och spegeln
under `docs/eng`.

Enligt [CodeRabbits arvsregler](https://docs.coderabbit.ai/configuration/configuration-inheritance)
behålls unika centrala listposter, medan en lokal post med samma `path` ersätter
den centrala posten. Överlappande men olika sökvägsmönster behålls båda.
Skannrar, granskningsomfattning, rådgivande kontroller samt avstängda automatiska
godkännanden och kreditanvändande funktioner styrs fortsatt centralt.

Vid ändringar: validera YAML-syntax och dubbla nycklar, kontrollera mot
[aktuellt schema](https://coderabbit.ai/integrations/schema.v2.json) och kontrollera
att varje sökvägsmönster täcker avsedda versionshanterade filer. Jämför med den
centrala konfigurationen så att unika säkerhetsråd bevaras vid sammanslagningen.
