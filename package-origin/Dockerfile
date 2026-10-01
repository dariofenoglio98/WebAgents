FROM python:3.12-slim

WORKDIR /app

COPY server.py /app/server.py
COPY packages /app/packages

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

CMD ["python", "/app/server.py"]
