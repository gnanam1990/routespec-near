# RouteSpec decision-record template

Use one copied file per consequential architecture, protocol-fidelity, redaction, evidence, security, or delivery decision. Give the copy a sequential ADR identifier and descriptive filename.

## Record fields

- Identifier and title: record when the decision is opened
- Date and decision owner: record the actual values
- Status: PROPOSED, ACCEPTED, SUPERSEDED, or REJECTED
- Related requirement, invariant, module, and test IDs: list every affected ID explicitly

## Context and evidence

State the decision pressure, constraints, and missing evidence. For every source record its URL or pack path, evidence class, observation date, and the boundary of what it supports. Mark unavailable external evidence **UNVERIFIED**.

## Options and decision

For each viable option record protocol fidelity, determinism, privacy impact, failure modes, reversibility, and operational cost. Then record the selected option, why it won, rejected alternatives, migration or rollback path, and the evidence that would invalidate it.

An ADR is reasoning evidence. It is not implementation, test, deployment, provider, or market evidence.

