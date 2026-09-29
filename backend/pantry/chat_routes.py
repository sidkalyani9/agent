import asyncio
import logging
import re
from contextlib import suppress
from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse, StreamingResponse
from .core import HttpError
from .compat import text, dumps
from . import conversations as c, chat
from .routes import person, context

router = APIRouter(dependencies=[Depends(person)])
logger = logging.getLogger(__name__)


@router.get("/api/chat/threads")
async def threads(request: Request):
    db, actor, _ = context(request)
    return {"threads": await c.list_chat_threads(db, actor)}


@router.post("/api/chat/threads", status_code=201)
async def create_thread(request: Request):
    db, actor, _ = context(request)
    return await c.create_chat_thread(db, actor)


@router.get("/api/chat/threads/{thread_id}")
async def get_thread(request: Request, thread_id: str):
    db, actor, _ = context(request)
    return await c.get_chat_thread(db, actor, thread_id)


def screen_context(body):
    office_id = text(body.get("officeId") or "").strip()
    month = text(body.get("month") or "").strip()
    if office_id in ("", "all"):
        office_id = None
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        month = None
    return office_id, month


def error_payload(error, thread_id):
    status = error.status if isinstance(error, HttpError) else 500
    if status == 500:
        logger.error("Assistant request failed (%s).", type(error).__name__)
    return status, {"error": "Something went wrong." if status == 500 else error.message, "threadId": thread_id}


@router.post("/api/chat")
async def converse(request: Request):
    db, actor, body = context(request)
    message = text(body.get("message") or "").strip()
    if not message:
        raise HttpError(422, "Write a message first.")
    if len(message) > 2000:
        raise HttpError(422, "Keep a message under 2000 characters.")
    thread_id = body.get("threadId") or (await c.create_chat_thread(db, actor))["id"]
    history = await c.recent_chat_history(db, actor, thread_id)
    office_id, month = screen_context(body)
    await c.add_chat_message(db, actor, thread_id, "user", message)
    if body.get("stream") is True:
        async def events():
            queue = asyncio.Queue()
            def send(event, data):
                queue.put_nowait((event, data))
            async def work():
                try:
                    result = await chat.converse(db, actor, history, message, thread_id=thread_id,
                                                 on_delta=lambda piece: send("delta", {"text": piece}),
                                                 on_replace=lambda full: send("replace", {"text": full}),
                                                 context_office_id=office_id, context_month=month)
                    await c.add_chat_message(db, actor, thread_id, "assistant", result["reply"], result.get("proposals") or [])
                    send("done", {"threadId": thread_id, "reply": result["reply"], "proposals": result.get("proposals") or [], "saved": bool(result.get("saved"))})
                except Exception as error:
                    send("error", error_payload(error, thread_id)[1])
                finally:
                    queue.put_nowait(None)
            yield "event: thread\ndata: " + dumps({"threadId": thread_id}) + "\n\n"
            task = asyncio.create_task(work())
            try:
                while (item := await queue.get()) is not None:
                    event, data = item
                    yield f"event: {event}\ndata: {dumps(data)}\n\n"
            finally:
                if not task.done():
                    task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        return StreamingResponse(events(), media_type="text/event-stream; charset=utf-8", headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no"})
    try:
        result = await chat.converse(db, actor, history, message, thread_id=thread_id, context_office_id=office_id, context_month=month)
        await c.add_chat_message(db, actor, thread_id, "assistant", result["reply"], result.get("proposals") or [])
        return {**result, "threadId": thread_id}
    except Exception as error:
        status, payload = error_payload(error, thread_id)
        return JSONResponse(payload, status_code=status)


@router.post("/api/chat/confirm")
async def confirm(request: Request):
    db, actor, body = context(request)
    thread_id = body.get("threadId") or None
    if thread_id:
        await c.get_chat_thread(db, actor, thread_id)
    result = await c.confirm_proposal(db, actor, body.get("proposalId"), thread_id)
    lead = "Deleted." if text(result.get("action") or "").startswith("delete_") else "Saved."
    reply = f"{lead} {result['summary']}"
    if thread_id:
        await c.add_chat_message(db, actor, thread_id, "assistant", reply)
    return {**result, "reply": reply}


@router.post("/api/chat/dismiss")
async def dismiss(request: Request):
    db, actor, body = context(request)
    return await c.dismiss_proposal(db, actor, body.get("proposalId"))
