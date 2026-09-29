"""Golden comparisons captured by the unmodified Express implementation.

These tests need no Node runtime. The input database rows and expected responses
come from scripts/capture-node-baseline.mjs running on the original checkout.
"""
import copy
import json
import re
from pathlib import Path
import pytest
from pantry import calc, core, accounts, inventory, conversations, passwords, secret, chat

CORPUS = json.loads((Path(__file__).parent / "fixtures/node-contracts.json").read_text())
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


def normalize(value):
    if isinstance(value, str):
        return UUID.sub("<uuid>", value)
    if isinstance(value, dict):
        return {k: "<password>" if k == "temporaryPassword" else normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    return value


@pytest.mark.parametrize("case", CORPUS["cases"], ids=lambda case: f"math-{CORPUS['cases'].index(case):03d}")
def test_calculation_contract(case):
    data = case["input"]
    math = calc.compute_product(**data)
    month = calc.month_figures(data["purchases"], "2026-09")
    actual = {"math": math, "month": month, "history": calc.month_history(data["purchases"], data["settings"], data["today"]),
              "forecast": calc.project_month(purchases=data["purchases"], math=math, settings=data["settings"], today=data["today"], basisPacks=month["packsAdded"], basisSpend=month["spend"]),
              "series": calc.stock_series(purchases=data["purchases"], counts=data["counts"], settings=data["settings"], today=data["today"], burnRate=math["burnRatePerEffectiveDay"], expectedDate=math["expectedDate"], onHand=math["onHand"])}
    assert actual == case["expected"]


async def load_contract_database(file):
    db = await core.open_database(file, seed="none")
    async with db.transaction():
        await db.run("DELETE FROM company_setting")
        for table, rows in CORPUS["rows"].items():
            assert re.fullmatch(r"[a-z_]+", table)
            for row in rows:
                columns = list(row)
                assert all(re.fullmatch(r"[a-z_]+", name) for name in columns)
                await db.run(f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", *row.values())
    return db


async def test_service_contracts(tmp_path):
    db = await load_contract_database(tmp_path / "contract.sqlite")
    variables = copy.deepcopy(CORPUS["vars"])
    def resolve(value):
        if isinstance(value, str) and value.startswith("$"):
            result = variables
            for key in value[1:].split("."):
                result = result[int(key)] if isinstance(result, list) else result[key]
            return result
        if isinstance(value, list):
            return [resolve(v) for v in value]
        if isinstance(value, dict):
            return {k: resolve(v) for k, v in value.items()}
        return value
    try:
        for index, step in enumerate(CORPUS["steps"]):
            name = re.sub(r"(?<!^)(?=[A-Z])", "_", step["call"]).lower()
            fn = next(getattr(module, name) for module in (accounts, inventory, conversations) if hasattr(module, name))
            try:
                result = await fn(db, variables[step["actor"]], *resolve(step["args"]))
                if step.get("save"):
                    variables[step["save"]] = result
                actual = {"ok": normalize(result)}
            except core.HttpError as error:
                actual = {"error": {"status": error.status, "message": error.message}}
            assert actual == step["expected"], f"Node service contract {index}: {step['call']} as {step['actor']}"
        for case in CORPUS["chatCases"]:
            assert chat.scope_reply(case["message"]) == case["scope"]
            assert await chat.factual_reply(db, variables["manager"], case["message"], [{"content": "Coffee at Ahmedabad"}]) == case["factual"]
    finally:
        await db.close()


def test_node_credentials_remain_usable(monkeypatch):
    credentials = CORPUS["credentials"]
    monkeypatch.setattr(passwords.time, "time", lambda: credentials["issuedAt"] + 1)
    assert passwords.verify_password(credentials["password"], credentials["hash"])
    assert not passwords.verify_password("wrong", credentials["hash"])
    assert secret.unseal(credentials["secret"]) == "portable-directory-refresh"
    assert passwords.verify_access(credentials["access"])["sid"] == "portable-session"
    assert passwords.verify_setup(credentials["setup"])["jti"] == "portable-ticket"
    monkeypatch.setattr(passwords.time, "time", lambda: credentials["issuedAt"])
    assert passwords.sign_access("portable-person", "portable-session", "portable-csrf") == credentials["access"]
    assert passwords.sign_setup("portable-person", "portable@intuitive.AI", "portable-ticket") == credentials["setup"]
    salt = passwords.unb64(credentials["hash"].split("$")[4])
    monkeypatch.setattr(passwords.secrets, "token_bytes", lambda _: salt)
    assert passwords.hash_password(credentials["password"]) == credentials["hash"]
    iv = passwords.unb64(credentials["secret"])[:12]
    monkeypatch.setattr(secret.secrets, "token_bytes", lambda _: iv)
    assert secret.seal("portable-directory-refresh") == credentials["secret"]


async def test_existing_node_sessions_survive_database_reopen_and_rotate(tmp_path, monkeypatch):
    data = json.loads((Path(__file__).parent / 'fixtures/node-session.json').read_text())
    monkeypatch.setattr(passwords.time, 'time', lambda: data['issuedAt'] + 1)
    file = tmp_path / 'existing.sqlite'
    db = await core.open_database(file, seed='none')
    try:
        async with db.transaction():
            await db.run('DELETE FROM company_setting')
            for table, rows in data['rows'].items():
                assert re.fullmatch(r'[a-z_]+', table)
                for row in rows:
                    assert all(re.fullmatch(r'[a-z_]+', column) for column in row)
                    await db.run(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})", *row.values())
        assert (await accounts.person_from_access_token(db, data['session']['accessToken']))['person']['id'] == data['admin']['id']
    finally:
        await db.close()
    db = await core.open_database(file)
    try:
        issued = data['session']
        current = await accounts.person_from_access_token(db, issued['accessToken'])
        assert current['csrf'] == issued['csrf'] and current['person']['superAdmin']
        rotated = await accounts.rotate_refresh(db, issued['refreshToken'])
        assert rotated['csrf'] == issued['csrf']
        assert secret.unseal(await accounts.graph_refresh_for(db, rotated['refreshId'])) == 'portable-graph-refresh'
        assert (await accounts.login_with_password(db, data['admin']['email'], data['password']))['next'] == 'app'
        setup = data['setup']
        assert (await accounts.setup_context(db, setup['setupToken']))['email'] == setup['email']
        assert (await accounts.complete_password_setup(db, setup['setupToken'], 'Portable next door 42', 'Portable next door 42'))['next'] == 'app'
    finally:
        await db.close()
