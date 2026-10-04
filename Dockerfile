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

ENV NODE_ENV=production \
    COMPILE_DIR=/var/lib/openleaf/compiles

# Let XeLaTeX and LuaLaTeX find TeX Live's OpenType fonts by name as well.
RUN if [ -f /etc/fonts/conf.avail/09-texlive-fonts.conf ]; then \
      ln -sf /etc/fonts/conf.avail/09-texlive-fonts.conf /etc/fonts/conf.d/09-texlive-fonts.conf; \
    fi \
 && fc-cache -fs

# Never run the API (or LaTeX) as root.
USER node

# Compile a test document with every engine: fails the build if TeX is broken,
# and leaves warm font caches behind for fast first compiles.
COPY --chown=node:node docker/warmup.sh /usr/local/bin/openleaf-warmup
RUN sh /usr/local/bin/openleaf-warmup

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 10000
CMD ["node", "dist/server.js"]
