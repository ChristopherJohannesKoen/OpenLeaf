# OpenLeaf back end: Node.js API + a TeX Live installation for compiling.
#
# The TeX package set is a build argument, so the image can be made smaller or
# larger without touching the code, e.g.
#   docker build --build-arg TEX_EXTRA_PACKAGES="texlive-lang-european texlive-fonts-extra" .

# ---------- build stage: compile TypeScript ----------
FROM node:22-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- native stage: the two small C helpers in native/ ----------
# Its own stage, so that a change to the application does not rebuild them (and with them
# everything below that depends on them).
FROM node:22-trixie-slim AS native
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
COPY native/sandbox.c native/guard.c native/build.sh /native/
RUN sh /native/build.sh /out

# ---------- runtime stage ----------
FROM node:22-trixie-slim AS runtime

# A broad research-oriented selection (roughly 1.5 GB): the three engines, latexmk,
# BibTeX/Biber, common packages, science and publisher classes, TikZ, beamer.
ARG TEX_PACKAGES="\
    latexmk \
    biber \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-fonts-recommended \
    texlive-science \
    texlive-pictures \
    texlive-bibtex-extra \
    texlive-publishers \
    texlive-xetex \
    texlive-luatex \
    texlive-plain-generic \
    texlive-extra-utils \
    lmodern \
    cm-super \
    tex-gyre \
    ghostscript"
# Anything else you want on top (language packs, extra fonts, python3-pygments for minted…).
ARG TEX_EXTRA_PACKAGES=""

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fontconfig ${TEX_PACKAGES} ${TEX_EXTRA_PACKAGES} \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/info/* \
 && mkdir -p /var/lib/openleaf/compiles \
 && chown -R node:node /var/lib/openleaf

# What keeps a compile apart from the service on hosts without namespaces (see native/):
# the launcher every compile is started through, and the guard loaded into the service.
COPY --from=native /out/openleaf-sandbox /usr/local/bin/openleaf-sandbox
COPY --from=native /out/libopenleaf-guard.so /usr/local/lib/libopenleaf-guard.so

ENV NODE_ENV=production \
    COMPILE_DIR=/var/lib/openleaf/compiles

# Let XeLaTeX and LuaLaTeX find TeX Live's OpenType fonts by name as well.
RUN if [ -f /etc/fonts/conf.avail/09-texlive-fonts.conf ]; then \
      ln -sf /etc/fonts/conf.avail/09-texlive-fonts.conf /etc/fonts/conf.d/09-texlive-fonts.conf; \
    fi \
 && fc-cache -fs

# Compile a test document with every engine, as the user the service runs as: fails the
# build if TeX is broken, and leaves warm font caches behind for fast first compiles.
COPY docker/warmup.sh /usr/local/bin/openleaf-warmup
USER node
RUN sh /usr/local/bin/openleaf-warmup

# The application belongs to root and cannot be written by the user the service runs as,
# so nothing the service starts can change the code it runs.
USER root
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Never run the API (or LaTeX) as root.
USER node

# The same test document again, this time through the service's own code and inside
# whatever isolation the build machine offers; the result is printed in the build log.
RUN node dist/selftest-cli.js

# Loaded into the service only now, after the build steps: closes its memory and
# environment to the programs it starts.
ENV LD_PRELOAD=/usr/local/lib/libopenleaf-guard.so

EXPOSE 10000
CMD ["node", "dist/server.js"]
