FROM python:3.13-slim@sha256:ffb752e139c0a19692a43af8d8523b274222dd68eebad5d583b45c2201c6e30a

COPY --from=ghcr.io/astral-sh/uv:latest@sha256:e85be844203885286c60ffad8a858d48afb6c5a5c237ca0e67f12e74b8f174b1 /uv /uvx /bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

COPY bot.py ./

CMD ["uv", "run", "--no-sync", "python", "bot.py"]
