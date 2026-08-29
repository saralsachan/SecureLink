from fastapi import FastAPI

app = FastAPI(title="SecureLink API", version="0.1.0")


@app.get("/")
def read_root() -> dict[str, str]:
    return {"status": "ok", "service": "securelink-api"}


@app.get("/health")
def read_health() -> dict[str, str]:
    return {"status": "ok"}

