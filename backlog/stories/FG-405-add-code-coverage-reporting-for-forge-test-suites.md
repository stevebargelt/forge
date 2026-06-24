---
id: FG-405
type: story
status: active
title: Add code coverage reporting for Forge test suites
created: 2026-06-24
---

## Problem

Forge has a large and growing test suite, but today we mostly reason about overlap and coverage by manual inspection, test counts, and runtime. That makes it harder to distinguish useful regression coverage from redundant assertions, especially as Campaign Runner and Shipping Reviewer work adds more control-plane tests.

## Goal

Add code coverage reporting for Forge so humans and agents can see which modules, branches, and lines are exercised by the root and dashboard test suites.

## Acceptance Criteria

- A documented command generates coverage for the root TypeScript test suite.
- Dashboard/workspace tests are either included in an aggregate coverage command or explicitly reported separately.
- Coverage output includes a human-readable summary and an artifact suitable for local inspection, such as HTML or lcov.
- Coverage reports do not require external services.
- The implementation distinguishes coverage reporting from pass/fail gating unless an explicit threshold is intentionally added.
- Documentation explains how to use coverage to guide test cleanup without treating coverage percentage as proof of test quality.

## Notes

This should support the test-suite cleanup discussion: identify untested areas, overlapping test clusters, and places where long-running integration coverage can be separated from fast unit coverage.