# XMCL agent control MCP

This is a machine interface for a closed agent. After one local pairing, granted tools run immediately. They do not open a confirmation dialog, a terminal, or an in-game command channel.

## Endpoint

The launcher listens on loopback and writes the URL to `<appData>/agent-control/endpoint`. The default file is `http://127.0.0.1:<port>/mcp`.

`XMCL_AGENT_CONTROL_PORT` chooses the port. `0` lets the operating system pick one. `XMCL_AGENT_CONTROL_HOST` defaults to `127.0.0.1`. Do not publish that socket. A remote client that cannot reach this machine's loopback needs a tunnel or other forwarder that the client's product actually allows. This repository does not assume a particular remote app can open localhost or speak MCP.

Streamable HTTP:

1. `POST /mcp` with `Accept: application/json, text/event-stream` and `Content-Type: application/json`.
2. `initialize` returns `Mcp-Session-Id`. Send that header on later requests.
3. `GET /mcp` returns 405. This server does not push. Poll `task_status`.
4. `DELETE /mcp` ends the MCP session. It does not revoke the pairing token.

`XMCL_AGENT_CONTROL_STDIO=1` also accepts LSP-style `Content-Length` frames on stdin. Use that only when the client can spawn a process on this computer.

## Pairing

On first launch a single-use code is written to `<appData>/agent-control/pairing-code` with mode `0600`. The human, not the agent, reads it and exchanges it once:

```http
POST /pair
content-type: application/json

{"code":"<pairing code>"}
```

The response contains a bearer token and the grant. Store the token in the MCP client configuration as `Authorization: Bearer <token>`. The launcher stores only a hash in `session.json`. Restart keeps that grant. `session_revoke` deletes it.

The grant includes instances that exist at pairing time, permission to create new instances, and the writable roots `config/**`, `kubejs/**`, `defaultconfigs/**`, and `scripts/**`.

## Tools

`capabilities`, `instances_list`, `instances_create`, `vfs_list`, `vfs_read`, `vfs_grep`, `vfs_write`, `vfs_rollback`, `install_stage`, `install_status`, `install_apply`, `import_modpack`, `runtime_install`, `launch`, `processes_list`, `process_stop`, `logs_read`, `task_status`, `task_cancel`, `session_revoke`.

`install_apply`, `import_modpack`, `runtime_install`, and `launch` return a `taskId`. Call `task_status` until the state is no longer `running`. `task_cancel` aborts that task's `AbortController`.

`vfs_write` requires `expectedHash` from `vfs_read` for an existing file, or `null` to create one. Use `kind: "replacements"` for exact literal edits or `kind: "content"` for a full rewrite. A mismatch returns `conflict` with `currentHash` and a short snippet. `changeId` is the rollback handle.

JSON is parsed. TOML is parsed with `smol-toml`. KubeJS files are text with a 512 KiB limit. Whether a script runs is visible only in a later bounded `logs_read`, after `launch`.

Mods, resource packs, and shader packs are staged with `install_stage` and copied by `install_apply`. They are not text-edited.

## Security

- The command table is an allowlist. `getOfficialUserProfile`, token getters, and OS shell names are denied even if a service method exists.
- Tool results do not include account access tokens. Launch uses the existing `instance.launch` command, which resolves the account inside the launcher.
- Virtual paths are instance-scoped. `.` and `..` are rejected. Every path component is `lstat`'d and symlinks are not followed.
- `libraries`, `versions`, `assets`, and `jre` cannot be written. A hardlinked file (`nlink > 1`) is unlinked at this instance and replaced with a new inode, so a shared cache or another instance keeps the old bytes.
- Writes go to a temporary file, are validated, then renamed into place. The resolved path must stay inside the instance directory.
- This interface cannot chat, run commands, or change a player inside a running world.
