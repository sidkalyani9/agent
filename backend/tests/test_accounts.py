import asyncio
import json
from datetime import timedelta
import pytest
from pantry import core as c, accounts as a, inventory as i, passwords as p, secret, identity


def fails(status, message=None):
    return pytest.raises(c.HttpError, match=message, check=lambda error: error.status == status)


def test_unicode_password_length_matches_javascript():
    assert "Use at least 12 characters." not in p.password_problems("Abcd1234😀😀", "person@intuitive.AI")
    assert "Use at most 128 characters." in p.password_problems("Abcd1234" + "😀" * 61, "person@intuitive.AI")


async def choose_password(db, admin, email):
    invitation = await a.invite_person(db, admin, {"email": email})
    setup = await a.login_with_password(db, invitation["email"], invitation["temporaryPassword"])
    issued = await a.complete_password_setup(db, setup["setupToken"], "Pantry Door 19", "Pantry Door 19")
    return invitation, setup, issued


async def test_invite_setup_password_hash_and_replay(db, people):
    admin = people["admin"]
    with fails(422):
        await a.invite_person(db, admin, {"email": "guest@gmail.com"})
    with fails(401):
        await a.login_with_password(db, "unknown@intuitive.AI", "Pantry Door 19")
    invite, setup, issued = await choose_password(db, admin, admin["email"])
    assert issued["next"] == "app" and issued["person"]["superAdmin"]
    row = await c.person_by_id(db, admin["id"])
    assert row["password_hash"].startswith("scrypt$32768$8$1$")
    assert "Pantry Door 19" not in row["password_hash"]
    with fails(422):
        await a.invite_person(db, admin, {"email": admin["email"]})
    with fails(401):
        await a.complete_password_setup(db, setup["setupToken"], "Pantry Door 19", "Pantry Door 19")
    with fails(401):
        await a.login_with_password(db, invite["email"], invite["temporaryPassword"])
    session = await a.login_with_password(db, invite["email"], "Pantry Door 19")
    renewed = await a.rotate_refresh(db, session["refreshToken"])
    assert renewed["csrf"] == session["csrf"]
    assert renewed["refreshToken"] != session["refreshToken"]
    assert await a.person_from_access_token(db, session["accessToken"]) is None
    assert (await a.person_from_access_token(db, renewed["accessToken"]))["person"]["id"] == admin["id"]
    with fails(401):
        await a.rotate_refresh(db, session["refreshToken"])
    with fails(401):
        await a.rotate_refresh(db, renewed["refreshToken"])


async def test_setup_validation_and_ticket_lifecycle(db, people):
    invite = await a.invite_person(db, people["admin"], {"email": people["manager"]["email"]})
    setup = await a.login_with_password(db, invite["email"], invite["temporaryPassword"])
    assert await a.setup_context(db, setup["setupToken"]) == {"email": invite["email"]}
    for first, second in [("Pantry Door 19", "Pantry Door 18"), ("short", "short"), (invite["temporaryPassword"], invite["temporaryPassword"])]:
        with fails(422):
            await a.complete_password_setup(db, setup["setupToken"], first, second)
    session = await a.begin_browser_session(db, people["manager"]["id"])
    await a.invite_person(db, people["admin"], {"email": invite["email"]})
    assert await a.setup_context(db, setup["setupToken"]) is None
    assert await a.person_from_access_token(db, session["accessToken"]) is None


async def test_disable_reenable_revokes_every_credential(db, people):
    admin, member = people["admin"], people["manager"]
    invite = await a.invite_person(db, admin, {"email": member["email"]})
    setup = await a.login_with_password(db, invite["email"], invite["temporaryPassword"])
    browser = await a.begin_browser_session(db, member["id"])
    legacy = await a.create_session(db, member["id"])
    await a.set_person_active(db, admin, member["id"], False)
    await a.set_person_active(db, admin, member["id"], True)
    assert await a.session_from_token(db, legacy["token"]) is None
    assert await a.person_from_access_token(db, browser["accessToken"]) is None
    assert await a.setup_context(db, setup["setupToken"]) is None
    with fails(401):
        await a.rotate_refresh(db, browser["refreshToken"])


async def test_password_lockout_is_generic_and_expires(db, people):
    member = people["manager"]
    await choose_password(db, people["admin"], member["email"])
    with fails(401) as unknown:
        await a.login_with_password(db, "unknown@intuitive.AI", "Wrong password 42")
    for _ in range(5):
        with fails(401) as known:
            await a.login_with_password(db, member["email"], "Wrong password 42")
        assert str(unknown.value) == str(known.value)
    with fails(429):
        await a.login_with_password(db, member["email"], "Pantry Door 19")
    future = c.now() + timedelta(minutes=15)
    c.set_clock(lambda: future)
    assert (await a.login_with_password(db, member["email"], "Pantry Door 19"))["next"] == "app"


async def test_invite_and_setup_expiry(db, people):
    invite = await a.invite_person(db, people["admin"], {"email": people["manager"]["email"]})
    setup = await a.login_with_password(db, invite["email"], invite["temporaryPassword"])
    start = c.now()
    c.set_clock(lambda: start + timedelta(minutes=15))
    assert await a.setup_context(db, setup["setupToken"]) is None
    c.set_clock(lambda: start + timedelta(days=7))
    with fails(401, "invite expired"):
        await a.login_with_password(db, invite["email"], invite["temporaryPassword"])


async def test_session_sliding_absolute_expiry_and_concurrent_reuse(db, people):
    start = c.now()
    idle = await a.begin_browser_session(db, people["manager"]["id"])
    c.set_clock(lambda: start + timedelta(days=90))
    with fails(401):
        await a.rotate_refresh(db, idle["refreshToken"])
    c.set_clock(lambda: start)
    session = await a.begin_browser_session(db, people["manager"]["id"])
    csrf = session["csrf"]
    for day in (30, 60, 120, 179):
        c.set_clock(lambda day=day: start + timedelta(days=day))
        session = await a.rotate_refresh(db, session["refreshToken"])
        assert session["csrf"] == csrf
    assert session["refreshMaxAge"] == 86400
    c.set_clock(lambda: start + timedelta(days=180))
    with fails(401):
        await a.rotate_refresh(db, session["refreshToken"])
    c.set_clock(lambda: start)
    session = await a.begin_browser_session(db, people["manager"]["id"])
    results = await asyncio.gather(a.rotate_refresh(db, session["refreshToken"]), a.rotate_refresh(db, session["refreshToken"]), return_exceptions=True)
    assert sum(isinstance(r, dict) for r in results) == 1
    issued = next(r for r in results if isinstance(r, dict))
    assert await a.person_from_access_token(db, issued["accessToken"]) is None


async def test_last_active_admin_and_live_roles(db, people, offices):
    admin = people["admin"]
    second = await a.save_access(db, admin, {"signInName": "second@intuitive.AI", "displayName": "Second", "role": "super_admin"})
    await a.set_person_active(db, admin, second["id"], False)
    with fails(422):
        await a.set_person_active(db, admin, admin["id"], False)
    with fails(422):
        await a.remove_grant(db, admin, admin["id"], admin["grants"][0]["id"])
    manager = people["manager"]
    await a.remove_grant(db, admin, manager["id"], manager["grants"][0]["id"])
    with fails(404):
        await i.create_product(db, manager, offices["Ahmedabad"], "Unauthorized")


async def test_production_seed_is_once_only(tmp_path):
    file = tmp_path / "production.sqlite"
    db = await c.open_database(file, seed="production")
    try:
        admin = (await a.sign_in(db, "Siddharth.Kalyani@intuitive.AI"))["person"]
        assert await i.list_offices(db, admin) == []
        assert len(await db.all("SELECT id FROM person")) == 1
        second = await a.save_access(db, admin, {"signInName": "second@intuitive.AI", "displayName": "Second", "role": "super_admin"})
        actor = (await a.sign_in(db, second["email"]))["person"]
        await a.remove_grant(db, actor, admin["id"], admin["grants"][0]["id"])
    finally:
        await db.close()
    db = await c.open_database(file, seed="production")
    try:
        assert not (await a.sign_in(db, admin["email"]))["person"]["superAdmin"]
    finally:
        await db.close()


async def test_microsoft_allowlist_and_immutable_object_binding(db, people):
    admin = people["admin"]
    oid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    body = {"signInName": "microsoft.member@intuitive.AI", "displayName": "Microsoft Member", "role": "admin"}
    with fails(403):
        await a.accept_microsoft_login(db, {"signInName": body["signInName"], "oid": oid})
    member = await a.save_access(db, admin, body)
    signed = await a.accept_microsoft_login(db, {"signInName": body["signInName"], "oid": oid, "displayName": "Member"})
    assert signed["id"] == member["id"]
    with fails(403):
        await a.accept_microsoft_login(db, {"signInName": body["signInName"], "oid": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"})
    renamed = await a.accept_microsoft_login(db, {"signInName": "renamed@intuitive.AI", "oid": oid})
    assert renamed["id"] == member["id"]
    await a.set_person_active(db, admin, member["id"], False)
    with fails(403):
        await a.accept_microsoft_login(db, {"signInName": "renamed@intuitive.AI", "oid": oid})


@pytest.mark.parametrize("value", ["short", "alllowercase12", "Password123456!", " Member safe 42", "Member safe 42 ", "x" * 129, "memberSafePass42"])
def test_password_policy(value):
    assert p.password_problems(value, "member@intuitive.AI")


def test_hash_and_jwt_fail_closed():
    assert not p.password_problems("Pantry Door 19", "a@intuitive.AI")
    hashed = p.hash_password("Pantry Door 19")
    assert p.verify_password("Pantry Door 19", hashed)
    assert not p.verify_password("Pantry Door 19", hashed.replace("32768", "16384"))
    assert p.verify_access("bnVsbA.e30.invalid") is None
    assert p.verify_access("a.b.c") is None
    assert p.verify_setup(p.sign_access("p", "s", "c")) is None
    sealed = secret.seal("private")
    assert secret.unseal(sealed) == "private"
    with pytest.raises(Exception):
        secret.unseal(sealed[:-3] + "AAA")
