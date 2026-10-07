#!/usr/bin/env python3
"""Independent black-box acceptance. Python stdlib only; no browser."""
import http.cookiejar
import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = "Correct-horse-2026!"


class Server:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="taskforge-acceptance-")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.log = open(Path(self.tmp.name) / "server.log", "w+")
        self.process = None

    def start(self):
        env = dict(os.environ, PORT=str(self.port), APP_ORIGIN=self.origin,
                   DATABASE_PATH=str(Path(self.tmp.name) / "nested" / "app.sqlite"),
                   NODE_ENV="test", AUTH_RATE_LIMIT_MAX="10000")
        self.process = subprocess.Popen(["bun", "run", "start"], cwd=ROOT, env=env,
                                        stdout=self.log, stderr=self.log, start_new_session=True)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                break
            try:
                with urllib.request.urlopen(self.origin + "/api/health", timeout=1) as res:
                    if res.status == 200 and json.load(res).get("ok") is True:
                        return
            except Exception:
                time.sleep(.15)
        self.log.flush()
        self.log.seek(0)
        raise RuntimeError("Server did not become healthy:\n" + self.log.read()[-6000:])

    def stop(self):
        if self.process and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()

    def close(self):
        self.stop()
        self.log.close()
        self.tmp.cleanup()


class Client:
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def request(self, method, path, body=None, *, raw=None, origin=None):
        headers = {"Origin": origin or SERVER.origin}
        data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(SERVER.origin + path, data=data, headers=headers, method=method)
        try:
            res = self.opener.open(req, timeout=15)
        except urllib.error.HTTPError as exc:
            res = exc
        with res:
            content = res.read()
            try:
                value = json.loads(content) if content else None
            except json.JSONDecodeError:
                value = content.decode(errors="replace")
            return res.status, value, res.headers


class Acceptance(unittest.TestCase):
    def request(self, client, method, path, body=None, status=200, **kwargs):
        code, value, headers = client.request(method, path, body, **kwargs)
        expected = status if isinstance(status, tuple) else (status,)
        self.assertIn(code, expected, f"{method} {path}: {code} {str(value)[:300]}")
        if code >= 400:
            self.assertIsInstance(value, dict)
            self.assertIsInstance(value.get("error"), str)
        return value

    def user(self, label="Member"):
        client = Client()
        email = f"{uuid.uuid4().hex}@example.test"
        data = self.request(client, "POST", "/api/auth/register",
                            {"name": label, "email": email, "password": PASSWORD}, 201)
        return client, data["user"], email

    def setUp(self):
        self.owner, self.owner_user, self.email = self.user("Owner")
        self.other, self.other_user, self.other_email = self.user("Other")
        self.project = self.request(self.owner, "POST", "/api/projects", {"name": " Project "}, 201)["project"]
        self.base = "/api/projects/" + self.project["id"]

    def join(self, role="editor", client=None, email=None):
        invite = self.request(self.owner, "POST", self.base + "/invitations",
                              {"email": email or self.other_email, "role": role}, 201)["invite"]
        self.request(client or self.other, "POST", "/api/invitations/accept", {"token": invite["token"]})
        return invite

    def task(self, **extra):
        return self.request(self.owner, "POST", self.base + "/tasks", {"title": " First task ", **extra}, 201)["task"]

    def test_auth_session_and_email_normalization(self):
        self.request(self.owner, "POST", "/api/auth/logout", status=204)
        self.request(self.owner, "GET", "/api/auth/me", status=401)
        data = self.request(self.owner, "POST", "/api/auth/login", {"email": " " + self.email.upper() + " ", "password": PASSWORD})
        self.assertEqual(data["user"]["id"], self.owner_user["id"])
        self.assertEqual(self.request(self.owner, "GET", "/api/auth/me")["user"]["email"], self.email)

    def test_duplicate_email_and_weak_password(self):
        self.request(Client(), "POST", "/api/auth/register", {"name": "x", "email": self.email.upper(), "password": PASSWORD}, 409)
        self.request(Client(), "POST", "/api/auth/register", {"name": "x", "email": "new@example.test", "password": "short"}, 400)

    def test_invalid_auth_is_generic(self):
        a = self.request(Client(), "POST", "/api/auth/login", {"email": self.email, "password": "not-the-password"}, 401)
        b = self.request(Client(), "POST", "/api/auth/login", {"email": "absent@example.test", "password": "not-the-password"}, 401)
        self.assertEqual(a["error"], b["error"])

    def test_cookie_security_and_no_secret_json(self):
        client = Client()
        code, body, headers = client.request("POST", "/api/auth/login", {"email": self.email, "password": PASSWORD})
        self.assertEqual(code, 200)
        cookie = headers.get("Set-Cookie", "").lower()
        self.assertIn("httponly", cookie)
        self.assertRegex(cookie, r"samesite=(lax|strict)")
        value = json.dumps(body).lower()
        for secret in ("password", "hash", "sessiontoken", "session_token"):
            self.assertNotIn(secret, value)

    def test_password_change_revokes_all_sessions(self):
        second = Client()
        self.request(second, "POST", "/api/auth/login", {"email": self.email, "password": PASSWORD})
        self.request(self.owner, "POST", "/api/auth/password", {"currentPassword": PASSWORD, "newPassword": "New-correct-password-2026!"}, 204)
        for client in (self.owner, second):
            self.request(client, "GET", "/api/auth/me", status=401)
        self.request(Client(), "POST", "/api/auth/login", {"email": self.email, "password": PASSWORD}, 401)
        self.request(Client(), "POST", "/api/auth/login", {"email": self.email, "password": "New-correct-password-2026!"})

    def test_foreign_origin_is_rejected(self):
        self.request(self.owner, "POST", "/api/projects", {"name": "CSRF"}, 403, origin="https://evil.example")

    def test_anonymous_and_outsider_access(self):
        self.request(Client(), "GET", "/api/projects", status=401)
        task = self.task()
        for path in (self.base, self.base + "/tasks", self.base + "/tasks/" + task["id"], self.base + "/activity", self.base + "/tasks/" + task["id"] + "/comments"):
            self.request(self.other, "GET", path, status=(403, 404))
        self.assertEqual(self.request(self.other, "GET", "/api/projects")["projects"], [])

    def test_project_owner_and_crud(self):
        detail = self.request(self.owner, "GET", self.base)
        self.assertEqual(detail["project"]["name"], "Project")
        self.assertEqual(detail["project"]["role"], "owner")
        self.assertEqual(len(detail["members"]), 1)
        self.assertEqual(self.request(self.owner, "PATCH", self.base, {"name": "Renamed"})["project"]["name"], "Renamed")
        self.request(self.owner, "DELETE", self.base, status=204)
        self.request(self.owner, "GET", self.base, status=(403, 404))

    def test_invitation_email_binding_and_replay(self):
        invite = self.request(self.owner, "POST", self.base + "/invitations", {"email": self.other_email, "role": "editor"}, 201)["invite"]
        self.request(self.owner, "POST", "/api/invitations/accept", {"token": invite["token"]}, (403, 404))
        self.request(self.other, "POST", "/api/invitations/accept", {"token": invite["token"]})
        self.request(self.other, "POST", "/api/invitations/accept", {"token": invite["token"]}, 409)
        self.assertEqual(len(self.request(self.owner, "GET", self.base)["members"]), 2)

    def test_viewer_permissions(self):
        self.join("viewer")
        task = self.task()
        self.request(self.other, "GET", self.base + "/tasks")
        self.request(self.other, "POST", self.base + "/tasks", {"title": "Forbidden"}, 403)
        self.request(self.other, "PATCH", self.base + "/tasks/" + task["id"], {"status": "done"}, 403)
        self.request(self.other, "POST", self.base + "/tasks/" + task["id"] + "/comments", {"body": "Forbidden"}, 403)
        self.request(self.other, "DELETE", self.base, status=403)

    def test_editor_permissions(self):
        self.join()
        task = self.request(self.other, "POST", self.base + "/tasks", {"title": "Editor task"}, 201)["task"]
        self.request(self.other, "PATCH", self.base + "/tasks/" + task["id"], {"status": "done"})
        self.request(self.other, "PATCH", self.base, {"name": "Forbidden"}, 403)
        self.request(self.other, "POST", self.base + "/invitations", {"email": "x@example.test", "role": "owner"}, (400, 403))

    def test_owner_cannot_be_demoted_or_removed(self):
        path = self.base + "/members/" + self.owner_user["id"]
        self.request(self.owner, "PATCH", path, {"role": "viewer"}, (400, 403, 409))
        self.request(self.owner, "DELETE", path, status=(400, 403, 409))
        self.assertEqual(self.request(self.owner, "GET", self.base)["project"]["role"], "owner")

    def test_role_change_takes_effect(self):
        self.join()
        self.request(self.owner, "PATCH", self.base + "/members/" + self.other_user["id"], {"role": "viewer"})
        self.request(self.other, "POST", self.base + "/tasks", {"title": "Forbidden"}, 403)

    def test_member_removal_unassigns_tasks(self):
        self.join()
        task = self.task(assigneeId=self.other_user["id"])
        self.request(self.owner, "DELETE", self.base + "/members/" + self.other_user["id"], status=204)
        self.assertIsNone(self.request(self.owner, "GET", self.base + "/tasks/" + task["id"])["task"]["assigneeId"])
        self.request(self.other, "GET", self.base, status=(403, 404))

    def test_task_defaults_and_crud(self):
        task = self.task()
        for key, value in {"title": "First task", "description": "", "status": "todo", "priority": "medium", "assigneeId": None, "dueDate": None}.items():
            self.assertEqual(task[key], value)
        path = self.base + "/tasks/" + task["id"]
        task = self.request(self.owner, "PATCH", path, {"description": "Details", "status": "done", "priority": "high", "dueDate": "2027-02-28"})["task"]
        self.assertEqual(task["dueDate"], "2027-02-28")
        self.request(self.owner, "DELETE", path, status=204)
        self.request(self.owner, "GET", path, status=404)

    def test_task_validation(self):
        for body in ({"title": " "}, {"title": "x", "status": "bad"}, {"title": "x", "priority": "urgent"}, {"title": "x", "dueDate": "2027-02-30"}, {"title": "x", "extra": True}, {"title": "x", "assigneeId": self.other_user["id"]}):
            self.request(self.owner, "POST", self.base + "/tasks", body, 400)
        task = self.task()
        self.request(self.owner, "PATCH", self.base + "/tasks/" + task["id"], {}, 400)
        self.request(self.owner, "POST", self.base + "/tasks", status=400, raw=b'{broken')

    def test_nested_resource_scope(self):
        task = self.task()
        p2 = self.request(self.owner, "POST", "/api/projects", {"name": "Second"}, 201)["project"]
        path = "/api/projects/" + p2["id"] + "/tasks/" + task["id"]
        self.request(self.owner, "GET", path, status=404)
        self.request(self.owner, "PATCH", path, {"title": "Wrong project"}, 404)
        self.request(self.owner, "DELETE", path, status=404)

    def test_filters_and_filtered_total(self):
        self.task(title="Needle", status="done", priority="high", assigneeId=self.owner_user["id"])
        self.task(title="Other")
        data = self.request(self.owner, "GET", self.base + "/tasks?q=needle&status=done&priority=high&assigneeId=" + self.owner_user["id"])
        self.assertEqual(data["total"], 1)
        self.assertEqual(len(data["tasks"]), 1)
        self.assertEqual(data["tasks"][0]["title"], "Needle")

    def test_pagination_stable_and_validated(self):
        for i in range(5):
            self.task(title=f"Task {i}")
        first = self.request(self.owner, "GET", self.base + "/tasks?page=1&pageSize=2")
        second = self.request(self.owner, "GET", self.base + "/tasks?page=2&pageSize=2")
        self.assertEqual(first["total"], 5)
        self.assertEqual((first["page"], first["pageSize"]), (1, 2))
        self.assertEqual(len(first["tasks"]), 2)
        self.assertFalse({t["id"] for t in first["tasks"]} & {t["id"] for t in second["tasks"]})
        self.assertEqual(first, self.request(self.owner, "GET", self.base + "/tasks?page=1&pageSize=2"))
        for query in ("page=0", "pageSize=101", "page=1.5", "status=invalid", "priority=invalid"):
            self.request(self.owner, "GET", self.base + "/tasks?" + query, status=400)

    def test_search_literal_wildcards(self):
        self.task(title="100% done")
        self.task(title="ordinary task")
        data = self.request(self.owner, "GET", self.base + "/tasks?q=%25")
        self.assertEqual(data["total"], 1)

    def test_comment_ownership(self):
        self.join()
        task = self.task()
        path = self.base + "/tasks/" + task["id"] + "/comments"
        own = self.request(self.owner, "POST", path, {"body": "Owner comment"}, 201)["comment"]
        self.request(self.other, "DELETE", path + "/" + own["id"], status=403)
        comment = self.request(self.other, "POST", path, {"body": "Editor comment"}, 201)["comment"]
        self.assertEqual(comment["authorId"], self.other_user["id"])
        self.request(self.owner, "DELETE", path + "/" + comment["id"], status=204)
        self.assertEqual(len(self.request(self.other, "GET", path)["comments"]), 1)

    def test_activity_survives_task_deletion(self):
        task = self.task()
        path = self.base + "/tasks/" + task["id"]
        self.request(self.owner, "PATCH", path, {"status": "done"})
        comment = self.request(self.owner, "POST", path + "/comments", {"body": "Activity"}, 201)["comment"]
        self.request(self.owner, "DELETE", path + "/comments/" + comment["id"], status=204)
        self.request(self.owner, "DELETE", path, status=204)
        events = self.request(self.owner, "GET", self.base + "/activity")["events"]
        self.assertGreaterEqual(len(events), 5)
        for event in events:
            self.assertTrue(event["id"])
            self.assertTrue(event["action"])
            self.assertTrue(event["createdAt"])
            self.assertEqual(event["actorId"], self.owner_user["id"])

    def test_project_deletion_removes_access(self):
        self.join()
        task = self.task()
        self.request(self.owner, "POST", self.base + "/tasks/" + task["id"] + "/comments", {"body": "Nested"}, 201)
        self.request(self.owner, "DELETE", self.base, status=204)
        self.assertFalse(any(p["id"] == self.project["id"] for p in self.request(self.other, "GET", "/api/projects")["projects"]))
        self.request(self.other, "GET", self.base + "/tasks/" + task["id"], status=(403, 404))

    def test_spa_and_unknown_api(self):
        code, body, headers = self.owner.request("GET", "/")
        self.assertEqual(code, 200)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertIn("<", body)
        self.request(self.owner, "GET", "/api/does-not-exist", status=404)

    def test_z_persistence_across_restart(self):
        task = self.task(title="Persistent task")
        SERVER.stop()
        SERVER.start()
        self.assertEqual(self.request(self.owner, "GET", self.base + "/tasks/" + task["id"])["task"]["title"], "Persistent task")


if __name__ == "__main__":
    SERVER = Server()
    try:
        SERVER.start()
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Acceptance))
        print(json.dumps({"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "passed": result.testsRun - len(result.failures) - len(result.errors)}))
        raise SystemExit(0 if result.wasSuccessful() else 1)
    finally:
        SERVER.close()
