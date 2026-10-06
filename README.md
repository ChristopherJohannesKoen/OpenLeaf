# OpenLeaf

A modular, self-hosted LaTeX writing service — a personal, customisable
Overleaf-style tool. The repository root is the **back end**: an HTTP API that
stores projects, compiles them to PDF, keeps their history and can save each one
to a GitHub repository of its own. The **front end** (the editor you open in a
browser) is in [`web/`](web/README.md); any other front end (desktop, a script,
a notebook) can be built on the same API.

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
| `share` | Read-only links to a project's latest PDF for people without an account. They expire (30 days unless asked otherwise). |
| `github` | Link a GitHub account with a one-time code, give each project a repository of its own, and save the project to it as commits. |
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
    auth/ projects/ files/ compile/ history/ templates/ settings/ share/ github/ system/
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
- **Compiles are kept apart from the service.** LaTeX is a programming
  language, so a project's files are treated as untrusted. TeX's own switches
  come first: a minimal environment (it never sees `DATABASE_URL`), no reading
  or writing outside the project folder (`openin_any=p`), only TeX Live's short
  list of safe helper programs, `latexmkrc` ignored, a time limit. Under them,
  the operating system: every compile is started through a small launcher
  (`native/sandbox.c`) that leaves it **no network of any kind**, no way to look
  into another process, and (on kernels with Landlock) a view of the file system
  that holds only the TeX installation and its own folders; it has memory and
  file-size ceilings; and the service itself is started with a guard
  (`native/guard.c`) that closes its memory and environment to the programs it
  starts. None of this needs privileges or namespaces, so it works on container
  hosts that allow neither; where namespaces are allowed they are used as well.
  The service checks at start-up what the host supports, drops a layer only if
  TeX cannot compile inside it, and reports the result in
  `GET /api/system/info`. See [`SECURITY.md`](SECURITY.md).
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

The dev server forwards `/api` to an API on this machine (`http://localhost:3000`;
set `OPENLEAF_API` for another address). The sign-in screen also offers a sample
library that needs no service at all. Details are in
[`web/README.md`](web/README.md).

A hosted instance that signs people in with Google cannot be used from a
development server: Google sign-in is tied to the hosted site's own address. So
develop against a local API, which signs in with an email and password.

## Running the API locally

The short way, with Docker (PostgreSQL and TeX Live included):

```bash
docker compose up --build     # http://localhost:3000/docs
```

The first account made becomes the owner. `docker compose down -v` throws the
local data away.

Without Docker you need Node 22+, PostgreSQL 13+, and a TeX installation with
`latexmk`:

```bash
npm install
cp .env.example .env          # set DATABASE_URL
export $(grep -v '^#' .env | xargs)
npm run build:native          # Linux, optional: the launcher and the guard (needs a C compiler)
npm run dev                   # http://localhost:3000/docs
```

`npm run build && npm run selftest` compiles a test document with every engine
inside whatever isolation the machine offers and prints the result.

Tests use a real database and real LaTeX:

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/openleaf_test npm test
COMPILE_ISOLATION_SKIP=namespaces npm test    # as on a host without namespaces
```

## Deploying on Render

`render.yaml` is a Blueprint that creates the API and the front end and wires
them together: **Dashboard → New → Blueprint →** pick this repository. It asks
for `DATABASE_URL`: the connection string of a PostgreSQL database that stays
(see below). Migrations run automatically at start-up.

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

**The database.** OpenLeaf needs a PostgreSQL address and nothing else, so the
database can live anywhere. Render's own free database is deleted 30 days after
it is created, which makes it unfit for anything you want to keep. The hosted
instance uses [Neon](https://neon.com)'s free plan instead, which does not
expire: create a project there (same region as the API, Frankfurt), copy its
connection string, and set it as `DATABASE_URL` on the API. A database reached
over the internet is used with TLS and its certificate is checked. Neon puts an
idle database to sleep and wakes it on the next connection, which adds a second
or so to the first request after a pause.

Things to know about Render's free plans:

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
| `DATABASE_SSL` | by address | TLS to the database. Default: none for this machine or a private name without dots, otherwise encrypted with the certificate checked. `off`, `verify`, or `no-verify` (a self-signed certificate) |
| `REGISTRATION` | `first-user`, or `invite` if `INVITE_CODE` is set | Who may create accounts: `first-user`, `invite`, `open`, `closed` |
| `INVITE_CODE` | — | Secret needed to register in `invite` mode |
| `SESSION_TTL_DAYS` / `SESSION_MAX_DAYS` | `30` / `90` | A session ends this long after its last use / after it was made |
| `TRUST_PROXY` | private-network proxies | Whose word to take for the caller's address: address ranges, a number of proxy hops, `true` or `false` |
| `GITHUB_CLIENT_ID` + `SECRETS_KEY` | — | Switch on saving to GitHub (see below) |
| `AUTH_PROVIDER` | `local` | `local`: OpenLeaf keeps a hashed password per account. `firebase`: people sign in with Google through Firebase Authentication and OpenLeaf keeps no password (see below) |
| `FIREBASE_PROJECT_ID` / `FIREBASE_API_KEY` | — | The Firebase project and its web API key (required with `AUTH_PROVIDER=firebase`; neither is a secret) |
| `CORS_ORIGINS` | `*` | Browser origins allowed to call the API |
| `OPENLEAF_DISABLED_MODULES` | — | Comma-separated optional modules to switch off |
| `DEFAULT_ENGINE` | `pdflatex` | Engine for new projects |
| `COMPILE_TIMEOUT_MS` | `180000` | Hard limit per compile |
| `COMPILE_SHELL_ESCAPE` | `restricted` | `off`, `restricted` or `full` (needed by `minted`; trusted users only) |
| `COMPILE_ENGINES` | all installed | Which engines people may use, e.g. `pdflatex,xelatex` |
| `COMPILE_ISOLATION` | `auto` | `auto`: keep compiles apart from the service as far as the host allows; `required`: refuse to compile unless at least the network is cut; `off` |
| `COMPILE_ISOLATION_SKIP` | — | Layers to leave out even where they work: `namespaces`, `launcher`, `files` |
| `COMPILE_READ_PATHS` | — | Further folders a compile may read (a TeX installation in an unusual place, shared style files) |
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

### Saving projects to GitHub

Each project can be kept in a GitHub repository of its own. In the app: link
the account once under **Modules → Connections → GitHub** (GitHub shows a
one-time code to approve; no GitHub password passes through OpenLeaf), then in
a project's **History** pane choose a repository name and **Create
repository**, and after that **Save to GitHub** whenever you like. Each save is
one commit holding exactly the project's files; only contents that changed are
uploaded. Repositories are private unless you say otherwise. If the repository
was changed on GitHub in the meantime, OpenLeaf asks before saving on top (the
other changes stay in the history).

To switch it on for an instance:

1. On GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.
   Any name; homepage and callback URL can both be your front end's address
   (the callback is not used). After creating it, tick **Enable Device Flow**.
   No client secret is needed. Leave **Expire user access tokens** on (or opt
   in under the app's optional features): OpenLeaf then holds a token that
   lasts eight hours and renews it by itself each time it is used; a link left
   unused for six months lapses. With expiry off the token lasts until it is
   unlinked or revoked.
2. Set `GITHUB_CLIENT_ID` to the app's client id and `SECRETS_KEY` to 32 random
   bytes (`openssl rand -base64 32`). The key encrypts the stored GitHub
   tokens; if it is lost or changed, people simply link again.
3. Optional: `GITHUB_SCOPE=public_repo` limits OpenLeaf to public
   repositories (the default, `repo`, reaches private ones too).

Routes: `GET|DELETE /api/github`, `POST /api/github/link`,
`POST /api/github/link/:linkId`, and per project `GET|POST|DELETE
/api/projects/:id/github` and `POST /api/projects/:id/github/save`.

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

Real-time collaborative editing, pulling changes back from GitHub, and
spell-checking are not part of this back end. The file API's version checks are
the hook for adding collaborative editing later.

## Security

How sign-in, access, compiling and stored tokens are protected, and how to
report a problem: [`SECURITY.md`](SECURITY.md).

## Licence

Private project for personal and research use.
