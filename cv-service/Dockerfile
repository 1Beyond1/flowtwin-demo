FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 flowtwin \
  && useradd --uid 10001 --gid 10001 --shell /usr/sbin/nologin --create-home flowtwin

COPY requirements-optional.txt ./
RUN pip install --no-cache-dir -r requirements-optional.txt

COPY app.py ./

RUN mkdir -p /app/models && chown -R 10001:10001 /app

ENV CV_HOST=0.0.0.0 \
    CV_PORT=5099 \
    PADDLEOCR_LOCAL_ONLY=1

USER 10001:10001

EXPOSE 5099

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import os, urllib.request; r = urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"CV_PORT\", \"5099\")}/health', timeout=3); assert r.status == 200"

CMD ["python", "app.py"]
