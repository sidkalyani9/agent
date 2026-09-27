import assert from "node:assert/strict";
import test from "node:test";
import { identityFromClaims, intuitiveSignInName } from "./identity.js";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const clientId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const oid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function claims(extra = {}) {
  return {
    tid: tenantId,
    aud: clientId,
    iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    oid,
    preferred_username: "Siddharth.Kalyani@intuitive.AI",
    name: "Siddharth Kalyani",
    ...extra,
  };
}

test("only an intuitive.AI sign-in name is accepted, in either case", () => {
  assert.equal(intuitiveSignInName("Siddharth.Kalyani@intuitive.AI"), "Siddharth.Kalyani@intuitive.AI");
  assert.equal(intuitiveSignInName("  siddharth.kalyani@intuitive.ai "), "siddharth.kalyani@intuitive.ai");
  assert.equal(intuitiveSignInName("guest@gmail.com"), null);
  assert.equal(intuitiveSignInName("user_gmail.com#EXT#@intuitive.AI"), null);
  assert.equal(intuitiveSignInName("two@@intuitive.AI"), null);
  assert.equal(intuitiveSignInName("spaced name@intuitive.AI"), null);
});

test("a Microsoft id token is accepted only for this tenant and this app", () => {
  const good = identityFromClaims(claims(), { tenantId, clientId });
  assert.equal(good.ok, true);
  assert.equal(good.signInName, "Siddharth.Kalyani@intuitive.AI");
  assert.equal(identityFromClaims(claims({ tid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }), { tenantId, clientId }).ok, false);
  assert.equal(identityFromClaims(claims({ aud: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }), { tenantId, clientId }).ok, false);
  assert.equal(identityFromClaims(claims({ iss: "https://login.microsoftonline.com/common/v2.0" }), { tenantId, clientId }).ok, false);
  assert.equal(identityFromClaims(claims({ preferred_username: "guest@gmail.com" }), { tenantId, clientId }).reason, "domain");
  assert.equal(
    identityFromClaims(claims({ preferred_username: "other_gmail.com#EXT#@intuitive.onmicrosoft.com" }), { tenantId, clientId }).reason,
    "domain",
  );
  assert.equal(identityFromClaims(claims({ oid: "not-an-object-id" }), { tenantId, clientId }).ok, false);
});
