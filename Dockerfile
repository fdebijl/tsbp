FROM node:10-alpine AS base
WORKDIR /usr/src/poesbericht
COPY package*.json ./

# Builder image used only for compiling Typescript files
FROM base as builder
RUN npm ci
COPY . .
RUN npm run compile

# Lean production image that just contains the dist directory and runtime dependencies
FROM base as prod
RUN npm ci --only=production
COPY --from=builder /usr/src/poesbericht/dist/* ./

# Setup cronjob
RUN mkdir -p /etc/cron.d
COPY poesbericht-cron /etc/cron.d/poesbericht-cron
RUN chmod 0644 /etc/cron.d/poesbericht-cron
RUN crontab /etc/cron.d/poesbericht-cron

# Create the log files to be able to run tail
RUN touch /var/log/cron.log
CMD crond && tail -f /var/log/cron.log