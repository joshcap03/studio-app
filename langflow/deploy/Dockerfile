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
    LANGFLOW_CREATE_STARTER_PROJECTS=false \
    LANGFLOW_NATIVE_TRACING=false
# NATIVE_TRACING=false: Langflow's own traces (span/trace tables) are never pruned and grew
# ~95 MB a day, filling a 1 GB Postgres and failing every run. LangSmith does the tracing.
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

# Langflow's agent checkpoint saver loses an approval pause when the database is slower than
# the agent (see the patch's docstring): the run ends with no reply and no approval card.
# The patch replaces 1.12.4's file only if it is still that file, so an upgrade fails the
# build here and the patch gets rechecked instead of silently overwriting newer code.
COPY patches/job_checkpoint_saver.py /tmp/job_checkpoint_saver.py
RUN target="$(/app/.venv/bin/python -c 'import lfx.components.models_and_agents.agent_helpers.job_checkpoint_saver as m; print(m.__file__)')" \
 && echo "bc45e66e206fdd711b1c5b6bb15015e2df1b106ce6bfe6240512ddc59d5d4855  $target" | sha256sum -c - \
 && install -m 644 /tmp/job_checkpoint_saver.py "$target" && rm /tmp/job_checkpoint_saver.py \
 && find "$(dirname "$target")/__pycache__" -name 'job_checkpoint_saver*' -delete 2>/dev/null; \
    /app/.venv/bin/python -c "import lfx.components.models_and_agents.agent_helpers.job_checkpoint_saver as m; assert 'Studio patch' in m.__doc__"
USER 1000

# Mount the persistent volume here (Railway volume / Render disk).
VOLUME ["/app/data/langflow"]

EXPOSE 7860

# Refuse to start without the required settings, so a missing variable can't fall back to
# SQLite inside the container, a throwaway secret key, or the default superuser.
# The host's $PORT (Railway, Render) wins over 7860.
CMD ["sh", "-c", ": \"${LANGFLOW_DATABASE_URL:?is required}\" \"${LANGFLOW_SECRET_KEY:?is required}\" \"${LANGFLOW_SUPERUSER:?is required}\" \"${LANGFLOW_SUPERUSER_PASSWORD:?is required}\"; case \"$LANGFLOW_DATABASE_URL\" in postgres://*|postgresql://*|postgresql+*) ;; *) echo 'LANGFLOW_DATABASE_URL must be a Postgres URL' >&2; exit 1;; esac; mkdir -p \"$LANGFLOW_CONFIG_DIR\"; export LANGFLOW_PORT=\"${PORT:-7860}\"; exec langflow run"]
