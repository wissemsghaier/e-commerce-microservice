from fastapi import FastAPI, Depends, HTTPException, status
from sqlalchemy.orm import Session
from .database import engine, get_db, Base
from .models import User
from .schemas import UserCreate, UserResponse, LoginRequest, Token
from .auth import hash_password, verify_password, create_token

Base.metadata.create_all(bind=engine)

app = FastAPI(title="User Service", version="1.0.0")

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/register", response_model=UserResponse, status_code=201)
def register(payload: UserCreate, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(400, "Email déjà utilisé")
    user = User(
        email=payload.email,
        username=payload.username,
        hashed_password=hash_password(payload.password)
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

@app.post("/login", response_model=Token)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == payload.email).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(401, "Identifiants incorrects")
    token = create_token({"sub": str(user.id), "email": user.email})
    return {"access_token": token}

@app.get("/me", response_model=UserResponse)
def get_me(user_id: int, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "Utilisateur introuvable")
    return user