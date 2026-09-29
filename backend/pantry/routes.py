"""Authenticated HTTP routes. JSON names/status codes match the existing client."""
import base64
import re
from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse, Response
from . import accounts as a, inventory as i, conversations as c, entra, chat, receipt_read
from .core import HttpError
from .http import clear_auth_cookies
from .compat import text


def person(request: Request):
    session = getattr(request.state, "session", None)
    if not session:
        raise HttpError(401, "Sign in with an @intuitive.AI account.")
    return session["person"]


router = APIRouter(dependencies=[Depends(person)])


def context(request):
    return request.app.state.db, person(request), request.state.body


def attachment_name(name, fallback):
    safe = re.sub(r"[^A-Za-z0-9._ -]", "", text(name or fallback))[:120] or fallback
    return f'attachment; filename="{safe}"'


def decode_receipt(receipt):
    if not isinstance(receipt, dict) or not receipt.get("dataBase64"):
        return None
    raw = re.sub(r"[^A-Za-z0-9+/=_-]", "", text(receipt["dataBase64"])).replace("-", "+").replace("_", "/").split("=")[0]
    if len(raw) % 4 == 1:
        raw = raw[:-1]
    return {"fileName": receipt.get("fileName"), "bytes": base64.b64decode(raw + "=" * (-len(raw) % 4))}


@router.post("/api/auth/logout")
async def logout(request: Request):
    await a.revoke_browser_session(request.app.state.db, request.state.session["refreshId"])
    response = JSONResponse({"ok": True})
    clear_auth_cookies(response)
    return response


@router.get("/api/me")
async def me(request: Request):
    return {"person": person(request), "csrfToken": request.state.session["csrf"], "chatConfigured": chat.chat_configured()}


@router.get("/api/directory/users")
async def directory_users(request: Request):
    if not person(request)["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can search the directory.")
    return {"people": await entra.search_directory(request.app.state.db, request.state.session["refreshId"], request.query_params.get("query", ""))}


@router.get("/api/access")
async def access(request: Request):
    db, actor, _ = context(request)
    return {"people": await a.list_access(db, actor)}


@router.post("/api/access/invite", status_code=201)
async def invite(request: Request):
    db, actor, body = context(request)
    return await a.invite_person(db, actor, body)


@router.post("/api/access", status_code=201)
async def save_access(request: Request):
    db, actor, body = context(request)
    return await a.save_access(db, actor, body)


@router.delete("/api/access/{person_id}/grants/{grant_id}")
async def remove_grant(request: Request, person_id: str, grant_id: str):
    db, actor, _ = context(request)
    return await a.remove_grant(db, actor, person_id, grant_id)


@router.post("/api/access/{person_id}/active")
async def active(request: Request, person_id: str):
    db, actor, body = context(request)
    return await a.set_person_active(db, actor, person_id, body.get("active"))


@router.get("/api/offices")
async def offices(request: Request):
    db, actor, _ = context(request)
    return {"offices": await i.list_offices(db, actor)}


@router.post("/api/offices", status_code=201)
async def create_office(request: Request):
    db, actor, body = context(request)
    return await i.create_office(db, actor, body.get("name"), body.get("managerId"))


@router.get("/api/people")
async def people(request: Request):
    db, actor, _ = context(request)
    return {"people": await i.list_people(db, actor)}


@router.post("/api/offices/{office_id}/manager", status_code=201)
async def manager(request: Request, office_id: str):
    db, actor, body = context(request)
    return await i.assign_office_manager(db, actor, office_id, body.get("personId"))


@router.patch("/api/offices/{office_id}")
async def rename_office(request: Request, office_id: str):
    db, actor, body = context(request)
    return await i.rename_office(db, actor, office_id, body.get("name"))


@router.get("/api/offices/{office_id}/pantry")
async def pantry(request: Request, office_id: str):
    db, actor, _ = context(request)
    return await i.get_pantry(db, actor, office_id, request.query_params.get("month"))


@router.get("/api/pantry/summary")
async def summary(request: Request):
    db, actor, _ = context(request)
    return await i.summary(db, actor, request.query_params.get("month"))


@router.get("/api/offices/{office_id}/operations")
async def operations(request: Request, office_id: str):
    db, actor, _ = context(request)
    return {"operations": await i.list_operations(db, actor, office_id, {"from": request.query_params.get("from"), "to": request.query_params.get("to")})}


@router.get("/api/offices/{office_id}/export")
async def export(request: Request, office_id: str):
    db, actor, _ = context(request)
    file = await i.export_csv(db, actor, office_id, request.query_params.get("month"))
    return Response(file["body"], media_type="text/csv; charset=utf-8", headers={"Content-Disposition": attachment_name(file["filename"], "pantry.csv")})


@router.post("/api/offices/{office_id}/products", status_code=201)
async def create_product(request: Request, office_id: str):
    db, actor, body = context(request)
    return await i.create_product(db, actor, office_id, body.get("name"))


@router.patch("/api/products/{product_id}")
async def update_product(request: Request, product_id: str):
    db, actor, body = context(request)
    return await i.update_product(db, actor, product_id, body)


@router.post("/api/products/{product_id}/hide")
async def hide_product(request: Request, product_id: str):
    db, actor, _ = context(request)
    return await i.hide_product(db, actor, product_id)


@router.post("/api/products/{product_id}/restore")
async def restore_product(request: Request, product_id: str):
    db, actor, _ = context(request)
    return await i.restore_product(db, actor, product_id)


@router.post("/api/offices/{office_id}/purchases", status_code=201)
async def create_purchase(request: Request, office_id: str):
    db, actor, body = context(request)
    return await i.create_purchase(db, actor, office_id, body, decode_receipt(body.get("receipt")), request.headers.get("idempotency-key"))


@router.post("/api/offices/{office_id}/receipt-readings", status_code=202)
async def start_receipt_reading(request: Request, office_id: str):
    db, actor, body = context(request)
    return await receipt_read.start(db, actor, office_id, decode_receipt(body.get("receipt")))


@router.get("/api/offices/{office_id}/receipt-readings/open")
async def open_receipt_reading(request: Request, office_id: str):
    db, actor, _ = context(request)
    return await receipt_read.open_reading(db, actor, office_id)


@router.get("/api/offices/{office_id}/receipt-readings/{reading_id}")
async def get_receipt_reading(request: Request, office_id: str, reading_id: str):
    db, actor, _ = context(request)
    return await receipt_read.get_reading(db, actor, office_id, reading_id)


@router.patch("/api/offices/{office_id}/receipt-readings/{reading_id}")
async def patch_receipt_reading(request: Request, office_id: str, reading_id: str):
    db, actor, body = context(request)
    return await receipt_read.patch_reading(db, actor, office_id, reading_id, body)


@router.post("/api/offices/{office_id}/receipt-readings/{reading_id}/dismiss")
async def dismiss_receipt_reading(request: Request, office_id: str, reading_id: str):
    db, actor, _ = context(request)
    return await receipt_read.dismiss(db, actor, office_id, reading_id)


@router.post("/api/offices/{office_id}/receipt-readings/{reading_id}/save")
async def save_receipt_reading(request: Request, office_id: str, reading_id: str):
    db, actor, body = context(request)
    return await receipt_read.save(db, actor, office_id, reading_id, body)


@router.get("/api/offices/{office_id}/purchases")
async def purchases(request: Request, office_id: str):
    db, actor, _ = context(request)
    return {"purchases": await i.list_purchases(db, actor, office_id, request.query_params.get("month"))}


@router.get("/api/purchases/{purchase_id}/receipt")
async def receipt(request: Request, purchase_id: str):
    db, actor, _ = context(request)
    file = await i.receipt_file(db, actor, purchase_id)
    return Response(file["bytes"], media_type=file["contentType"], headers={"Content-Disposition": attachment_name(file["fileName"], "receipt")})


@router.put("/api/purchases/{purchase_id}/receipt")
async def attach_receipt(request: Request, purchase_id: str):
    db, actor, body = context(request)
    return await i.attach_receipt(db, actor, purchase_id, decode_receipt(body.get("receipt")))


@router.put("/api/purchases/{purchase_id}")
async def correct_purchase(request: Request, purchase_id: str):
    db, actor, body = context(request)
    return await i.correct_purchase(db, actor, purchase_id, body)


@router.post("/api/purchases/{purchase_id}/hide")
async def hide_purchase(request: Request, purchase_id: str):
    db, actor, _ = context(request)
    return await i.hide_purchase(db, actor, purchase_id)


@router.post("/api/purchases/{purchase_id}/delete")
async def delete_purchase(request: Request, purchase_id: str):
    db, actor, _ = context(request)
    return await i.delete_purchase(db, actor, purchase_id)


@router.put("/api/offices/{office_id}/counts")
async def count(request: Request, office_id: str):
    db, actor, body = context(request)
    return await i.upsert_count(db, actor, office_id, body)


@router.post("/api/counts/{count_id}/hide")
async def hide_count(request: Request, count_id: str):
    db, actor, _ = context(request)
    return await i.hide_count(db, actor, count_id)


@router.patch("/api/settings")
async def settings(request: Request):
    db, actor, body = context(request)
    return await i.update_settings(db, actor, body)
