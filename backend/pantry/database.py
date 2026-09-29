"""Serialized async scopes and nested transactions for SQLite and PostgreSQL.

SQL and persisted names match the previous backend. Parameters are never
interpolated. No scope is held while waiting on Microsoft or the AI provider.
"""
import asyncio
import re
import sqlite3
from contextlib import asynccontextmanager
from contextvars import ContextVar
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit
import os
import certifi
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from .config import production


def postgres_sql(sql):
    pragma = re.fullmatch(r"PRAGMA table_info\((\w+)\)", sql.strip(), re.I)
    if pragma:
        return "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '" + pragma[1] + "'"
    sql = re.sub(r"\bifnull\(", "coalesce(", sql, flags=re.I)
    sql = re.sub(r"([\w.]+) = \? COLLATE NOCASE", r"lower(\1) = lower(?)", sql, flags=re.I)
    sql = re.sub(r"name COLLATE NOCASE", "lower(name)", sql, flags=re.I)
    sql = re.sub(r" COLLATE NOCASE", "", sql, flags=re.I)
    sql = sql.replace("BEGIN IMMEDIATE", "BEGIN").replace("CREATE TABLE IF NOT EXISTS chat_message (", "CREATE TABLE IF NOT EXISTS chat_message (sequence BIGSERIAL UNIQUE,")
    sql = re.sub(r"\browid\b", "sequence", sql)
    sql = sql.replace("coalesce(office_id, '')", "(coalesce(office_id, ''))")
    # Preserve literal question marks in quoted SQL; psycopg uses %s parameters.
    parts = re.split(r"('(?:[^']|'')*')", sql)
    return "".join(part if i % 2 else part.replace("?", "%s") for i, part in enumerate(parts))


class Database:
    def __init__(self, file=None, *, url=None):
        self._context = ContextVar(f"pantry_db_{id(self)}", default=None)
        self._lock = asyncio.Lock()
        self.pool = None
        self.sqlite = None
        connection_url = "" if file is not None else url or os.getenv("DATABASE_URL", "")
        self.dialect = "postgres" if connection_url else "sqlite"
        if connection_url:
            parsed = urlsplit(connection_url)
            if parsed.scheme not in ("postgres", "postgresql"):
                raise ValueError("DATABASE_URL is not a valid PostgreSQL connection URL.")
            query = {k: v for k, v in parse_qsl(parsed.query) if k not in {"sslmode", "sslcert", "sslkey", "sslrootcert"}}
            tls = production() or os.getenv("PGSSL") != "disable"
            query["sslmode"] = "verify-full" if tls else "disable"
            if tls:
                query["sslrootcert"] = certifi.where()
            query["connect_timeout"] = "10"
            # Prevent connection-string options from removing the timeout.
            query["options"] = "-c statement_timeout=15000"
            # libpq URI decoding accepts %20, but treats '+' as a literal.
            connection_url = urlunsplit(parsed._replace(query=urlencode(query, quote_via=quote)))
            self.pool = AsyncConnectionPool(connection_url, min_size=0, max_size=5, open=False, timeout=10, kwargs={"autocommit": True, "row_factory": dict_row})
        else:
            if file is None:
                raise ValueError("An explicit SQLite filename is required.")
            if str(file) != ":memory:":
                Path(file).parent.mkdir(parents=True, exist_ok=True)
            self.sqlite = sqlite3.connect(str(file), isolation_level=None)
            self.sqlite.row_factory = sqlite3.Row
            self.sqlite.executescript("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")

    async def open(self):
        if self.pool:
            await self.pool.open()
        return self

    @asynccontextmanager
    async def scope(self):
        if self._context.get() is not None:
            yield self
            return
        async with self._lock:
            if self.sqlite is not None:
                token = self._context.set({"connection": self.sqlite})
                try:
                    yield self
                finally:
                    if self.sqlite.in_transaction:
                        self.sqlite.rollback()
                    self._context.reset(token)
            else:
                async with self.pool.connection() as connection:
                    await connection.execute("SELECT pg_advisory_lock(206092701)")
                    token = self._context.set({"connection": connection})
                    try:
                        yield self
                    finally:
                        try:
                            await connection.execute("ROLLBACK")
                            await connection.execute("SELECT pg_advisory_unlock(206092701)")
                        except BaseException:
                            await connection.close()
                            raise
                        finally:
                            self._context.reset(token)

    @asynccontextmanager
    async def transaction(self):
        async with self.scope():
            state = self._context.get()
            depth = state.get("depth", 0)
            await self.exec(f"SAVEPOINT pantry_tx_{depth}" if depth else "BEGIN")
            state["depth"] = depth + 1
            try:
                yield self
            except BaseException:
                await self.exec(f"ROLLBACK TO SAVEPOINT pantry_tx_{depth}" if depth else "ROLLBACK")
                if depth:
                    await self.exec(f"RELEASE SAVEPOINT pantry_tx_{depth}")
                raise
            else:
                await self.exec(f"RELEASE SAVEPOINT pantry_tx_{depth}" if depth else "COMMIT")
            finally:
                state["depth"] = depth

    async def _query(self, sql, params, kind):
        async with self.scope():
            connection = self._context.get()["connection"]
            if self.sqlite is not None:
                cursor = connection.execute(sql, params)
                if kind == "all":
                    return [dict(row) for row in cursor.fetchall()]
                if kind == "get":
                    row = cursor.fetchone()
                    return dict(row) if row is not None else None
            else:
                cursor = await connection.execute(postgres_sql(sql), params or None)
                if kind == "all":
                    return await cursor.fetchall()
                if kind == "get":
                    return await cursor.fetchone()
            return {"changes": cursor.rowcount}

    async def get(self, sql, *params):
        return await self._query(sql, params, "get")

    async def all(self, sql, *params):
        return await self._query(sql, params, "all")

    async def run(self, sql, *params):
        return await self._query(sql, params, "run")

    async def exec(self, sql):
        if self.dialect == "postgres":
            # PostgreSQL's simple-query protocol handles statement batches and
            # dollar-quoted functions; splitting on semicolons corrupts them.
            sql = re.sub(r"(?im)^\s*PRAGMA (?!table_info)[^;]+;?", "", sql)
            if sql.strip():
                await self.run(sql)
            return
        # executescript implicitly commits SQLite transactions. Execute individual
        # repository-owned statements to preserve nested transaction atomicity.
        for statement in re.split(r";(?=(?:[^']*'[^']*')*[^']*$)", sql):
            if not statement.strip():
                continue
            await self.run(statement)

    async def close(self):
        if self.sqlite is not None:
            self.sqlite.close()
        if self.pool:
            await self.pool.close()
