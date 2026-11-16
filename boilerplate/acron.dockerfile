FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS base
WORKDIR /usr/src/%%PROJECTNAME%%
# tsbp:begin pm:corepack
# Node >= 25 images no longer ship Corepack (older images ship Yarn 1 instead), so install it explicitly
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && npm install --global corepack@latest \
  && corepack enable
# tsbp:end pm:corepack
COPY package.json __PM_LOCKFILE__ ./
# tsbp:begin pm:yarn
COPY .yarnrc.yml ./
# tsbp:end pm:yarn
# tsbp:begin pm:pnpm
COPY pnpm-workspace.yaml ./
# tsbp:end pm:pnpm
# tsbp:begin pm:corepack
# Download the package manager version pinned in package.json once, so both stages below reuse it
RUN corepack install
# tsbp:end pm:corepack

# Builder image used only for compiling Typescript files
FROM base AS builder
RUN __PM_INSTALL__
COPY . .
RUN __PM_RUN__ compile

# Lean production image that just contains the dist directory (copied to the root of the workdir) and runtime dependencies
FROM base AS prod
ENV NODE_ENV=production
RUN __PM_INSTALL_PROD__
COPY --from=builder /usr/src/%%PROJECTNAME%%/dist ./

# Setup cronjob
RUN mkdir -p /etc/cron.d
COPY %%PROJECTNAME%%-cron /etc/cron.d/%%PROJECTNAME%%-cron
RUN chmod 0644 /etc/cron.d/%%PROJECTNAME%%-cron
RUN crontab /etc/cron.d/%%PROJECTNAME%%-cron

# Create the log files to be able to run tail
RUN touch /var/log/cron.log
RUN touch /usr/src/%%PROJECTNAME%%/%%PROJECTNAME%%.log
CMD ["sh", "-c", "crond && tail -f /var/log/cron.log"]
