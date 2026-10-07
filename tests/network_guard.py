"""Deny test network access while allowing asyncio's internal Windows socketpair."""
import os
import socket
import threading

_connect = socket.socket.connect
_socketpair = socket.socketpair
_internal = threading.local()


def deny_network(*args, **kwargs):
    raise AssertionError('Network access forbidden in offline tests')


def _pair_connect(sock, address):
    if getattr(_internal, 'socketpair', False) and address[0] in ('127.0.0.1', '::1'):
        return _connect(sock, address)
    return deny_network()


def _internal_socketpair(*args, **kwargs):
    # Windows emulates socketpair using a temporary loopback listener. Restore
    # any test mock afterwards; other threads still cannot open connections.
    previous = socket.socket.connect
    socket.socket.connect = _pair_connect
    _internal.socketpair = True
    try:
        return _socketpair(*args, **kwargs)
    finally:
        _internal.socketpair = False
        socket.socket.connect = previous


def install_network_guard():
    if os.name == 'nt':
        socket.socketpair = _internal_socketpair
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network
