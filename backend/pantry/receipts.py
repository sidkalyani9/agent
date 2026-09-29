"""Private, immutable local/Azure receipt objects (bounded to 10 MB on upload)."""
import asyncio
import os
import re
from pathlib import Path
from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
from azure.storage.blob import BlobServiceClient, ContentSettings
from .config import data_directory
from .compat import text


def safe_blob_name(name):
    if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9._-]{1,160}", name) or name in (".", ".."):
        raise ValueError("Invalid receipt storage name.")
    return name


def safe_receipt_name(name, fallback):
    return re.sub(r"[^A-Za-z0-9._ -]", "", Path(text(name or fallback)).name)[:120] or fallback


def sniff_receipt(data):
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    return ""


def _blob_client():
    credential = ManagedIdentityCredential() if os.getenv("WEBSITE_SITE_NAME") else DefaultAzureCredential()
    client = BlobServiceClient(os.environ["AZURE_STORAGE_ACCOUNT_URL"], credential=credential,
                               retry_total=1, connection_timeout=10, read_timeout=20)
    return credential, client


def _store(name, data, content_type):
    if os.getenv("AZURE_STORAGE_ACCOUNT_URL"):
        credential, client = _blob_client()
        try:
            blob = client.get_blob_client(os.getenv("AZURE_STORAGE_CONTAINER") or "receipts", name)
            blob.upload_blob(data, overwrite=False, timeout=20,
                             content_settings=ContentSettings(content_type=content_type, cache_control="no-store", content_disposition="attachment"))
        finally:
            client.close()
            credential.close()
        return
    directory = data_directory() / "receipts"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
        output.write(data)


async def store_receipt(name, data, content_type):
    safe_blob_name(name)
    await asyncio.to_thread(_store, name, data, content_type)


def _read(name):
    if os.getenv("AZURE_STORAGE_ACCOUNT_URL"):
        credential, client = _blob_client()
        try:
            return client.get_blob_client(os.getenv("AZURE_STORAGE_CONTAINER") or "receipts", name).download_blob(timeout=20).readall()
        finally:
            client.close()
            credential.close()
    return (data_directory() / "receipts" / name).read_bytes()


async def read_receipt(name):
    safe_blob_name(name)
    return await asyncio.to_thread(_read, name)
