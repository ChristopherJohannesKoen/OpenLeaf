# Security

OpenLeaf is a personal project. If you find a way to read someone else's projects, to get past
sign-in, or to reach the server from a document, please report it privately: use **Security →
Report a vulnerability** on this repository rather than a public issue.

## How it is put together

| | |
| --- | --- |
| **Sign-in** | With `AUTH_PROVIDER=firebase` people sign in with Google and OpenLeaf stores no password. Sessions are random 256-bit tokens, stored only as hashes, valid 30 days from last use and never more than 90 days in all. "Sign out everywhere" ends every session. |
| **Who gets an account** | `REGISTRATION` (`closed`, `invite`, `first-user`, `open`). Keep it `closed` unless you are adding someone: every account can compile. |
| **Access** | Every project route checks that the project belongs to the caller. |
| **Compiling** | LaTeX is a programming language, so a project's files are treated as untrusted. See "How a compile is kept apart" below. `GET /api/system/info` says which measures are in force on an instance. |
| **Files** | Paths are validated on the way in and again before anything is written to disk. Archives are unpacked with a running byte count. The front end only ever shows pictures and PDFs in the browser; anything else is downloaded. |
| **GitHub** | Linking uses GitHub's device flow, so no GitHub password passes through OpenLeaf. The token is stored encrypted (AES-256-GCM, `SECRETS_KEY`), is used only by the server, and is never returned by the API. Unlinking deletes it. When the OAuth app is set to expire its tokens, the token lasts eight hours and OpenLeaf renews it as it is used; unused for six months, the link lapses by itself. |
| **The database** | Reached with TLS and a checked certificate whenever it is not on the same machine or private network. |
| **The browser** | The built site carries a Content-Security-Policy. The API accepts browser calls only from the origins in `CORS_ORIGINS`. |
| **Secrets** | Only in environment variables: `DATABASE_URL`, `INVITE_CODE`, `SECRETS_KEY`. None are in this repository. |

## How a compile is kept apart

A compile that got past TeX's own restrictions would be an ordinary program running as
the same user as the service. These are the things that stand in its way, outermost
first. None needs privileges, so they hold on container hosts that offer nothing else.

| Measure | What it does | Needs |
| --- | --- | --- |
| TeX's switches | No reading or writing outside the project (`openin_any=p`), only TeX Live's short list of helper programs, `latexmkrc` ignored, none of the service's environment variables. LuaLaTeX is the exception on reading: see below. | — |
| Limits | A ceiling on memory and on the size of any file written; a time limit, after which the whole process group is ended. The group is also ended when the compile finishes, so nothing it started lives on. | `prlimit` |
| No network, no other processes | The launcher (`native/sandbox.c`) installs a system-call filter (seccomp) before TeX starts: no socket of any kind can be opened, no other process can be traced or read, the process group cannot be left, and a handful of kernel facilities TeX never uses are refused. Inherited by everything the compile starts. | Any Linux kernel since 3.17 |
| A narrow file view | The launcher also applies Landlock rules: the compile can read and run the TeX installation, read and write its own folder and TeX's caches, and see nothing else: not the service's files, not other projects, not `/proc`. It cannot make links or run what it wrote. On newer kernels it also cannot signal processes outside itself. | Kernel 5.13+ with Landlock enabled |
| Namespaces | Own process, network and mount view. Used in addition, where the host allows them. | Unprivileged user namespaces |
| The guard | The service is started with `native/guard.c` preloaded, which marks it "not dumpable": other processes of the same user cannot read its memory or environment (where the database address and `SECRETS_KEY` are) through `/proc`, or attach to it. | — |
| A read-only application | In the Docker image the application's files belong to root; the user the service runs as cannot change the code it runs. | — |
| No trust in what a compile leaves | The service reads a compile's outputs only if they are plain files (never through a link), and clears links out of a project's folder before writing into it again. | — |

At start-up the service tries each measure, compiles a test document inside what it
found, and steps down one layer at a time only if TeX does not compile; what it ends
up with is in the start-up log and in `GET /api/system/info`. `COMPILE_ISOLATION=required`
refuses to compile unless at least the network is cut.

**LuaLaTeX.** LuaTeX runs Lua, and on current TeX Live its own font loader opens its data
files by full path, which TeX's paranoid read setting refuses; with that setting LuaLaTeX
cannot load a font. So LuaLaTeX runs with `openin_any=r` (no dot files) instead, and what a
LuaLaTeX document can read is bounded by the file rules, not by TeX. On a host whose kernel
has no Landlock (the start-up log and `/api/system/info` say `narrowFiles: false`) a
LuaLaTeX document can read whatever the service's user can; there, leave LuaLaTeX out
(`COMPILE_ENGINES=pdflatex,xelatex`) unless every account is trusted.

What this does not give: a guarantee. The measures were checked to do what they say
for ordinary programs; nobody has attacked them. A flaw in the kernel is outside their
reach. So the advice stands: do not give accounts to people you would not trust, and
think twice before compiling a project from an unknown source on an instance that holds
things you care about.

## If you run your own instance

- Set `REGISTRATION=closed` once your account exists.
- Set `CORS_ORIGINS` to your front end's address and `TRUST_PROXY` to match your host (see `.env.example`).
- Turn on two-step verification for the accounts the instance depends on: the host, GitHub, and the Google account you sign in with.
- Back up: Modules → Backup, or save projects to GitHub.
