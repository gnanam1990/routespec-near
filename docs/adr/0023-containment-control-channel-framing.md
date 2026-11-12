# ADR-0023 — Containment control channel: only the shim writes frames, and every frame is bounded

- Status: accepted
- Date: 2026-11-12
- Module: security follow-up (external security audit, RS-02; amends ADR-0019 decision on the
  shim channel; T-010, RP-06)

## Context

ADR-0019 makes the shim's stdin/stdout the only channel between a contained subject and the
host: JSON lines carrying tunnel bytes, IPC messages, `ready`, and the subject's `exit`. The shim
forked the subject with `stdio: ['ignore', 'inherit', 'inherit', 'ipc']`, so the subject's stdout
was the shim's stdout, which is the channel. The comment next to the fork said the opposite
(subject stdout goes to stderr).

The host read the channel with `readline` and no line limit, inside the shared control-service
process. The shim enforced its 1 MiB line limit only on host -> shim lines. A contained subject
could therefore:

- print a frame itself, for example `{t:'exit',code:0,signal:null}`, which set the host's
  `subjectExit` and notified listeners while the subject was still running;
- leave an unterminated partial line on the channel, which merged with the next real shim frame
  so that frame failed to parse and was lost (IPC messages and the real `exit` frame);
- write newline-free output without limit, which the control service kept in memory. The
  container's memory limit does not cap this, because the data leaves the container as a stream.

## Decision

1. **Only the shim writes to the channel.** The subject is forked with
   `stdio: ['ignore', 2, 2, 'ipc']`: its stdout and stderr both go to the shim's stderr, which the
   host already keeps only as an 8000-character tail.
2. **The shim bounds what it relays.** An IPC message from the subject whose `{t:'ipc', m}` frame
   is larger than `MAX_LINE` (1 MiB, UTF-8 bytes) is not relayed; the shim kills the subject with
   `SIGKILL`, and the host sees the normal `exit` frame. Tunnel `data` frames are one socket read
   each (base64), well under the bound.
3. **The host bounds every frame.** `ContainedSubject` replaces `readline` with a byte splitter.
   A frame, or the pending unterminated partial line, larger than `MAX_FRAME_BYTES` (2 MiB) is a
   channel fault: the host drops the buffer, sets `channelFault` to
   `CONTROL_CHANNEL_FRAME_TOO_LARGE`, downgrades the verdict to `DECLARED_HOOKS_ONLY` with that
   finding, rejects a pending launch, and stops the container. The host never holds more than
   the bound for one frame. The bound is twice the shim's, so a well-behaved shim never trips it.

## Consequences and limits (recorded)

- Protocol: both ends still speak one JSON object per line; nothing on the wire changes for a
  well-behaved subject. A subject that printed to stdout now prints to the container's stderr.
- A subject message over 1 MiB ends the subject. No RouteSpec subject message is near this
  size (job answers, credentials acknowledgements, and attestation completions are small).
- A channel fault makes the case's containment `DECLARED_HOOKS_ONLY`, so it cannot support a
  `PROCESS_TREE_ENFORCED` PASS; it is reported through the existing containment record findings.
- The subject can still send any IPC message it likes through `process.send`; those arrive as
  `ipc` frames and are data, as before. It can no longer author other frame types.
