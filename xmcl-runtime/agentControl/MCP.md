# XMCL agent control MCP

This is a machine interface for a closed agent. After one local pairing, granted tools run immediately. They do not open a confirmation dialog, a terminal, or an in-game command channel.

## Endpoint

The launcher listens on loopback and writes the URL to `<appData>/agent-control/endpoint`. The default file is `http://127.0.0.1:<port>/mcp`.

The endpoint starts after the game data path exists. On a first launch that path is chosen by the bootstrap window. A headless start must already contain `<appData>/root`, one line, the absolute game data directory. Until that file exists, agent control waits and does not write a pairing code.

Isolated boot, after `pnpm --prefix=xmcl-electron-app compile`:

```bash
ROOT=/tmp/xmcl-mcp-isolated
mkdir -p "$ROOT/game" "$ROOT/xmcl"
printf '%s' "$ROOT/game" > "$ROOT/xmcl/root"
XMCL_E2E=1 XMCL_E2E_APP_DATA="$ROOT" XMCL_AGENT_CONTROL_PORT=32123 \
  xvfb-run -a "$(pnpm --prefix=xmcl-electron-app exec node -p "require('electron')")" \
  --no-sandbox --disable-gpu xmcl-electron-app/dist/index.js
```

Run that from the repository root. `XMCL_E2E_APP_DATA` is the launcher app-data parent. The `root` file lives in `$XMCL_E2E_APP_DATA/xmcl/root`. The pairing code is `$XMCL_E2E_APP_DATA/xmcl/agent-control/pairing-code`. This does not select an account or accept a Minecraft EULA. `launch` returns `User selection required` until a real account exists.

`XMCL_AGENT_CONTROL_PORT` chooses the port. `0` lets the operating system pick one. `XMCL_AGENT_CONTROL_HOST` defaults to `127.0.0.1`. Do not publish that socket. A remote client that cannot reach this machine's loopback needs a tunnel or other forwarder that the client's product actually allows. This repository does not assume a particular remote app can open localhost or speak MCP.

Streamable HTTP:

1. `POST /mcp` with `Accept: application/json, text/event-stream` and `Content-Type: application/json`.
2. `initialize` returns `Mcp-Session-Id`. Send that header on later requests.
3. `GET /mcp` returns 405. This server does not push. Poll `task_status`.
4. `DELETE /mcp` ends the MCP session. It does not revoke the pairing token.

`XMCL_AGENT_CONTROL_STDIO=1` also speaks the SDK stdio transport, which is one JSON-RPC message per line. Use that only when the client can spawn a process on this computer.

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

`capabilities`, `instances_list`, `instances_create`, `vfs_list`, `vfs_read`, `vfs_grep`, `vfs_write`, `vfs_rollback`, `vfs_delete`, `install_stage`, `install_status`, `install_apply`, `import_modpack`, `runtime_install`, `launch`, `processes_list`, `process_stop`, `logs_read`, `task_status`, `task_cancel`, `session_revoke`.

`install_apply`, `import_modpack`, `runtime_install`, and `launch` return a `taskId`. Call `task_status` until `state` is no longer `running`. `task_cancel` sets `cancellation` to `requested` and aborts the task signal. The task stays `running` until the work settles. A `task_cancelled` rejection is `honored` and reports the worker's `effect`: `none`, `partial`, or `unknown`. A cancelled task can leave files behind. If the work still returns a result, `cancellation` is `unsupported` and `effect` is `applied`. `session_revoke` aborts the same signal, so an in-flight task stops with that same report and later calls with the old token are denied.

`vfs_write` requires `expectedHash` from `vfs_read` for an existing file, or `null` to create one. `vfs_delete` uses the same hash. Use `kind: "replacements"` for exact literal edits or `kind: "content"` for a full rewrite. A mismatch returns `conflict` with `currentHash` and a short snippet. `changeId` rolls back only while the file still has that write's hash, and only for the instance that owns the change. A second rollback of the same id conflicts. The transport is the official MCP SDK Streamable HTTP server.

JSON is parsed. TOML is parsed with `smol-toml`. KubeJS files are text with a 512 KiB limit. Whether a script runs is visible only in a later bounded `logs_read`, after `launch`.

Mods, resource packs, and shader packs are staged with `install_stage` and copied by `install_apply`. They are not text-edited.

## Security

- The command table is an allowlist. `getOfficialUserProfile`, token getters, and OS shell names are denied even if a service method exists.
- Tool results do not include account access tokens. Launch uses the existing `instance.launch` command, which resolves the account inside the launcher.
- Virtual paths are instance-scoped. `.` and `..` are rejected. Every path component is `lstat`'d and symlinks are not followed.
- `libraries`, `versions`, `assets`, and `jre` cannot be written, including through rollback. A hardlinked file (`nlink > 1`) is replaced by renaming a new file over that directory entry. The shared inode is not written in place, so a cache or another instance keeps the old bytes.
- Writes go to a temporary file, are validated, then renamed into place. The resolved path must stay inside the instance directory.
- This interface cannot chat, run commands, or change a player inside a running world.
