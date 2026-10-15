# Langflow for Studio: backend only (API, no editor UI), Postgres, no auto-login.
# Build context is this directory; nothing from the repo is copied in. The flow is
# imported over the API afterwards (see README.md).
FROM langflowai/langflow:1.12.4

# Fixed policy. Secrets and the database URL come from the host's env, never from here.
ENV LANGFLOW_BACKEND_ONLY=true \
    LANGFLOW_AUTO_LOGIN=false \
    LANGFLOW_ENABLE_SIGNUP=false \
    LANGFLOW_NEW_USER_IS_ACTIVE=false \
    LANGFLOW_CUSTOM_COMPONENT_ADMIN_ONLY=true \
    LANGFLOW_HOST=0.0.0.0 \
    LANGFLOW_WORKERS=1 \
    LANGFLOW_CONFIG_DIR=/app/data/langflow \
    LANGFLOW_DO_NOT_TRACK=true \
    LANGFLOW_WORKER_TIMEOUT=0 \
    LANGFLOW_CREATE_STARTER_PROJECTS=false
# WORKER_TIMEOUT=0 turns off gunicorn's heartbeat check. Hosts that pause the CPU between
# requests (Cloud Run's default) freeze the heartbeat, and gunicorn then kills the idle
# worker on the next request and boots a new one (~90s). Agent runs need no worker timeout:
# the app and the host enforce their own request timeouts.
# Starter projects are editor examples; with no UI they only slow every boot.
# LANGFLOW_SANDBOX_BACKEND is deliberately unset: the shared flow runs no in-process Python.

# Packages the flow's components import that the base image doesn't ship (Exa web search).
# The import check fails the build, not a chat, if the flow needs something still missing.
USER root
RUN if command -v uv >/dev/null; then uv pip install --python /app/.venv/bin/python exa-py==2.25.0; \
    else /app/.venv/bin/python -m ensurepip && /app/.venv/bin/python -m pip install exa-py==2.25.0; fi \
 && /app/.venv/bin/python -c "import exa_py, fastapi, httpx, langchain, langchain_core, langgraph, orjson, pydantic, requests"
USER 1000

# Mount the persistent volume here (Railway volume / Render disk).
VOLUME ["/app/data/langflow"]

EXPOSE 7860

# Refuse to start without the required settings, so a missing variable can't fall back to
# SQLite inside the container, a throwaway secret key, or the default superuser.
# The host's $PORT (Railway, Render) wins over 7860.
CMD ["sh", "-c", ": \"${LANGFLOW_DATABASE_URL:?is required}\" \"${LANGFLOW_SECRET_KEY:?is required}\" \"${LANGFLOW_SUPERUSER:?is required}\" \"${LANGFLOW_SUPERUSER_PASSWORD:?is required}\"; case \"$LANGFLOW_DATABASE_URL\" in postgres://*|postgresql://*|postgresql+*) ;; *) echo 'LANGFLOW_DATABASE_URL must be a Postgres URL' >&2; exit 1;; esac; mkdir -p \"$LANGFLOW_CONFIG_DIR\"; export LANGFLOW_PORT=\"${PORT:-7860}\"; exec langflow run"]
