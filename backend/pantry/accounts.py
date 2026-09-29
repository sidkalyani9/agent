"""Local and Microsoft identities, invitations, sessions and access grants."""
import asyncio
import secrets
import re
from datetime import timedelta
from .core import (HttpError, scoped, transactional, now, stamp, later, parse_stamp, new_id, clean_name, live_person,
                   present_person, person_by_id, office_by_id, grant, log, ROLE_LABEL, ROLES)
from .config import UUID, SESSION_IDLE_SECONDS, SESSION_ABSOLUTE_SECONDS, INVITE_SECONDS
from .identity import intuitive_sign_in_name
from .passwords import (DUMMY_PASSWORD_HASH, hash_password, verify_password, hash_token, random_invite_password,
                        password_problems, sign_access, verify_access, sign_setup, verify_setup)
from .compat import text, js_length


@scoped
async def create_session(db, person_id):
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    await db.run("INSERT INTO session (token_hash, person_id, csrf_token, created_at, expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?)", hash_token(token), person_id, csrf, stamp(), later(8 * 3600), later(12 * 3600))
    return {"token": token, "csrf": csrf}


@scoped
async def destroy_session(db, token):
    if token:
        await db.run("DELETE FROM session WHERE token_hash = ?", hash_token(token))


@scoped
async def session_from_token(db, token):
    if not token or len(text(token)) < 40:
        return None
    row = await db.get("SELECT s.csrf_token, s.expires_at, s.absolute_expires_at, p.* FROM session s JOIN person p ON p.id = s.person_id WHERE s.token_hash = ? AND p.active = 1", hash_token(token))
    if not row:
        return None
    if row["expires_at"] <= stamp() or row["absolute_expires_at"] <= stamp():
        await destroy_session(db, token)
        return None
    expiry = min(later(8 * 3600), row["absolute_expires_at"])
    if expiry > row["expires_at"]:
        await db.run("UPDATE session SET expires_at = ? WHERE token_hash = ?", expiry, hash_token(token))
    return {"csrf": row["csrf_token"], "person": await present_person(db, row), "token": token}


@scoped
async def sign_in(db, email):
    email = intuitive_sign_in_name(email)
    if not email:
        raise HttpError(401, "Only an @intuitive.AI sign-in can open this pantry.")
    person = await db.get("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE", email)
    if not person or not person["active"]:
        raise HttpError(401, "That @intuitive.AI sign-in is not on this pantry yet.")
    session = await create_session(db, person["id"])
    return {"token": session["token"], "person": await present_person(db, person)}


@scoped
async def save_login_attempt(db, *, state, verifier, nonce, purpose):
    await db.run("DELETE FROM login_attempt WHERE expires_at <= ?", stamp())
    await db.run("INSERT INTO login_attempt (state, code_verifier, nonce, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", state, verifier, nonce, "directory" if purpose == "directory" else "login", stamp(), later(600))


@scoped
async def take_login_attempt(db, state):
    row = await db.get("SELECT * FROM login_attempt WHERE state = ?", state)
    if not row:
        return None
    await db.run("DELETE FROM login_attempt WHERE state = ?", state)
    return row if row["expires_at"] > stamp() else None


@scoped
async def store_graph_refresh(db, refresh_id, sealed):
    await db.run("UPDATE refresh_token SET graph_refresh = ? WHERE id = ? AND revoked_at IS NULL", sealed, refresh_id)


@scoped
async def graph_refresh_for(db, refresh_id):
    row = await db.get("SELECT graph_refresh FROM refresh_token WHERE id = ? AND revoked_at IS NULL", refresh_id)
    return row["graph_refresh"] or "" if row else ""


@scoped
async def begin_browser_session(db, person_id, options=None):
    options = options or {}
    refresh_token, refresh_id = secrets.token_urlsafe(32), new_id()
    csrf = options.get("csrf") or secrets.token_urlsafe(32)
    created = now()
    absolute = options.get("absolute") or stamp(created + timedelta(seconds=SESSION_ABSOLUTE_SECONDS))
    expires = min(stamp(created + timedelta(seconds=SESSION_IDLE_SECONDS)), absolute)
    await db.run("""INSERT INTO refresh_token (id, person_id, token_hash, family_id, csrf_token, graph_refresh,
        expires_at, absolute_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", refresh_id, person_id,
        hash_token(refresh_token), options.get("familyId") or new_id(), csrf, options.get("graphRefresh"), expires, absolute, stamp(created))
    return {"accessToken": sign_access(person_id, refresh_id, csrf), "refreshMaxAge": max(0, int((parse_stamp(expires) - created).total_seconds())), "refreshToken": refresh_token, "csrf": csrf, "refreshId": refresh_id}


@scoped
async def person_from_access_token(db, token):
    claims = verify_access(token)
    if not claims:
        return None
    person = await person_by_id(db, claims["sub"])
    if not person or not person["active"]:
        return None
    refresh = await db.get("SELECT * FROM refresh_token WHERE id = ?", claims["sid"])
    if not refresh or refresh["person_id"] != claims["sub"] or refresh["csrf_token"] != claims["csrf"] or refresh["revoked_at"] or refresh["expires_at"] <= stamp() or refresh["absolute_expires_at"] <= stamp():
        return None
    return {"person": await present_person(db, person), "csrf": claims["csrf"], "refreshId": refresh["id"]}


@scoped
async def revoke_browser_session(db, refresh_id):
    if not refresh_id:
        return
    row = await db.get("SELECT family_id FROM refresh_token WHERE id = ?", refresh_id)
    if row:
        await db.run("UPDATE refresh_token SET revoked_at = coalesce(revoked_at, ?) WHERE family_id = ?", stamp(), row["family_id"])


@scoped
async def rotate_refresh(db, raw_token):
    if not raw_token:
        raise HttpError(401, "Sign in again.")
    denied = False
    async with db.transaction():
        row = await db.get("SELECT * FROM refresh_token WHERE token_hash = ?", hash_token(raw_token))
        if not row:
            raise HttpError(401, "Sign in again.")
        person = await person_by_id(db, row["person_id"])
        if row["revoked_at"] or row["expires_at"] <= stamp() or row["absolute_expires_at"] <= stamp() or not person or not person["active"]:
            # Commit reuse revocation before returning 401; rollback would revive
            # the current refresh token in this family.
            await db.run("UPDATE refresh_token SET revoked_at = coalesce(revoked_at, ?) WHERE family_id = ?", stamp(), row["family_id"])
            denied = True
        else:
            await db.run("UPDATE refresh_token SET revoked_at = ? WHERE id = ?", stamp(), row["id"])
            issued = await begin_browser_session(db, person["id"], {"familyId": row["family_id"], "absolute": row["absolute_expires_at"], "graphRefresh": row["graph_refresh"], "csrf": row["csrf_token"]})
            await db.run("UPDATE refresh_token SET replaced_by = ? WHERE id = ?", issued["refreshId"], row["id"])
    if denied:
        raise HttpError(401, "Sign in again.")
    return {**issued, "person": await present_person(db, person)}


async def revoke_person_sessions(db, person_id):
    await db.run("DELETE FROM session WHERE person_id = ?", person_id)
    await db.run("DELETE FROM setup_ticket WHERE person_id = ?", person_id)
    await db.run("UPDATE refresh_token SET revoked_at = coalesce(revoked_at, ?) WHERE person_id = ?", stamp(), person_id)


@scoped
async def login_with_password(db, email, password):
    if not isinstance(password, str) or not password or js_length(password) > 128:
        raise HttpError(401, "Email or password is incorrect.")
    email = intuitive_sign_in_name(email)
    if not email:
        raise HttpError(401, "Use an @intuitive.AI email.")
    person = await db.get("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE", email)
    if person and person["locked_until"] and person["locked_until"] > stamp():
        raise HttpError(429, "Too many attempts. Wait 15 minutes and try again.")
    valid = await asyncio.to_thread(verify_password, password, person["password_hash"] if person and person["password_hash"] else DUMMY_PASSWORD_HASH)
    if not person or not person["password_hash"] or not valid:
        if person and person["password_hash"]:
            attempts = (person["failed_attempts"] or 0) + 1
            if attempts >= 5:
                await db.run("UPDATE person SET failed_attempts = 0, locked_until = ? WHERE id = ?", later(900), person["id"])
            else:
                await db.run("UPDATE person SET failed_attempts = ? WHERE id = ?", attempts, person["id"])
        raise HttpError(401, "Email or password is incorrect.")
    if not person["active"]:
        raise HttpError(403, "This account is turned off. A Super Admin can turn it back on.", "inactive")
    await db.run("UPDATE person SET failed_attempts = 0, locked_until = NULL WHERE id = ?", person["id"])
    if person["must_set_password"]:
        if not person["invited_at"] or parse_stamp(person["invited_at"]) + timedelta(seconds=INVITE_SECONDS) <= now():
            raise HttpError(401, "That invite expired. Ask a Super Admin for a new invite.")
        jti = new_id()
        await db.run("DELETE FROM setup_ticket WHERE person_id = ?", person["id"])
        await db.run("INSERT INTO setup_ticket (jti_hash, person_id, expires_at) VALUES (?, ?, ?)", hash_token(jti), person["id"], later(900))
        return {"next": "setup", "email": person["sign_in_name"], "setupToken": sign_setup(person["id"], person["sign_in_name"], jti)}
    return {"next": "app", "person": await present_person(db, person), **await begin_browser_session(db, person["id"])}


@scoped
async def setup_context(db, token):
    claims = verify_setup(token)
    if not claims:
        return None
    ticket = await db.get("SELECT * FROM setup_ticket WHERE jti_hash = ?", hash_token(claims["jti"]))
    if not ticket or ticket["used_at"] or ticket["expires_at"] <= stamp() or ticket["person_id"] != claims["sub"]:
        return None
    person = await person_by_id(db, claims["sub"])
    return {"email": person["sign_in_name"]} if person and person["active"] and person["must_set_password"] else None


@transactional
async def complete_password_setup(db, token, password, confirm):
    if text(password or "") != text(confirm or ""):
        raise HttpError(422, "Those passwords do not match.")
    claims = verify_setup(token)
    if not claims:
        raise HttpError(401, "Sign in with the invite password again.")
    ticket = await db.get("SELECT * FROM setup_ticket WHERE jti_hash = ?", hash_token(claims["jti"]))
    if not ticket or ticket["used_at"] or ticket["expires_at"] <= stamp() or ticket["person_id"] != claims["sub"]:
        raise HttpError(401, "That setup step expired. Sign in with the invite password again.")
    person = await person_by_id(db, claims["sub"])
    if not person or not person["active"]:
        raise HttpError(403, "This account is turned off. A Super Admin can turn it back on.")
    if not person["must_set_password"]:
        raise HttpError(401, "That setup step is no longer available.")
    problems = password_problems(password, person["sign_in_name"])
    if problems:
        raise HttpError(422, problems[0])
    if person["password_hash"] and await asyncio.to_thread(verify_password, password, person["password_hash"]):
        raise HttpError(422, "Choose a password that is different from the invite password.")
    hashed = await asyncio.to_thread(hash_password, password)
    await db.run("UPDATE person SET password_hash = ?, must_set_password = 0, failed_attempts = 0, locked_until = NULL WHERE id = ?", hashed, person["id"])
    await db.run("UPDATE setup_ticket SET used_at = ? WHERE jti_hash = ?", stamp(), hash_token(claims["jti"]))
    await revoke_person_sessions(db, person["id"])
    return {"next": "app", "person": await present_person(db, await person_by_id(db, person["id"])), **await begin_browser_session(db, person["id"])}


@transactional
async def invite_person(db, actor, body):
    actor = await live_person(db, actor)
    if not actor["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can invite someone.")
    email = intuitive_sign_in_name(body.get("email") or body.get("signInName"))
    if not email:
        raise HttpError(422, "Use an @intuitive.AI email.")
    existing = await db.get("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE", email)
    if existing and existing["password_hash"] and not existing["must_set_password"]:
        raise HttpError(422, "That person already chose a password.")
    from_email = re.sub(r"\b\w", lambda m: m[0].upper(), re.sub(r"[._+-]+", " ", email.split("@")[0]).strip())
    name = clean_name(body.get("displayName")) or (existing["display_name"] if existing else clean_name(from_email))
    if len(name) < 2:
        raise HttpError(422, "Enter the person's name.")
    temporary = random_invite_password()
    hashed = await asyncio.to_thread(hash_password, temporary)
    person_id = existing["id"] if existing else new_id()
    if not existing:
        await db.run("INSERT INTO person (id, sign_in_name, display_name, active, password_hash, must_set_password, invited_at, failed_attempts) VALUES (?, ?, ?, 1, ?, 1, ?, 0)", person_id, email, name, hashed, stamp())
        await log(db, actor["id"], "person.add", "person", person_id, None, f"Invited {name}.")
    else:
        await revoke_person_sessions(db, person_id)
        await db.run("UPDATE person SET display_name = ?, active = 1, password_hash = ?, must_set_password = 1, invited_at = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?", name, hashed, stamp(), person_id)
        await log(db, actor["id"], "person.invite", "person", person_id, None, f"Sent a new invite password for {name}.")
    return {"email": email, "displayName": name, "temporaryPassword": temporary}


@transactional
async def accept_microsoft_login(db, identity):
    email = intuitive_sign_in_name(identity.get("signInName"))
    if not email:
        raise HttpError(403, "Only an @intuitive.AI Microsoft account can open this pantry.", "domain")
    oid = text(identity.get("oid") or "")
    if not UUID.fullmatch(oid):
        raise HttpError(401, "Microsoft did not confirm this account.", "failed")
    by_oid = await db.get("SELECT * FROM person WHERE directory_object_id = ?", oid)
    by_email = await db.get("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE", email)
    if by_oid and by_email and by_oid["id"] != by_email["id"]:
        raise HttpError(403, "This Microsoft account does not match the pantry access list.", "not_on_list")
    person = by_oid or by_email
    if not person:
        raise HttpError(403, "This Microsoft account is not on the pantry access list. A Super Admin has to add it first.", "not_on_list")
    if not person["active"]:
        raise HttpError(403, "This account is turned off. A Super Admin can turn it back on.", "inactive")
    if person["directory_object_id"] and person["directory_object_id"] != oid:
        raise HttpError(403, "This Microsoft account does not match the pantry access list.", "not_on_list")
    if await db.get("SELECT id FROM person WHERE sign_in_name = ? COLLATE NOCASE AND id != ?", email, person["id"]):
        raise HttpError(403, "This sign-in name is already on the pantry access list.", "not_on_list")
    await db.run("UPDATE person SET directory_object_id = ?, sign_in_name = ?, display_name = ? WHERE id = ?", oid, email, clean_name(identity.get("displayName")) or person["display_name"], person["id"])
    return await present_person(db, await person_by_id(db, person["id"]))


async def super_admin_count(db):
    return (await db.get("SELECT COUNT(DISTINCT g.person_id) AS n FROM role_grant g JOIN person p ON p.id = g.person_id WHERE g.role = 'super_admin' AND g.deleted_at IS NULL AND p.active = 1"))["n"]


async def present_access(db, person):
    presented = await present_person(db, person)
    return {k: presented[k] for k in ("id", "displayName", "email", "active")} | {"invitePending": bool(person["must_set_password"]), "grants": [{**g, "label": ROLE_LABEL[g["role"]] + (f" · {g['officeName']}" if g["officeName"] else "")} for g in presented["grants"]]}


@scoped
async def list_access(db, actor):
    actor = await live_person(db, actor)
    if not actor["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can manage access.")
    return [await present_access(db, p) for p in await db.all("SELECT * FROM person ORDER BY display_name")]


@transactional
async def save_access(db, actor, body):
    actor = await live_person(db, actor)
    if not actor["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can add someone or assign a role.")
    email = intuitive_sign_in_name(body.get("signInName"))
    if not email:
        raise HttpError(422, "Use an @intuitive.AI sign-in name.")
    name = clean_name(body.get("displayName"))
    if len(name) < 2:
        raise HttpError(422, "Enter the person's name.")
    role = text(body.get("role") or "")
    if role not in ROLES:
        raise HttpError(422, "Choose a role.")
    office_id = text(body["officeId"]) if body.get("officeId") else None
    if role in ("super_admin", "admin"):
        if office_id:
            raise HttpError(422, "Admin covers every office." if role == "admin" else "Super Admin covers every office.")
    elif not office_id or not await office_by_id(db, office_id):
        raise HttpError(422, "Choose an office for this role.")
    oid = text(body["directoryObjectId"]).strip() if body.get("directoryObjectId") else None
    if oid and not UUID.fullmatch(oid):
        raise HttpError(422, "That directory account is not valid.")
    home = text(body["homeOfficeId"]) if body.get("homeOfficeId") else None
    if home and not await office_by_id(db, home):
        raise HttpError(422, "Choose a home office that exists.")
    person = await db.get("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE", email)
    if oid:
        by_oid = await db.get("SELECT * FROM person WHERE directory_object_id = ?", oid)
        if by_oid and person and by_oid["id"] != person["id"]:
            raise HttpError(422, "That directory account is already on the access list.")
        person = person or by_oid
    if person and await db.get("SELECT id FROM role_grant WHERE person_id = ? AND role = ? AND ifnull(office_id, '') = ifnull(?, '') AND deleted_at IS NULL", person["id"], role, office_id):
        raise HttpError(422, "That role is already assigned.")
    if not person:
        person_id = new_id()
        await db.run("INSERT INTO person (id, directory_object_id, sign_in_name, display_name, home_office_id, active) VALUES (?, ?, ?, ?, ?, 1)", person_id, oid, email, name, home)
        await log(db, actor["id"], "person.add", "person", person_id, home, f"Added {name} to the access list.")
    else:
        person_id = person["id"]
        await db.run("UPDATE person SET display_name = ?, active = 1, directory_object_id = coalesce(?, directory_object_id), sign_in_name = ?, home_office_id = coalesce(?, home_office_id) WHERE id = ?", name, oid, email, home, person_id)
    await grant(db, actor["id"], person_id, role, office_id)
    office = await office_by_id(db, office_id) if office_id else None
    suffix = f" at {office['name']}" if office else ""
    await log(db, actor["id"], "grant.grant", "grant", person_id, office_id, f"Granted {ROLE_LABEL[role]}{suffix} to {name}.")
    return await present_access(db, await person_by_id(db, person_id))


@transactional
async def remove_grant(db, actor, person_id, grant_id):
    actor = await live_person(db, actor)
    if not actor["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can change access.")
    row = await db.get("SELECT * FROM role_grant WHERE id = ? AND person_id = ? AND deleted_at IS NULL", grant_id, person_id)
    if not row:
        raise HttpError(404, "That access grant was not found.")
    if row["role"] == "super_admin" and await super_admin_count(db) <= 1:
        raise HttpError(422, "The last Super Admin has to stay on.")
    await db.run("UPDATE role_grant SET deleted_by = ?, deleted_at = ? WHERE id = ?", actor["id"], stamp(), grant_id)
    await log(db, actor["id"], "grant.remove", "grant", grant_id, row["office_id"], "Removed an access grant. The row stays.")
    return {"id": grant_id, "removed": True}


@transactional
async def set_person_active(db, actor, person_id, active):
    actor = await live_person(db, actor)
    if not actor["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can change access.")
    person = await person_by_id(db, person_id)
    if not person:
        raise HttpError(404, "That person was not found.")
    if type(active) is not bool:
        raise HttpError(422, "Active must be true or false.")
    if not active:
        admins = await super_admin_count(db)
        is_super = await db.get("SELECT id FROM role_grant WHERE person_id = ? AND role = 'super_admin' AND deleted_at IS NULL", person_id)
        if is_super and admins <= 1:
            raise HttpError(422, "The last Super Admin has to stay on.")
    await db.run("UPDATE person SET active = ? WHERE id = ?", 1 if active else 0, person_id)
    if not active:
        await revoke_person_sessions(db, person_id)
    await log(db, actor["id"], "person.restore" if active else "person.disable", "person", person_id, None, f"Turned {person['display_name']} {'back on' if active else 'off'}.")
    return {"id": person_id, "active": active}
