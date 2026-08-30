from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="SecureLink API", version="0.1.0")


class BoundingBox(BaseModel):
    x: float
    y: float
    w: float = Field(ge=0)
    h: float = Field(ge=0)


class ElementNode(BaseModel):
    id: str = Field(min_length=1)
    tag: str = Field(min_length=1)
    role: str | None = None
    bbox: BoundingBox
    inputType: str | None = None
    ariaLabel: str | None = None


class AgentStepRequest(BaseModel):
    structural_map: list[ElementNode]
    screenshot_base64: str
    task: str = Field(min_length=1)


class AgentStepResponse(BaseModel):
    action: str
    target_id: str
    reasoning: str


@app.get("/")
def read_root() -> dict[str, str]:
    return {"status": "ok", "service": "securelink-api"}


@app.get("/health")
def read_health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/agent/step")
def agent_step(_request: AgentStepRequest) -> AgentStepResponse:
    return AgentStepResponse(
        action="click",
        target_id="el_1",
        reasoning="stub response",
    )
