from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, EmailStr

app = FastAPI(title="user-service", version="1.0.0")


class UserCreate(BaseModel):
    name: str
    email: EmailStr


users = [{"id": 1, "name": "Alice", "email": "alice@example.com"}]
next_user_id = 2


@app.get("/health")
def health():
    return {"status": "ok", "service": "user-service", "language": "python"}


@app.get("/users")
def get_users():
    return users


@app.get("/users/{user_id}")
def get_user(user_id: int):
    user = next((u for u in users if u["id"] == user_id), None)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@app.post("/users", status_code=201)
def create_user(payload: UserCreate):
    global next_user_id

    email = payload.email.lower()
    exists = any(u["email"] == email for u in users)
    if exists:
        raise HTTPException(status_code=409, detail="Email already exists")

    user = {"id": next_user_id, "name": payload.name.strip(), "email": email}
    next_user_id += 1
    users.append(user)
    return user
