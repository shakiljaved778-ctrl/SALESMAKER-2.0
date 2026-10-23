# Demo hosting: Vercel + Neon + your computer

The temporary way to have SalesMaker online (ADR-0032) before the AWS deployment (ADR-0003):

| Part                                    | Runs on                                 | Cost |
| --------------------------------------- | --------------------------------------- | ---- |
| Website                                 | Vercel (your existing project)          | free |
| Databases                               | Neon free tier                          | free |
| API, worker, control plane, Redis, mail | Docker on your computer (`infra/demo/`) | free |
| Public address for the APIs             | ngrok free static domain                | free |

The demo is online **only while your computer is on and Docker is running**.

You need: **Docker Desktop** (running), **Git**, and about 30 minutes. Everything else runs inside Docker.

## 1. Get the code

```bash
git clone https://github.com/shakiljaved778-ctrl/SALESMAKER-2.0.git
cd SALESMAKER-2.0
git checkout claude/great-heisenberg-pbhzs3
cp infra/demo/demo.env.example infra/demo/demo.env
```

Open `infra/demo/demo.env` in a text editor; the next steps fill it in.

## 2. Neon (the databases)

1. Sign up at [neon.tech](https://neon.tech) and create a project. Region: **AWS Europe Central 1 (Frankfurt)**,
   Postgres **16** or newer.
2. **Databases → New database** twice: `salesmaker_cell` and `salesmaker_cp` (owner: `neondb_owner`).
3. **Connect**: choose database `salesmaker_cell`, role `neondb_owner`, and turn **Connection pooling off**. Copy
   the connection string into `NEON_CELL_URL`. Do the same for `salesmaker_cp` → `NEON_CP_URL`.
   Both look like `postgresql://neondb_owner:…@ep-….eu-central-1.aws.neon.tech/salesmaker_cell?sslmode=require`.

## 3. ngrok (the public address)

1. Sign up at [ngrok.com](https://ngrok.com) (free).
2. **Your Authtoken** → copy it into `NGROK_AUTHTOKEN`.
3. **Domains** → your free static domain (e.g. `brave-otter-123.ngrok-free.app`) → `NGROK_DOMAIN`, without
   `https://`.

## 4. The rest of `demo.env`

- `WEB_BASE_DOMAIN`: your Vercel address without `https://`, e.g. `salesmaker-20-web.vercel.app`.
- `SEED_PASSWORD`: the password all demo users sign in with. The demo is public: use 12+ characters.
- `DEMO_ALIASES`: one `vercel.app` address per demo workspace. Pick names nobody has taken, e.g.
  `pixelcraft-demo=pixelcraft-yourname.vercel.app,aurelia-demo=aurelia-yourname.vercel.app`.

## 5. Start the backend

From the repository folder:

```bash
docker compose -f infra/demo/docker-compose.yml run --rm --build init    # keys, Neon setup, migrations (~5 min)
docker compose -f infra/demo/docker-compose.yml up -d --build            # api, worker, control plane, tunnel
docker compose -f infra/demo/docker-compose.yml run --rm seed            # the two demo workspaces (~2 min)
docker compose -f infra/demo/docker-compose.yml run --rm aliases         # their vercel.app addresses
```

Check: open `https://<NGROK_DOMAIN>/health/ready`. It should show `"status":"ready"`.

`init` keeps its keys and passwords in `infra/demo/.state/` (never commit or share that folder). It is safe to run
again; delete `.state/` only if you also start over with empty Neon databases.

## 6. Vercel

1. **Settings → Environment Variables** (Production), then save:

   | Key                            | Value                           |
   | ------------------------------ | ------------------------------- |
   | `CONTROL_API_BASE_URL`         | `https://<NGROK_DOMAIN>`        |
   | `WEB_BASE_DOMAIN`              | the same value as in `demo.env` |
   | `WEB_URL_SCHEME`               | `https`                         |
   | `ENABLE_EXPERIMENTAL_COREPACK` | `1`                             |

   Leave `STORAGE_PUBLIC_ORIGIN` out: the demo has no file storage, so imports are unavailable.

2. **Settings → Domains → Add**: each address from `DEMO_ALIASES` (e.g. `pixelcraft-yourname.vercel.app`).
3. **Deployments → latest → ⋯ → Redeploy** (new variables only apply to new deployments).

## 7. Use it

Open `https://pixelcraft-yourname.vercel.app` and sign in as **maya@pixelcraft.example** with your
`SEED_PASSWORD` (the bank demo: `aisha.saleh.001@aurelia-bank.example`). Emails the app sends (invitations, password
resets) appear at http://localhost:8025 on your computer.

## Day to day

- **Stop**: `docker compose -f infra/demo/docker-compose.yml stop`. **Start again**: `… up -d`.
- **After pulling new code**: `… run --rm init` (applies new migrations), then `… up -d --build`.
- **Logs**: `docker compose -f infra/demo/docker-compose.yml logs -f api` (or `worker`, `control-api`, `tunnel`).

## Limits

- Signing up a **new** workspace, and "find my workspace" links, point at `{slug}.{WEB_BASE_DOMAIN}`, which
  `vercel.app` cannot serve. They work once you add a custom domain (then follow `deploy.md`).
- No object storage: imports are unavailable. No real email: it stays in Mailpit.
- Neon's free compute sleeps when idle; the first request after a pause takes a few seconds. Running the backend
  around the clock uses more than the free monthly compute hours.

## Troubleshooting

| Symptom on the website                           | Cause and fix                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| "This deployment is not configured yet"          | A Vercel variable is missing; the page names it. Add it and redeploy.                   |
| "We're making improvements" (maintenance)        | The website cannot reach the control plane: Docker stopped, or `tunnel` is not running. |
| 404 on the workspace address                     | The alias is missing: run `… run --rm aliases`, and add the domain in Vercel.           |
| `init` stops with "Set … in infra/demo/demo.env" | Fill in that value (step 2–4) and run it again.                                         |
