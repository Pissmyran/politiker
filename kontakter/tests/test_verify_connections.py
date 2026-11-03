import io
import socket

import pytest

pytest.importorskip("dns.resolver")
import verify_emails as v


def answer(address):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, 25))


class FakeSocket:
    def __init__(self, family, socktype, replies, attempts, failures):
        self.family = family
        self.replies = io.BytesIO(replies)
        self.attempts = attempts
        self.failures = failures
        self.closed = False

    def settimeout(self, timeout):
        assert timeout == v.SMTP_TIMEOUT

    def connect(self, sockaddr):
        self.attempts.append(sockaddr)
        if sockaddr[0] in self.failures:
            raise OSError("connection failed")

    def makefile(self, mode):
        return self.replies

    def sendall(self, data):
        pass

    def close(self):
        self.closed = True


@pytest.fixture
def network(monkeypatch):
    attempts, sockets, lookups = [], [], []
    answers = {}
    replies = []
    failures = set()

    def resolve(host, port, **kwargs):
        lookups.append(host)
        assert port == 25
        assert kwargs == {"type": socket.SOCK_STREAM}
        value = answers[host]
        return value.pop(0) if isinstance(value, list) else value

    def open_socket(family, socktype):
        sock = FakeSocket(family, socktype, replies.pop(0), attempts, failures)
        sockets.append(sock)
        return sock

    monkeypatch.setattr(v.socket, "getaddrinfo", resolve)
    monkeypatch.setattr(v.socket, "socket", open_socket)
    monkeypatch.setattr(v.socket, "getfqdn", lambda: "local.example")
    return answers, replies, failures, attempts, sockets, lookups


def test_non_public_and_special_addresses_are_never_connected(network):
    answers, _, _, attempts, _, _ = network
    answers["mx.example"] = tuple(map(answer, [
        "127.0.0.1", "10.0.0.1", "169.254.1.1", "100.64.0.1", "224.0.0.1",
        "::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1",
        "2002:0a00:0001::1", "64:ff9b::a00:1",
    ]))
    assert v._connect([(10, "mx.example")]) is None
    assert attempts == []


def test_uses_validated_ip_and_falls_back_to_next_mx(network):
    answers, replies, failures, attempts, sockets, lookups = network
    answers["first.example"] = (answer("10.0.0.1"), answer("11.1.2.3"))
    answers["second.example"] = (answer("::1"), answer("2600:1234::1"))
    failures.add("11.1.2.3")
    replies.extend([b"", b"220 ready\r\n250 hello\r\n"])
    smtp = v._connect([(10, "first.example"), (20, "second.example")])
    assert smtp is not None
    assert attempts == [("11.1.2.3", 25), ("2600:1234::1", 25)]
    assert lookups == ["first.example", "second.example"]
    assert sockets[0].closed
    smtp.close()
    assert sockets[1].closed


def test_reconnect_resolves_again_and_rejects_rebound_private_address(network, monkeypatch):
    answers, replies, _, attempts, sockets, lookups = network
    answers["mx.example"] = [(answer("11.1.2.3"),), (answer("127.0.0.1"),)]
    # The first server closes after the catch-all check and before the real probe.
    replies.append(b"220 ready\r\n250 hello\r\n250 sender\r\n550 no\r\n250 reset\r\n")
    monkeypatch.setattr(v, "resolve_mx", lambda domain: [(10, "mx.example")])
    assert v.probe_domain("example.test", ["person@example.test"]) == {
        "person@example.test": "unreachable_connect_failed"
    }
    assert attempts == [("11.1.2.3", 25)]
    assert lookups == ["mx.example", "mx.example"]
    assert sockets[0].closed


def test_probe_preserves_catchall_and_temporary_results(network, monkeypatch):
    answers, replies, _, attempts, sockets, lookups = network
    answers["mx.example"] = (answer("11.1.2.3"),)
    replies.append(
        b"220 ready\r\n250 hello\r\n"
        b"250 sender\r\n250 recipient\r\n250 reset\r\n"
        b"250 sender\r\n450 temporary\r\n250 reset\r\n"
        b"250 sender\r\n250 recipient\r\n250 reset\r\n221 bye\r\n"
    )
    monkeypatch.setattr(v, "resolve_mx", lambda domain: [(10, "mx.example")])
    assert v.probe_domain("example.test", ["one@example.test", "two@example.test"]) == {
        "one@example.test": "temporary",
        "two@example.test": "catchall_unverified",
    }
    assert attempts == [("11.1.2.3", 25)]
    assert lookups == ["mx.example"]
    assert sockets[0].closed


def test_no_mx_stays_unreachable(monkeypatch):
    monkeypatch.setattr(v, "resolve_mx", lambda domain: [])
    assert v.probe_domain("example.test", ["person@example.test"]) == {
        "person@example.test": "unreachable_no_mx"
    }
