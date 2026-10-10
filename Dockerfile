FROM node:22-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH="/opt/venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install -r requirements.txt

COPY --chown=node:node server.js database.js storage.py bot_discovery.py admin_auth.js user_auth.js system_settings.js telegram_notifications.js checkin_results.js automation.js login.js run_history.js schedule_time.js checkin_scheduler.js account_profiles.js account_profile.py chat_resolver.js chat_lookup.py allinone.py checkin_logging.py automation_worker.py login_worker.py telegram_credentials.js telegram_credentials.py config.example.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node cleanup.js cleanup_worker.py ./
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown node:node /data

USER node
EXPOSE 8765
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
