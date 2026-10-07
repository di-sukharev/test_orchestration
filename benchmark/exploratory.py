#!/usr/bin/env python3
"""Post-delivery probes derived from review findings, run unchanged on both arms.

These are exploratory, not the pre-registered 25 acceptance cases. A delayed
request sends one body byte, allows a concurrent operation, then sends the rest.
No application internals, schema details, or implementation-specific imports.
"""
import argparse
import http.client
import json
import socket
import sys
import time
import unittest
import urllib.parse
from pathlib import Path


class DelayedRequest:
    def __init__(self, client, method, path, body):
        self.body = json.dumps(body).encode()
        self.socket = socket.create_connection(("127.0.0.1", A.SERVER.port), timeout=10)
        cookie = "; ".join(f"{c.name}={c.value}" for c in client.cookies)
        headers = (f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{A.SERVER.port}\r\n"
                   f"Origin: {A.SERVER.origin}\r\nCookie: {cookie}\r\n"
                   f"Content-Type: application/json\r\nContent-Length: {len(self.body)}\r\n"
                   "Connection: close\r\n\r\n")
        self.socket.sendall(headers.encode() + self.body[:1])
        time.sleep(.2)

    def finish(self):
        self.socket.sendall(self.body[1:])
        response = http.client.HTTPResponse(self.socket)
        response.begin()
        payload = response.read()
        self.socket.close()
        return response.status, json.loads(payload) if payload else None

    def close(self):
        self.socket.close()


class Probes(unittest.TestCase):
    def test_case_insensitive_non_ascii_search(self):
        self.task(title="Кириллица в названии")
        self.task(title="Unrelated")
        response = self.request(self.owner, "GET", self.base + "/tasks?q=" + urllib.parse.quote("КИРИЛЛИЦА"))
        self.assertEqual(response["total"], 1)

    def test_unknown_api_anonymous_is_json_404(self):
        self.request(A.Client(), "GET", "/api/route-that-does-not-exist", status=404)

    def test_nul_input_never_returns_500_or_truncates(self):
        value = "\x00suffix"
        task = self.task()
        cases = [
            ("/api/projects", {"name": value}, "project", "name"),
            (self.base + "/tasks", {"title": value}, "task", "title"),
            (self.base + "/tasks/" + task["id"] + "/comments", {"body": value}, "comment", "body"),
        ]
        for path, body, resource, field in cases:
            with self.subTest(resource=resource):
                result = self.request(self.owner, "POST", path, body, (400, 201))
                # The frozen contract did not explicitly ban NUL. Accept safe
                # rejection or lossless storage, but never 500 or truncation.
                if resource in result:
                    self.assertEqual(result[resource][field], value)

    def test_disjoint_patches_do_not_lose_concurrent_changes(self):
        task = self.task(title="Original", description="Original description")
        path = self.base + "/tasks/" + task["id"]
        for index in range(3):
            pending = DelayedRequest(self.owner, "PATCH", path, {"title": f"Title {index}"})
            try:
                self.request(self.owner, "PATCH", path, {"description": f"Concurrent description {index}"})
                code, body = pending.finish()
                self.assertEqual(code, 200, str(body))
                result = self.request(self.owner, "GET", path)["task"]
                self.assertEqual(result["title"], f"Title {index}")
                self.assertEqual(result["description"], f"Concurrent description {index}")
            finally:
                pending.close()

    def test_pending_write_rechecks_downgraded_role(self):
        self.join("editor")
        member_path = self.base + "/members/" + self.other_user["id"]
        for index in range(3):
            if index:
                self.request(self.owner, "PATCH", member_path, {"role": "editor"})
            pending = DelayedRequest(self.other, "POST", self.base + "/tasks", {"title": f"Pending write {index}"})
            try:
                self.request(self.owner, "PATCH", member_path, {"role": "viewer"})
                code, body = pending.finish()
                self.assertIn(code, (403, 404), f"Write completed after role downgrade: {code} {body}")
            finally:
                pending.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.repository.resolve() / "benchmark"))
    import acceptance as A
    for name in ("request", "user", "setUp", "join", "task"):
        setattr(Probes, name, getattr(A.Acceptance, name))
    A.SERVER = A.Server()
    try:
        A.SERVER.start()
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Probes))
        failed_cases = {getattr(case, "test_case", case).id() for case, _ in result.failures + result.errors}
        print(json.dumps({"exploratory": True, "tests": result.testsRun, "failed_test_cases": len(failed_cases), "assertion_failure_events": len(result.failures), "error_events": len(result.errors), "passed": result.testsRun - len(failed_cases)}))
        raise SystemExit(0 if result.wasSuccessful() else 1)
    finally:
        A.SERVER.close()
