# OpenLeaf — the front end

The workspace for the OpenLeaf API in the folder above: sign in, a Library of projects, and an editor
with the proof beside it. It is built from the OpenLeaf design system (theme: Metis) — source with a
scholia margin, the apparatus under it, the proof on its desk, and no icons anywhere.

React 18, TypeScript, Vite. The editor is CodeMirror 6; the proof is drawn with pdf.js.

## Run it on your computer

You need Node 20.19 or newer (22 is fine).

```
cd web
npm install
npm run dev
```

Then open http://localhost:5173.

- **With your hosted service (the default).** `npm run dev` forwards every `/api` call to
  `https://openleaf-api.onrender.com`, so nothing else has to run on your computer. The first time,
  the sign-in screen offers "Create the account"; the invite code is the `INVITE_CODE` of the web
  service in Render. A sleeping free-plan service takes about a minute to answer the first request;
  the sign-in screen keeps asking until it does.
- **With an API on your computer.** Start the back end (see the README above), then
  `OPENLEAF_API=http://localhost:3000 npm run dev` (PowerShell: `$env:OPENLEAF_API="http://localhost:3000"; npm run dev`).
  Or put `OPENLEAF_API=http://localhost:3000` in `web/.env.local`.
- **With no service at all.** Press "Open the sample library" on the sign-in screen. Four small
  projects are held in the browser tab, so every screen can be clicked through. Sample mode cannot
  run LaTeX: "Compile" re-reads the source for missing pictures and undefined keys, and the proof
  shown is a fixed PDF made when the sample was written. Everything resets on reload.

Other commands:

| command | does |
| --- | --- |
| `npm run build` | type-checks, then writes the static site to `web/dist` |
| `npm run preview` | serves `web/dist` on http://localhost:4173, forwarding `/api` like `dev` |
| `npm test` | unit tests (outline, key checks, compiler messages, diffs, the sample back end) |
| `npm run typecheck` | TypeScript only |
| `npm run tokens` | rebuilds `src/styles/tokens.css` from `design/tokens.json` |

## What is here

| screen | what it does |
| --- | --- |
| Sign in | Signs in the way the service says it does: with **Continue with Google** when the service uses Firebase Authentication (it then keeps no password), otherwise with an email and password. A new account is asked for the invite code if the service wants one. |
| Library | Every project with the state of its last compile, its page count and its last note. New project (blank or from a template), import a zip, rename, duplicate, download, archive, trash, delete for good. |
| Workspace | The editor. See below. |
| Modules | Which panes are out, the scholia margin, compile-after-save, the theme (Daylight, Lamplight, or follow the computer), the service's address and engines, a backup of everything, sign out. |

The workspace:

- **Source** — LaTeX with an 80-column measure rule, soft-wrapped at the measure. Saves by itself a
  moment after you stop typing (`Ctrl S` saves at once); a save that would overwrite a change made
  elsewhere is refused and asked about instead. Completion for `\ref{…}`, `\cite{…}`, `\begin{…}`
  and common commands. `Ctrl F` finds.
- **Scholia margin** — notes beside the line they concern, in the form `lemma] note.` Two kinds:
  what the compiler said, and what OpenLeaf can tell by reading the project without compiling
  (a `\ref` to a label that is defined nowhere, a `\cite` that is not in the bibliography, a picture
  that is not among the files). Where the remedy is known the note offers it: "Correct", "Use it",
  "Go there".
- **Proof** — the compiled PDF. A diple beside the page marks the line the caret is on (SyncTeX);
  "In proof" scrolls to it; a double click on the page moves the caret to the source of that spot.
  After a failed compile the last good proof stays and is marked stale.
- **Apparatus** — the compiler's messages as one sentence each, errors first; a click goes to the
  line. "Raw log" shows the TeX log.
- **Outline, Files, History** — put away by default; bring them out from the rail (O, F, H) or with
  `Ctrl K`. Files: new file or folder, upload, rename or move, set as root, download, delete (asked
  in place). History: save a version, see what changed since any version, read a file's changes
  line by line, restore.
- **`Ctrl K`** — commands, files, sections and labels in one field. **`Ctrl Enter`** compiles;
  `Ctrl Shift Enter` compiles from scratch.

Not built yet: Counsel (the model that reads along), GitHub sync, real-time collaboration,
selecting text in the proof, dragging the divider between source and proof, a phone layout.

## How it is put together

```
web/
  design/tokens.json     the design system's tokens (the source of src/styles/tokens.css)
  public/fonts/          Gentium Book Plus, Commissioner, Inconsolata (SIL Open Font License)
  public/sample/         PDFs for the sample library
  src/
    api/types.ts         the shapes the API returns, and the `Api` interface every screen uses
    api/http.ts          the real service
    api/sample.ts        the sample library, same interface, in memory
    app/context.tsx      back end in use, who is signed in, preferences
    ds/                  the design system's components (Mark, Siglum, Pane, Scholion, …)
    editor/              the CodeMirror editor: LaTeX grammar, measure, margin, notes
    proof/               the pdf.js proof view
    panes/               Files, History, the patch view
    parts/               palette, popover, notices
    screens/             SignIn, Library, Workspace, Modules
    lib/latex.ts         what is read out of the source: outline, keys, checks, word count
    styles/              tokens.css (generated), openleaf.css (design system), app.css (app)
```

Things worth knowing before changing it:

- **Every screen talks to the `Api` interface**, never to `fetch`. A new back-end feature means a
  method in `types.ts`, its call in `http.ts`, and something sensible in `sample.ts`.
- **The design rules are the design system's.** One 20px line; four marks (obelus, asterisk, diple,
  halmos); a letter in a square for each module; bronze for the Compile button only; no shadows, no
  icons, no toasts. Anything the app has to say that is not about a line of source is a `Notice`
  set in place.
- **Preferences** (panes, theme, compile-after-save) are kept with the account under `openleaf` in
  the service's free-form settings, and mirrored in the browser's local storage.
- **The session token** is kept in the browser's local storage until you sign out.
- **Google sign-in** is in `src/lib/google.ts`, loaded only when the service asks for it. Firebase's own
  sign-in is held in memory and dropped once its token has been handed to the service, so the only
  thing kept in the browser is OpenLeaf's session token.
- **Widths.** The source column is a measure (gutter, 80 columns, margin: 950px). When the window
  cannot hold that and a usable proof, the margin narrows, then goes, and only then do the columns.

## Hosting it

The hosted copy is a Render static site, https://openleaf-cw3y.onrender.com, built from `main`
with `cd web && npm ci && npm run build` (see "Deploying on Render" in the README above for when
a push redeploys by itself). It is built with
`VITE_API_URL=https://openleaf-api.onrender.com`, and the API's `CORS_ORIGINS` names the site, so
the browser calls the API directly. Both are set in `render.yaml` (and in the Render dashboard).

To host it elsewhere: `npm run build` makes a static site. Serve `web/dist` from anywhere and either

- put it behind the same origin as the API (forward `/api` to the service), or
- build with `VITE_API_URL=https://your-api` so the browser calls the API directly; the API must
  allow the site's origin in `CORS_ORIGINS` (the default `*` does).
