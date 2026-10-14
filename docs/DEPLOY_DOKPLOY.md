# Deploy di OpenWA su Dokploy (server Oracle Cloud ARM)

Guida per pubblicare OpenWA sulla tua istanza **Dokploy** usando il file
[`docker-compose.dokploy.yml`](../docker-compose.dokploy.yml).

Configurazione di riferimento:
- **Server**: Oracle Cloud ARM Ampere A1 (arm64)
- **Database dati**: PostgreSQL (nel compose)
- **Esposizione**: dominio dedicato con HTTPS automatico (Let's Encrypt via Traefik di Dokploy)

> Architettura: Dokploy ha già il suo **Traefik** con SSL. Esponiamo al pubblico solo
> il container **`openwa-api`** (porta 2785): l'API NestJS serve anche la dashboard SPA
> compilata, oltre a `/api/` e `/socket.io/`. Un solo container e un solo dominio.

---

## 1. Prerequisiti

1. **Dokploy** installato e funzionante sul server Oracle.
2. Il repository **`MadeInBio/Dokploy-OpenWA`** su GitHub deve contenere il file
   `docker-compose.dokploy.yml` (vedi passo 2).
3. Un **(sotto)dominio** con record DNS **A** che punta all'**IP pubblico** del server, es:
   ```
   wa.miodominio.com   A   <IP_PUBBLICO_ORACLE>
   ```
   > Su Oracle Cloud ricordati di aprire le porte **80** e **443** sia nella
   > *Security List / Network Security Group* della VCN, sia nel firewall del SO
   > (`iptables`/`firewalld`), altrimenti Let's Encrypt e il traffico HTTPS non passano.

---

## 2. Porta il compose nel repository

Dokploy fa il deploy **clonando il repo da GitHub**, quindi il file
`docker-compose.dokploy.yml` deve essere committato e pushato sul branch che userai
(es. `main`):

```bash
git add docker-compose.dokploy.yml docs/DEPLOY_DOKPLOY.md
git commit -m "chore(deploy): aggiungi compose e guida per Dokploy"
git push origin main
```

---

## 3. Genera i segreti

Ti servono due valori casuali. Esempi:

PowerShell (Windows):
```powershell
# API_MASTER_KEY
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))
# DATABASE_PASSWORD
[Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Max 256 }))
```

Linux/macOS:
```bash
openssl rand -base64 48   # API_MASTER_KEY
openssl rand -base64 24   # DATABASE_PASSWORD
```

Conserva entrambi: `API_MASTER_KEY` è la chiave admin dell'API.

---

## 4. Crea il progetto Compose in Dokploy

1. **Dashboard Dokploy → Projects → Create Project** (es. nome `openwa`).
2. Dentro al progetto: **Create Service → Compose**.
3. **Provider**: *Git* → collega GitHub e seleziona il repo **`MadeInBio/Dokploy-OpenWA`**.
   - **Branch**: `main`
   - **Compose Path**: `./docker-compose.dokploy.yml`
4. **Compose Type**: `Docker Compose`.

---

## 5. Variabili d'ambiente

Nella scheda **Environment** del servizio Compose incolla (sostituendo i valori):

```env
DOMAIN=wa.miodominio.com
API_MASTER_KEY=<la-chiave-generata-al-passo-3>
DATABASE_PASSWORD=<la-password-generata-al-passo-3>
```

Queste variabili vengono interpolate dentro `docker-compose.dokploy.yml`
(`${DOMAIN}`, `${API_MASTER_KEY}`, `${DATABASE_PASSWORD}`).

Consigliata anche:

```env
TRUSTED_PROXIES=<subnet di dokploy-network>
```

La subnet la leggi con `docker network inspect dokploy-network` (campo `Subnet`). Senza,
OpenWA non si fida dell'header `X-Forwarded-For` di Traefik: tutte le richieste senza API key
condividono un solo budget di traffico, e gli `allowedIps` delle API key vedono l'IP di Traefik
invece di quello del client.

---

## 6. Dominio / HTTPS (UI Domains di Dokploy)

Assegna il dominio dalla UI di Dokploy puntando al servizio **openwa-api**:

1. Servizio Compose → tab **Domains → Create Domain**.
2. Imposta:

| Campo                      | Valore                 |
| -------------------------- | ---------------------- |
| **Host**                   | `www.owa.19062022.xyz` |
| **Service** (se richiesto) | `openwa-api`           |
| **Container Port**         | `2785`                 |
| **Path**                   | `/`                    |
| **HTTPS**                  | ON                     |
| **Certificate Provider**   | `Let's Encrypt`        |

3. Salva e fai **Redeploy**.

Dokploy genera da solo le label Traefik (routing + redirect HTTP→HTTPS) e richiede il
certificato. `openwa-api` resta su `dokploy-network` proprio per essere raggiunto dal
Traefik di Dokploy. Traefik ignora i container `unhealthy`: finché l'healthcheck non passa,
il dominio risponde 404.

> Il vecchio container `dashboard` (nginx, porta 80) non esiste più: un dominio che punta
> ancora lì fa fallire il deploy. Correggilo prima di premere Redeploy.
>
> La variabile `DOMAIN` nelle Environment resta necessaria: l'API la usa per
> `BASE_URL`/`DASHBOARD_URL`/`CORS_ORIGINS`. Tienila allineata all'Host.

---

## 7. Deploy

1. Premi **Deploy**.
2. Il primo deploy **builda da sorgente** (API + dashboard): su ARM Ampere richiede
   qualche minuto perché compila i moduli nativi e prepara Chromium.
3. Segui i **Logs** in Dokploy. Sei a posto quando vedi l'avvio di Nest e l'healthcheck
   dell'API diventa *healthy* (`/api/health/ready`, che verifica anche `main.sqlite` e
   Postgres).

Verifica:
```bash
curl https://wa.miodominio.com/api/health/ready
```

---

## 8. Primo avvio: API key e sessione WhatsApp

1. Apri `https://wa.miodominio.com` → la **dashboard**.
2. Autenticati / configura la **API key** usando la `API_MASTER_KEY` impostata.
   (In alternativa puoi creare una API key applicativa dalla dashboard o via endpoint
   protetto dalla master key.)
3. Crea una **sessione**, avviala e scansiona il **QR code** con WhatsApp
   (Dispositivi collegati → Collega un dispositivo).

Swagger/OpenAPI: `https://wa.miodominio.com/api/docs`

---

## 9. Persistenza e backup (IMPORTANTE)

Due volumi Docker tengono lo stato:

| Volume          | Contenuto                                                        |
| --------------- | --------------------------------------------------------------- |
| `openwa-data`   | `main.sqlite` (**API key + audit**), `sessions/` (**auth WhatsApp**), `media/`, `plugins/` |
| `postgres-data` | dati di sessioni/webhook/messaggi (PostgreSQL)                  |

> ⚠️ Se cancelli/perdi `openwa-data` devi **riscansionare il QR** di ogni sessione e
> perdi le API key. Includi entrambi i volumi nei backup. Dokploy offre backup
> programmati per i volumi/DB: configurali su `openwa-data` e sul database.

---

## 10. Note su risorse (ARM Ampere)

- Ogni sessione WhatsApp avvia un'istanza **Chromium** headless: stima **~300-500 MB RAM**
  per sessione. Con la A1 Flex (≥6 GB) gestisci tranquillamente più sessioni.
- Il `Dockerfile` installa Chromium dai pacchetti Debian **arm64** e lo collega a
  `PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/puppeteer-chrome`: nessuna configurazione extra
  per ARM. La versione di Chromium è quella che Debian ha al momento della build.
- `shm_size: 1gb` e `--disable-dev-shm-usage` nel compose prevengono i crash di Chromium
  dovuti a `/dev/shm` troppo piccolo.

---

## 11. Aggiornamenti

Questo repo è un fork di `rmyndharis/OpenWA` con due soli file in più
(`docker-compose.dokploy.yml` e questa guida), quindi le novità upstream entrano senza conflitti:

```bash
git remote add upstream https://github.com/rmyndharis/OpenWA.git   # solo la prima volta
git fetch upstream
git merge upstream/main
git push origin main
```

(o *Sync fork* dalla pagina del repo su GitHub). Poi **Redeploy** in Dokploy, che ricostruisce
l'immagine dal sorgente. I volumi persistono tra un deploy e l'altro.

**Prima di ogni aggiornamento fai un backup.** Dalla 0.24 un rollback non è più indolore: l'avvio
rifiuta un `main.sqlite` migrato da una versione più nuova, e un Chromium di major più vecchia
cancella i login WhatsApp salvati da quella più nuova. Senza backup, tornare indietro significa
riscansionare i QR e ricreare le API key.

```bash
P=<nome interno Dokploy>        # docker volume ls | grep openwa-data → il prefisso prima di _openwa-data
docker stop ${P}-openwa-api-1   # fermo, così il profilo Chromium è coerente (attende fino a 75 s)
docker run --rm -v ${P}_openwa-data:/d -v $PWD:/b alpine tar czf /b/openwa-data-$(date +%F).tgz -C /d .
docker exec ${P}-postgres-1 pg_dump -U openwa openwa | gzip > openwa-pg-$(date +%F).sql.gz
```

Dopo il Redeploy il primo avvio può metterci più del solito: le migrazioni costruiscono indici
sulle tabelle dei messaggi, e finché non finiscono l'healthcheck resta rosso. Le note di
aggiornamento di ogni versione sono nel `CHANGELOG.md`, sezioni *Upgrade notes*.

---

## 12. Cosa è stato escluso rispetto al `docker-compose.yml` originale (e perché)

| Elemento                         | Stato      | Motivo                                                                 |
| -------------------------------- | ---------- | --------------------------------------------------------------------- |
| Servizio **Traefik** interno     | rimosso    | Dokploy ha già il suo Traefik con SSL automatico.                     |
| **Port binding** `127.0.0.1:...` | rimosso    | L'esposizione la gestisce il Traefik di Dokploy via label.            |
| Mount `/var/run/docker.sock`     | rimosso    | Evita di esporre il socket Docker; la sezione "infra" della dashboard è degradata, l'app funziona. |
| Profili `minio` / `redis`        | non inclusi| Storage locale e niente code/cache nel deploy base. Aggiungibili in seguito. |

### (Opzionale) Riabilitare Redis per code/BullMQ
Se in futuro vuoi le code BullMQ + Bull Board, aggiungi un servizio `redis:7-alpine`
sulla rete `openwa-internal` e imposta sull'API:
`REDIS_ENABLED=true`, `REDIS_HOST=redis`, `REDIS_PORT=6379`.
