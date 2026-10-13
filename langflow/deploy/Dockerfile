# Langflow for Studio: backend only (API, no editor UI), Postgres, no auto-login.
# Build context is this directory; nothing from the repo is copied in. The flow is
# imported over the API afterwards (see README.md).
FROM langflowai/langflow:1.12.4

# Fixed policy. Secrets and the database URL come from the host's env, never from here.
ENV LANGFLOW_BACKEND_ONLY=true \
    LANGFLOW_AUTO_LOGIN=false \
    LANGFLOW_ENABLE_SIGNUP=false \
    LANGFLOW_NEW_USER_IS_ACTIVE=false \
    LANGFLOW_HOST=0.0.0.0 \
    LANGFLOW_WORKERS=1 \
    LANGFLOW_CONFIG_DIR=/app/data/langflow \
    LANGFLOW_DO_NOT_TRACK=true
# LANGFLOW_SANDBOX_BACKEND is deliberately unset: the shared flow runs no in-process Python.

# Mount the persistent volume here (Railway volume / Render disk).
VOLUME ["/app/data/langflow"]

EXPOSE 7860

# Refuse to start without the required settings, so a missing variable can't fall back to
# SQLite inside the container, a throwaway secret key, or the default superuser.
# The host's $PORT (Railway, Render) wins over 7860.
CMD ["sh", "-c", ": \"${LANGFLOW_DATABASE_URL:?is required}\" \"${LANGFLOW_SECRET_KEY:?is required}\" \"${LANGFLOW_SUPERUSER:?is required}\" \"${LANGFLOW_SUPERUSER_PASSWORD:?is required}\"; case \"$LANGFLOW_DATABASE_URL\" in postgres://*|postgresql://*|postgresql+*) ;; *) echo 'LANGFLOW_DATABASE_URL must be a Postgres URL' >&2; exit 1;; esac; mkdir -p \"$LANGFLOW_CONFIG_DIR\"; export LANGFLOW_PORT=\"${PORT:-7860}\"; exec langflow run"]
