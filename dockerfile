# ----------------------------------------------------
# Stage 1: Frontend Build Stage
# ----------------------------------------------------
FROM node:20-slim AS frontend-builder
WORKDIR /app/frontend

# Copy frontend dependency manifests from frontend/ directory
COPY frontend/package*.json ./
RUN npm ci

# Copy frontend source and build static output
COPY frontend/ ./
RUN npm run build


# ----------------------------------------------------
# Stage 2: Final Backend & System Runtime
# ----------------------------------------------------
FROM python:3.12-slim-bookworm

# Grab the uv binary
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    MERMAID_CONFIG=/app/puppeteer-config.json

WORKDIR /app

# Install Graphviz, Pandoc, Chromium, LaTeX engines, and Node.js for mermaid-cli
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    graphviz \
    pandoc \
    chromium \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-xetex \
    texlive-fonts-recommended \
    lmodern \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install mermaid-cli globally
RUN npm install -g @mermaid-js/mermaid-cli

# Cache Python dependencies
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-install-project --no-dev

# Copy root backend files, puppeteer config, and built frontend assets
COPY main.py reference.docx* puppeteer-config.json ./
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Install root project into the venv
RUN uv sync --frozen --no-dev

# Set environment path to use uv's virtualenv directly
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

# Start your FastAPI / Uvicorn server located in main.py
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "6789"]