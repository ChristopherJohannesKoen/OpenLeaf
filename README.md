# OpenLeaf

A modular, self-hosted LaTeX writing service — a personal, customisable
Overleaf-style tool. The repository root is the **back end**: an HTTP API that
stores projects, compiles them to PDF and keeps their history. The **front end**
(the editor you open in a browser) is in [`web/`](web/README.md); any other
front end (desktop, a script, a notebook) can be built on the same API.

- **Runtime:** Node.js 22 + TypeScript + Fastify
- **Storage:** PostgreSQL (projects, files, PDFs, history — everything)
- **Compiling:** TeX Live with `latexmk`; pdfLaTeX, XeLaTeX and LuaLaTeX
- **Hosting:** one Docker image; a Render Blueprint is included (`render.yaml`)

Interactive API documentation is served by every instance at **`/docs`**
(OpenAPI JSON at `/docs/json`).

## What it does

| Module | What you get |
| --- | --- |
| `auth` *(core)* | Accounts, sign-in sessions, personal API tokens for scripts. First account is the owner. |
| `projects` *(core)* | Projects with name, description, tags, main file, engine, free-form settings; archive, trash, duplicate. |
| `files` | File tree: read/save text (with conflict detection), upload binaries, folders, move/rename, delete; zip export, zip import, full backup of all projects. |
| `compile` | Compile to PDF; structured errors and warnings with file and line; raw logs; SyncTeX (source ⇄ PDF); result caching; background compiles. |
| `history` | Named versions, automatic versions after successful compiles, per-file diffs, restore (with automatic backup), zip of any version. |
| `templates` | Built-in starters (article, thesis/report, beamer, notes, assignment) and saving your own projects as templates. |
| `settings` | Per-user preferences as free-form JSON merged over defaults (editor, compile, layout, snippets). |
| `share` | Read-only links to a project's latest PDF for people without an account. |
| `system` *(core)* | `/healthz`, `/api/system/info`. |

## Design

```
src/
  server.ts            entry point
  app.ts               builds the Fastify app, runs migrations, loads modules
  config.ts            every setting, read from environment variables
  core/                database, migrations, module system, event bus, path safety
  modules/
    index.ts           the list of modules  <- add yours here
    auth/ projects/ files/ compile/ history/ templates/ settings/ share/ system/
test/                  unit + end-to-end tests (real Postgres, real LaTeX)
```

A **module** is one object (`OpenLeafModule` in `src/core/modules.ts`) with a
name, its own SQL migrations, a `register` function that adds routes, and
optional dependencies on other modules. Modules talk to each other through a
small **event bus** (`project.compiled`, `project.deleted`, …) instead of
calling each other, which is what lets you switch them off:

```
OPENLEAF_DISABLED_MODULES=share,templates
```

Design choices worth knowing:

- **Postgres is the only source of truth.** Compiled PDFs and SyncTeX data are
  stored in the database too, so nothing is lost when the server restarts or
  its disk is wiped (which happens on every deploy on most hosts). The compile
  folder on disk is only a cache that makes repeat compiles fast.
- **Compiles are sandboxed by configuration.** LaTeX runs as a non-root user
  with a minimal environment (it never sees `DATABASE_URL`), cannot read or
  write outside the project folder (`openin_any=p`), may only run TeX Live's
  short list of safe helper programs, ignores `latexmkrc`, and is killed
  (whole process tree) after a time limit.
- **Saving is conflict-safe.** Every file has a version number; send the one
  you loaded as `baseVersion` and a stale save is rejected with `409` instead
  of silently overwriting newer work.

## Quick tour of the API

All routes except registration, login, health and share links need
`Authorization: Bearer <token>`.

```bash
API=https://your-instance.onrender.com

# 1. create your account (the first account becomes the owner)
curl -sX POST $API/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase","displayName":"You","inviteCode":"…"}'
TOKEN=olf_…   # from the response
AUTH="authorization: Bearer $TOKEN"

# 2. start a project from a template
curl -sX POST $API/api/templates/article/projects -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"My first paper"}'
P=…           # project.id from the response

# 3. edit a file
curl -sX PUT $API/api/projects/$P/files/content -H "$AUTH" -H 'content-type: application/json' \
  -d '{"path":"main.tex","content":"\\documentclass{article}\\begin{document}Hello\\end{document}"}'

# 4. upload a figure
curl -sX POST $API/api/projects/$P/files/upload -H "$AUTH" -F folder=figures -F file=@plot.pdf

# 5. compile, then fetch the PDF
curl -sX POST $API/api/projects/$P/compile -H "$AUTH" -H 'content-type: application/json' -d '{}'
curl -s $API/api/projects/$P/output.pdf -H "$AUTH" -o paper.pdf

# 6. back up everything
curl -s $API/api/export/projects.zip -H "$AUTH" -o openleaf-backup.zip
```

The compile response looks like this:

```json
{
  "compile": {
    "id": "…", "status": "failure", "engine": "pdflatex", "mainFile": "main.tex",
    "hasPdf": true, "errorCount": 1, "warningCount": 2, "durationMs": 2140, "cached": false,
    "diagnostics": [
      { "level": "error", "file": "chapters/one.tex", "line": 12,
        "message": "Undefined control sequence.", "context": "\\undefinedmacro", "source": "latex" }
    ],
    "links": { "pdf": "/api/projects/…/output.pdf?compile=…", "log": "/api/projects/…/output.log?compile=…" }
  }
}
```

`status` is one of `success`, `failure` (LaTeX errors — a PDF may still exist),
`timeout`, `error`, or `queued`/`running` when you compile with `?wait=false`.

## The front end

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

By default the dev server forwards `/api` to the hosted instance, so the API does
not have to run on your computer; set `OPENLEAF_API=http://localhost:3000` to use
a local one. The sign-in screen also offers a sample library that needs no
service at all. Details are in [`web/README.md`](web/README.md).

## Running the API locally

You need Node 22+, PostgreSQL 13+, and a TeX installation with `latexmk`.

```bash
npm install
cp .env.example .env          # set DATABASE_URL
export $(grep -v '^#' .env | xargs)
npm run dev                   # http://localhost:3000/docs
```

Or with Docker (TeX Live included):

```bash
docker build -t openleaf .
docker run -p 10000:10000 -e PORT=10000 -e DATABASE_URL=postgres://… openleaf
```

Tests use a real database and real LaTeX:

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/openleaf_test npm test
```

## Deploying on Render

`render.yaml` is a Blueprint that creates the database, the API and the front
end and wires them together: **Dashboard → New → Blueprint →** pick this
repository. Migrations run automatically at start-up.

The hosted instance of this repository:

| | address |
| --- | --- |
| The site (open this) | https://openleaf-cw3y.onrender.com |
| The API | https://openleaf-api.onrender.com (`/docs`, `/healthz`) |

The API and the site are two services. The site is built with
`VITE_API_URL` set to the API's address, and the API's `CORS_ORIGINS` is set to
the site's address, so only that site may call it from a browser. If either
address changes (a custom domain, a renamed service), change the matching
variable and redeploy.

Both services are set to deploy on every push to `main`, but Render only hears
about a push once the Render account is connected to GitHub with access to this
repository (Render → Account settings → Git providers). Until then, deploy by
hand after a push: **Manual Deploy → Deploy latest commit** on each service.
A private repository needs the same connection before Render can read it at all.

Things to know about Render's free plans:

- **The free PostgreSQL database is deleted 30 days after it is created** unless
  it is upgraded to a paid plan. Download a backup
  (`GET /api/export/projects.zip`) regularly, or upgrade the database.
- The free web service sleeps after 15 minutes without requests (the next
  request takes about a minute) and has 0.1 CPU / 512 MB, so compiles are
  several times slower than on a laptop. The Starter plan removes both limits.
- The static site is free and does not sleep: the sign-in screen opens at once
  and waits there for the API to wake.

## Configuration

Everything is an environment variable; see `.env.example` for the full list.
The ones you are most likely to touch:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres connection string (required) |
| `REGISTRATION` | `first-user`, or `invite` if `INVITE_CODE` is set | Who may create accounts: `first-user`, `invite`, `open`, `closed` |
| `INVITE_CODE` | — | Secret needed to register in `invite` mode |
| `AUTH_PROVIDER` | `local` | `local`: OpenLeaf keeps a hashed password per account. `firebase`: people sign in with Google through Firebase Authentication and OpenLeaf keeps no password (see below) |
| `FIREBASE_PROJECT_ID` / `FIREBASE_API_KEY` | — | The Firebase project and its web API key (required with `AUTH_PROVIDER=firebase`; neither is a secret) |
| `CORS_ORIGINS` | `*` | Browser origins allowed to call the API |
| `OPENLEAF_DISABLED_MODULES` | — | Comma-separated optional modules to switch off |
| `DEFAULT_ENGINE` | `pdflatex` | Engine for new projects |
| `COMPILE_TIMEOUT_MS` | `180000` | Hard limit per compile |
| `COMPILE_SHELL_ESCAPE` | `restricted` | `off`, `restricted` or `full` (needed by `minted`; trusted users only) |
| `ALLOW_LATEXMKRC` | `false` | Honour a project's `latexmkrc` (it can run arbitrary code) |
| `MAX_UPLOAD_BYTES` / `MAX_PROJECT_BYTES` | 25 MB / 150 MB | Size limits |

### Signing in with Google (Firebase Authentication)

With `AUTH_PROVIDER=firebase` the sign-in screen shows **Continue with Google**
instead of an email and password form. Google's own window asks which account;
Firebase hands the browser a short-lived token; `POST /api/auth/firebase` checks
that token (signature by Google's published keys, issued for this project, a
verified email address, a Google sign-in) and answers with an ordinary OpenLeaf
session. So:

- **OpenLeaf keeps no password.** `register`, `login` and change-password are
  refused; the `users` table holds an email address and Firebase's id for the
  account, nothing to steal a sign-in with.
- **`REGISTRATION` and `INVITE_CODE` still decide who gets an account.** Anyone
  can prove a Google account, so on an invite-only instance a Google account
  that is new here is asked for the invite code once; after that it signs in
  with one click. The first account made is the owner.
- Scripts are unaffected: personal API tokens (`/api/auth/tokens`) work as before.

To set it up: in the [Firebase console](https://console.firebase.google.com)
create a project, switch on **Authentication → Sign-in method → Google**, add
the front end's address under **Authentication → Settings → Authorised
domains**, and register a web app to get the project id and API key. Then set
`AUTH_PROVIDER`, `FIREBASE_PROJECT_ID` and `FIREBASE_API_KEY` on the API. The
front end needs no setting of its own: it asks the API how to sign in.

## Customising

**Add LaTeX packages.** The package set is a Docker build argument:

```bash
docker build --build-arg TEX_EXTRA_PACKAGES="texlive-lang-european texlive-fonts-extra" .
```

(On Render, add `TEX_EXTRA_PACKAGES` as an environment variable — Render passes
environment variables to Docker builds as build arguments.)

**Add an engine.** Write an `Engine` object and call `registerEngine` — see
`src/modules/compile/engines.ts`. The only contract is "run in this folder and
leave `<jobName>.pdf` behind", so Tectonic, ConTeXt or a pandoc pipeline fit.

**Add a template.** Add an entry to `src/modules/templates/builtin.ts`, or save
any project as a personal template with `POST /api/templates`.

**Add a module.** Create `src/modules/<name>/index.ts`:

```ts
import type { OpenLeafModule } from '../../core/modules.js';

export const wordCountModule: OpenLeafModule = {
  name: 'wordcount',
  description: 'Counts words in a project.',
  dependsOn: ['projects'],
  migrations: [],                         // optional: [{ id: '001_init', sql: 'CREATE TABLE …' }]
  register(app, { db, config, events }) {
    app.get('/api/projects/:projectId/wordcount', { onRequest: [app.authenticate] }, async (req) => {
      // …
    });
    events.on('project.compiled', async ({ projectId }) => { /* react to other modules */ });
  },
};
```

and add it to the list in `src/modules/index.ts`. Its migrations are applied
automatically at the next start, tracked per module.

## Not included (yet)

Real-time collaborative editing, Git sync and spell-checking are not part of
this back end. The file API's version checks are the hook for adding
collaborative editing later.

## Licence

Private project for personal and research use.
