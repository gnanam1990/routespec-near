# @routespec/control-api

Owner module: M08. Status: **VERIFIED_BOUNDED** (see `docs/status/M08.md`).

Loopback-only authenticated local control API and project/revision/build matrix, plus the
same-origin console host. Decisions: `docs/adr/0013-local-control-api.md`.

```sh
node packages/control-api/src/main.ts --data .data --console apps/console/dist
```

- Binds only `127.0.0.1` or `::1`; Host, Origin, and Fetch-Metadata are checked on every request.
- `Authorization: Bearer <ephemeral control token>`; the console receives it in the URL fragment.
- Mutations require `Idempotency-Key`; updates require `If-Match`.
- Attester enrollment/revocation require a second local confirmation printed by the service.
- One-time case/recovery tokens and CI challenge nonces are returned once and never replayed.
