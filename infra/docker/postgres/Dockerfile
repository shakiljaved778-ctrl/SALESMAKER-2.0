# Postgres 16 with every extension the spec requires (§3.2):
# pgcrypto, pg_trgm, citext, btree_gin (contrib), pgvector (base image), pg_partman (apt).
FROM pgvector/pgvector:pg16

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-16-partman \
  && rm -rf /var/lib/apt/lists/*

COPY init/ /docker-entrypoint-initdb.d/
