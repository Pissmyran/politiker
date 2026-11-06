# REPO.md

## What this is
A web app for writing to politicians, agencies, newsrooms and researchers from your own email account, plus Python tools that maintain the public contact registry.

## Stack
- App: TypeScript on a Cloudflare Worker (D1, KV, R2, Queues, Durable Objects), Wrangler, Node's built-in test runner, plain static JS in `app/public/`.
- Contact tools: Python with pytest.
- Docs: Markdown built with Zensical, published on GitHub Pages.
- Self-hosting: Docker image running the Worker locally in workerd.

## Commands
From `app/`:
- `npm ci`: install.
- `npm test`: unit tests.
- `npm run validate`: tests, script syntax check, local D1 migrations, typecheck and deploy dry run. This is the full check.
- `npm run dev`: run locally.

From `kontakter/`: `pip install -r requirements-dev.txt requests pypdf dnspython`, then `python -m pytest -q`.

There is no lint script.

## Where things live
- `shared/`: code used by both the Worker and the Docker setup.
- `infra/migrations/`: D1 schema; change the schema only with new migrations.
- `docs/`: Swedish docs; `docs/eng/` has the English copies. `site-docs/` and `site/` are generated, never edit them.
- `cloudflare.example.env`: every placeholder (`__NAME__`) the source uses; real values never enter the repo.

## Deploy and release
- Production deploys from a rendered copy (`tools/render.mjs`) or via Workers Builds on merge to `main`.
- A merge to `main` that bumps `version.txt` tags and releases automatically and publishes the Docker image.
- Migrations are not run on deploy; apply them manually (see `docs/operations.md`).

## Repo-specific rules
- CI runs no tests: run `npm run validate` before every push.
