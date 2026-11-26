"""One HTTP exchange. The socket is shared only so the deadline can interrupt a slow reader."""

import http.client
import ipaddress
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from typing import Dict, Optional


class InvalidOrigin(Exception):
    """The peer cannot receive credentials for this address."""


@dataclass
class Response:
    status: int
    retry_after: Optional[str]
    body: bytes


def post(host: str, port: Optional[int], tls: Optional[ssl.SSLContext], path: str, headers: Dict[str, str], body: bytes, connect_timeout: float, deadline: float) -> Response:
    connect_end = min(deadline, time.monotonic() + connect_timeout)
    timeout = connect_end - time.monotonic()
    if timeout <= 0:
        raise TimeoutError()

    connection: http.client.HTTPConnection
    if tls is None:
        connection = http.client.HTTPConnection(host, port, timeout=timeout)
    else:
        connection = http.client.HTTPSConnection(host, port, context=tls, timeout=timeout)

    connected = threading.Event()
    finished = threading.Event()
    expired = threading.Event()
    sock = None
    answer = None
    invalid_origin = False

    def exchange() -> None:
        nonlocal sock, answer, invalid_origin
        try:
            connection.connect()
            sock = connection.sock
            if sock is None:
                return
            # Check the connected peer before sending a bearer token over plaintext, even for localhost.
            if tls is None and not ipaddress.ip_address(sock.getpeername()[0]).is_loopback:
                invalid_origin = True
                return
            if time.monotonic() >= connect_end or expired.is_set():
                return
            sock.settimeout(deadline - time.monotonic())
            connected.set()
            connection.request("POST", path, body=body, headers=headers)
            with connection.getresponse() as response:
                answer = Response(response.status, response.getheader("Retry-After"), response.read())
        except ssl.SSLCertVerificationError:
            invalid_origin = True
        except (OSError, http.client.HTTPException, ValueError, OverflowError):
            pass
        finally:
            connection.close()
            finished.set()
            connected.set()

    # A socket timeout alone covers neither DNS nor a response arriving one byte at a time.
    threading.Thread(target=exchange, daemon=True).start()
    if connected.wait(max(0, connect_end - time.monotonic())) and finished.wait(max(0, deadline - time.monotonic())):
        if invalid_origin:
            raise InvalidOrigin()
        if answer is not None:
            return answer
    expired.set()
    if sock is not None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    raise TimeoutError()
