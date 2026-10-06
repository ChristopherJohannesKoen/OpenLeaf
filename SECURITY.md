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
| **Compiling** | LaTeX is a programming language, so a project's files are treated as untrusted. A compile runs without the service's environment, with TeX's own file and shell restrictions, with memory and file-size limits, and (where the host allows unprivileged namespaces) in its own process, network and mount view with no network at all. `GET /api/system/info` says which of these are in force on an instance. Even so: do not give accounts to people you would not let run programs on the server. |
| **Files** | Paths are validated on the way in and again before anything is written to disk. Archives are unpacked with a running byte count. The front end only ever shows pictures and PDFs in the browser; anything else is downloaded. |
| **GitHub** | Linking uses GitHub's device flow, so no GitHub password passes through OpenLeaf. The token is stored encrypted (AES-256-GCM, `SECRETS_KEY`), is used only by the server, and is never returned by the API. Unlinking deletes it. |
| **The browser** | The built site carries a Content-Security-Policy. The API accepts browser calls only from the origins in `CORS_ORIGINS`. |
| **Secrets** | Only in environment variables: `DATABASE_URL`, `INVITE_CODE`, `SECRETS_KEY`. None are in this repository. |

## If you run your own instance

- Set `REGISTRATION=closed` once your account exists.
- Set `CORS_ORIGINS` to your front end's address and `TRUST_PROXY` to match your host (see `.env.example`).
- Turn on two-step verification for the accounts the instance depends on: the host, GitHub, and the Google account you sign in with.
- Back up: Modules → Backup, or save projects to GitHub.
