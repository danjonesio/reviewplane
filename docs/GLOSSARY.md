# Glossary

## Agent

A software agent that can reason, edit code and invoke tools. Examples include CLI coding agents. The term does not imply a particular vendor.

## Agent session

A bounded execution or conversation instance belonging to an agent. It may be associated with a connector, project, branch and browser session.

## Annotation

Structured visual markup applied over an artefact or live browser frame. Examples include rectangle, ellipse, arrow and numbered marker. It is stored separately from the original image.

## Artefact

A large or binary item such as screenshot, trace, HAR file, video, export or downloaded file.

## Browser context

An isolated Playwright browser context with separate cookies, storage and pages. The implementation may host multiple contexts inside one worker, subject to policy.

## Browser session

The control-plane record representing one allocated browser execution environment, its lifecycle, control lease, pages, evidence and associated project or agent session.

## Browser worker

A service that runs Chromium, performs Playwright or CDP operations, streams live frames and captures evidence.

## Connector

A lightweight process installed on a development environment. It registers the environment, publishes selected local services through outbound tunnels, reports project and Git context, and associates agent sessions.

## Control epoch

A monotonically increasing integer attached to browser-control commands. Changing controller increments the epoch. Commands with an older epoch are rejected.

## Control lease

A time-bounded grant allowing one controller to send interactive browser input.

## Control plane

The authoritative application containing the UI, APIs, authentication, project configuration, reviews, policies, events and orchestration logic.

## Development environment

A VM, workstation, container host or remote workspace containing source code, development tools and one or more local development services.

## Evidence

Data used to substantiate an observation, action or resolution. Evidence can include screenshots, DOM snapshots, console messages, network requests, traces, commits and test results.

## Finding

One discrete issue, request or observation within a review. A finding has status, severity, annotation, evidence, comments and verification history.

## Human takeover

An explicit transition that pauses agent input and grants the human the browser-control lease.

## Inbox item

A durable notification or assignment addressed to a project, user or agent session. Agents retrieve inbox items through MCP.

## MCP

Model Context Protocol. It is used as the initial agent-facing interface for tools, resources and review context.

## Project

The control-plane boundary that groups repository identity, development environments, policies, reviews, browser sessions and agent sessions.

## Published service

A local TCP or HTTP service made temporarily reachable to authorised browser workers through the connector and tunnel gateway.

## Review

A durable named package of findings, comments, evidence, source-control context, assignments and acceptance history.

## Review slug

A human-friendly project-scoped identifier such as `bugs-on-homepage`. Slugs may change; immutable IDs do not.

## Session room

The human UI for one live or historical session, including browser view, activity, findings, evidence and control actions.

## Tunnel gateway

The control-plane service that terminates connector tunnels and routes authorised browser-worker requests to published development services.

## Verification

Evidence and explanation submitted to show that a finding has been resolved. Verification does not equal human acceptance.

## Workspace

The repository working directory within a development environment. Avoid using `workspace` as a synonym for project.
