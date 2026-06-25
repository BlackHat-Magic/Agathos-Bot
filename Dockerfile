FROM python:3.14-alpine3.23

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin

COPY pyproject.toml uv.lock ./

RUN uv sync --frozen --no-dev

COPY . .

CMD ["uv", "run", "python", "bot.py"]
