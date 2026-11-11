# @routespec/live-dry-adapter

Owner module: M07. Status: **NOT_STARTED** (adapter behavior).

M00 pins the official SDK `@defuse-protocol/one-click-sdk-typescript@0.1.26` here so that no networkless package depends on an upstream client. `test/sdk-pin.test.ts` verifies the installed version and that `OpenAPI.BASE` targets a local loopback server; it never contacts the provider.
