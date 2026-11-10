"""权限确认和 Claude 提问：APPROVALS / QUESTIONS 的内存状态，以及 approval_mcp.py 用的内部接口和网页端的决定接口。"""
import asyncio
import os
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from events import add_message, broadcast, push_session
from store import current_user, db, require_internal, session_for

router = APIRouter()

APPROVAL_TIMEOUT = float(os.environ.get("APPROVAL_TIMEOUT", "1800"))


# ---------- 权限确认 ----------

APPROVALS: dict[str, dict] = {}


QUESTIONS: dict[str, dict] = {}


def questions_for(sid: str) -> list[dict]:
    return [q for q in QUESTIONS.values() if q["session_id"] == sid]


def pending_for(sid: str) -> list[dict]:
    return [a for a in APPROVALS.values() if a["session_id"] == sid]


def approval_public(a: dict) -> dict:
    return {k: v for k, v in a.items() if k != "future"}


def approval_summary(tool: str, inp: dict) -> str:
    if tool == "Bash":
        return f"运行命令：{inp.get('command', '')}"
    if tool == "Write":
        return f"新建或覆盖文件：{inp.get('file_path', '')}"
    if tool == "Edit":
        return f"修改文件：{inp.get('file_path', '')}"
    detail = next((str(inp[k]) for k in ("file_path", "path", "url", "command") if inp.get(k)), "")
    return f"使用 {tool}" + (f"：{detail}" if detail else "")


def resolve_approval(aid: str, allow: bool, by: str = "", message: str = "") -> dict:
    a = APPROVALS.get(aid)
    if not a:
        raise HTTPException(404, "这个确认请求已经处理过或已过期")
    if not a["future"].done():
        a["future"].set_result((allow, message or ("" if allow else "用户拒绝了这个操作，不要重试同样的操作")))
    who = f"（{by}）" if by else ""
    add_message(a["session_id"], "event", f"{'✔ 已同意' if allow else '✘ 已拒绝'}{who}：{a['summary']}")
    return a


class ApprovalRequest(BaseModel):
    session_id: str
    tool_name: str
    input: dict


class Decision(BaseModel):
    allow: bool


# 给 approval_mcp.py 用：挂起直到有人在网页里做出决定
@router.post("/api/approvals")
async def request_approval(body: ApprovalRequest, _: dict = Depends(require_internal)):
    from runner import RUNS   # 晚导入：runner 要用本文件的 pending_for / questions_for（循环依赖）
    run = RUNS.get(body.session_id)
    if not run:
        return {"allow": False, "message": "任务已结束"}
    # 文件隔离的第二道（第一道是 PreToolUse 钩子，没加载时靠这里兜底）：涉及别人的个人文件或系统数据，不弹确认直接拒绝
    from runner import guard_policy
    from store import FILE_ROOT, get_user
    import guard
    sess = db("SELECT * FROM sessions WHERE id=?", (body.session_id,), one=True) or {}
    owner = get_user(run.owner_id)
    if owner:
        reason = guard.check_tool(guard_policy(owner), body.tool_name, body.input, sess.get("work_dir") or str(FILE_ROOT))
        if reason:
            add_message(body.session_id, "event", f"⛔ 已自动拒绝（涉及其他人的个人文件或系统数据）：{approval_summary(body.tool_name, body.input)}")
            return {"allow": False, "message": reason}
    aid = uuid.uuid4().hex[:8]
    future = asyncio.get_running_loop().create_future()
    a = APPROVALS[aid] = {
        "id": aid, "session_id": body.session_id, "tool": body.tool_name, "input": body.input,
        "summary": approval_summary(body.tool_name, body.input), "created": time.time(), "future": future,
    }
    broadcast({"type": "approval", "approval": approval_public(a)}, run.owner_id)
    push_session(body.session_id)
    try:
        allow, message = await asyncio.wait_for(future, APPROVAL_TIMEOUT)
    except asyncio.TimeoutError:
        allow, message = False, "等待用户确认超时"
        add_message(body.session_id, "event", f"⌛ 确认超时，已拒绝：{a['summary']}")
    finally:
        APPROVALS.pop(aid, None)
        broadcast({"type": "approval_done", "id": aid, "session_id": body.session_id}, run.owner_id)
        push_session(body.session_id)
    return {"allow": allow, "message": message}


# ---------- Claude 提问（approval_mcp.py 的 ask_user）：弹出选项，等用户点选 ----------

class QuestionItem(BaseModel):
    question: str
    header: str = ""
    options: list[dict] = []
    multi_select: bool = False


class QuestionRequest(BaseModel):
    session_id: str
    questions: list[QuestionItem]


class QuestionAnswer(BaseModel):
    answers: list[dict] = []   # [{selected: [label...], other: "", note: ""}]，和问题一一对应
    skipped: bool = False


def _qa_text(questions: list[dict], answers: list[dict]) -> str:
    lines = []
    for i, q in enumerate(questions):
        a = answers[i] if i < len(answers) else {}
        picked = list(a.get("selected") or [])
        if (a.get("other") or "").strip():
            picked.append("其他：" + a["other"].strip())
        line = f"{i + 1}. {q['question']} → {'、'.join(picked) or '（没选）'}"
        if (a.get("note") or "").strip():
            line += f"（备注：{a['note'].strip()}）"
        lines.append(line)
    return "\n".join(lines)


@router.post("/api/questions")
async def ask_question(body: QuestionRequest, _: dict = Depends(require_internal)):
    from runner import RUNS   # 晚导入：同 request_approval
    run = RUNS.get(body.session_id)
    if not run:
        return {"text": "任务已结束。"}
    questions = []
    for q in body.questions[:4]:
        opts = [{"label": str(o.get("label", "")).strip()[:80], "description": str(o.get("description", "")).strip()[:200]}
                for o in q.options[:6] if str(o.get("label", "")).strip()]
        if q.question.strip() and opts:
            questions.append({"question": q.question.strip()[:300], "header": q.header.strip()[:16], "options": opts,
                              "multi_select": q.multi_select})
    if not questions:
        return {"text": "问题格式不对：每个问题要有 question 和至少一个带 label 的选项。"}
    qid = uuid.uuid4().hex[:8]
    future = asyncio.get_running_loop().create_future()
    item = QUESTIONS[qid] = {"id": qid, "session_id": body.session_id, "questions": questions,
                             "created": time.time(), "future": future}
    broadcast({"type": "question", "question": approval_public(item)}, run.owner_id)
    push_session(body.session_id)
    try:
        ok, payload = await asyncio.wait_for(future, APPROVAL_TIMEOUT)
    except asyncio.TimeoutError:
        ok, payload = False, "用户 30 分钟内没有回答。"
        add_message(body.session_id, "event", "⌛ 问题超时没有回答", {"qa": {"questions": questions, "answers": [], "skipped": True}})
    finally:
        QUESTIONS.pop(qid, None)
        broadcast({"type": "question_done", "id": qid, "session_id": body.session_id}, run.owner_id)
        push_session(body.session_id)
    if not ok:
        return {"text": payload if isinstance(payload, str) else "用户没有回答。"}
    if payload.get("skipped"):
        return {"text": "用户跳过了这些问题，没有选择。请按你认为最合理的方式继续，并在最后说明你做了什么假设。"}
    return {"text": "用户的回答：\n" + _qa_text(questions, payload["answers"])}


@router.post("/api/questions/{qid}")
def answer_question(qid: str, body: QuestionAnswer, user: dict = Depends(current_user)):
    q = QUESTIONS.get(qid)
    if not q:
        raise HTTPException(404, "这个问题已经回答过或已过期")
    session_for(q["session_id"], user)  # 只有会话主人和管理员能回答
    answers = [{"selected": [str(x)[:80] for x in (a.get("selected") or [])][:6],
                "other": str(a.get("other") or "")[:500], "note": str(a.get("note") or "")[:500]} for a in body.answers[:4]]
    if not body.skipped and any(not (a["selected"] or a["other"].strip()) for a in answers[:len(q["questions"])]):
        raise HTTPException(400, "每个问题都要选一个答案（或者填“其他”）")
    if not q["future"].done():
        q["future"].set_result((True, {"answers": answers, "skipped": body.skipped}))
    who = user["display_name"]
    add_message(q["session_id"], "event", f"{'跳过了' if body.skipped else '回答了'} Claude 的问题（{who}）",
                {"qa": {"questions": q["questions"], "answers": answers, "skipped": body.skipped, "by": who}})
    return {"ok": True}


@router.post("/api/approvals/{aid}")
def decide_approval(aid: str, body: Decision, user: dict = Depends(current_user)):
    a = APPROVALS.get(aid)
    if not a:
        raise HTTPException(404, "这个确认请求已经处理过或已过期")
    session_for(a["session_id"], user)  # 只有会话主人和管理员能确认
    resolve_approval(aid, body.allow, user["display_name"])
    return {"ok": True}
