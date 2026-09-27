import fs from "node:fs";
import path from "node:path";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";
import { dataDirectory } from "./config.js";

let container;
function blobContainer() {
  if (!process.env.AZURE_STORAGE_ACCOUNT_URL) return null;
  if (!container) {
    const credential = process.env.WEBSITE_SITE_NAME ? new ManagedIdentityCredential() : new DefaultAzureCredential();
    container = new BlobServiceClient(process.env.AZURE_STORAGE_ACCOUNT_URL, credential, {
      retryOptions: { maxTries: 2, tryTimeoutInMs: 10000 },
    }).getContainerClient(process.env.AZURE_STORAGE_CONTAINER || "receipts");
  }
  return container;
}

export function safeBlobName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9._-]{1,160}$/.test(name) || name === "." || name === "..") throw new Error("Invalid receipt storage name.");
  return name;
}

export async function storeReceipt(name, bytes, contentType) {
  safeBlobName(name);
  const blob = blobContainer();
  if (blob) {
    await blob.getBlockBlobClient(name).uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: "no-store", blobContentDisposition: "attachment" },
      conditions: { ifNoneMatch: "*" }, abortSignal: AbortSignal.timeout(20000),
    });
    return;
  }
  const directory = path.join(dataDirectory(), "receipts");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
}

export async function readReceipt(name) {
  safeBlobName(name);
  const blob = blobContainer();
  if (blob) {
    const download = await blob.getBlobClient(name).download(0, undefined, { abortSignal: AbortSignal.timeout(20000) });
    return download.readableStreamBody;
  }
  const file = path.join(dataDirectory(), "receipts", name);
  // Open before returning so missing-file errors can still produce JSON, not a
  // half-started download. The stream owns and closes the descriptor.
  return fs.createReadStream(file, { fd: fs.openSync(file, "r"), autoClose: true });
}
