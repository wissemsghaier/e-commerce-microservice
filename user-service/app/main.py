import os

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2 import IntegrityError

app = FastAPI(title="user-service", version="1.0.0")

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:password@db-users:5432/users_db",
)


class UserCreate(BaseModel):
    name: str
    email: EmailStr


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def init_db():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE
                )
                """
            )
            cur.execute(
                """
                INSERT INTO users(name, email)
                VALUES (%s, %s)
                ON CONFLICT (email) DO NOTHING
                """,
                ("Alice", "alice@example.com"),
            )


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/health")
def health():
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
    except Exception as exc:
        return JSONResponse(
            status_code=503,
            content={
                "status": "degraded",
                "service": "user-service",
                "language": "python",
                "db": str(exc),
            },
        )

    return {"status": "ok", "service": "user-service", "language": "python"}


@app.get("/users")
def get_users():
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, name, email FROM users ORDER BY id")
            return cur.fetchall()


@app.get("/users/{user_id}")
def get_user(user_id: int):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, name, email FROM users WHERE id = %s", (user_id,))
            user = cur.fetchone()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return user


@app.post("/users", status_code=201)
def create_user(payload: UserCreate):
    email = payload.email.lower().strip()
    name = payload.name.strip()

    if not name:
        raise HTTPException(status_code=400, detail="Name is required")

    try:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    INSERT INTO users(name, email)
                    VALUES (%s, %s)
                    RETURNING id, name, email
                    """,
                    (name, email),
                )
                user = cur.fetchone()
                return user
    except IntegrityError:
        raise HTTPException(status_code=409, detail="Email already exists")
