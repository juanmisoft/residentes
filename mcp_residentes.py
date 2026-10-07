# -*- coding: utf-8 -*-
"""Servidor MCP del padrón de Rivas. Habla por la entrada estándar."""
import json
import sys

import consultas

PROTOCOL = "2024-11-05"


def _tools():
    tools = []
    for spec in consultas.SPECS:
        properties = {}
        for key, description in spec["properties"].items():
            properties[key] = {"type": "string", "description": description}
        tools.append({
            "name": spec["name"],
            "description": spec["description"],
            "inputSchema": {"type": "object", "properties": properties},
        })
    return tools


def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        key, value = line.decode("ascii").split(":", 1)
        headers[key.strip().lower()] = value.strip()
    length = int(headers.get("content-length", "0"))
    if length <= 0:
        return None
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def write_message(payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def tool_text(name, arguments):
    result = consultas.dispatch(name, arguments or {})
    payload = {
        "content": [{
            "type": "text",
            "text": json.dumps(result, ensure_ascii=False),
        }]
    }
    edificio = result.get("edificio")
    if not edificio and len(result.get("resultados") or []) == 1:
        edificio = result["resultados"][0]
    if edificio and edificio.get("rc"):
        payload["edificio"] = edificio
    return payload


def handle(message):
    if message.get("method") and "id" not in message:
        return None
    method = message.get("method")
    msg_id = message.get("id")
    if method == "initialize":
        result = {
            "protocolVersion": PROTOCOL,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "residentes-rivas", "version": "1.1.0"},
        }
    elif method == "tools/list":
        result = {"tools": _tools()}
    elif method == "tools/call":
        params = message.get("params") or {}
        result = tool_text(params.get("name"), params.get("arguments"))
    elif method == "ping":
        result = {}
    else:
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {"code": -32601, "message": "Método no disponible: " + str(method)},
        }
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def main():
    while True:
        message = read_message()
        if message is None:
            break
        response = handle(message)
        if response is not None:
            write_message(response)


if __name__ == "__main__":
    main()
