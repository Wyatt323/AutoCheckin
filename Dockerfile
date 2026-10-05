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
COPY requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install -r requirements.txt

COPY --chown=node:node server.js automation.js checkin_scheduler.js allinone.py automation_worker.py config.example.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown node:node /data

USER node
EXPOSE 8765
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
