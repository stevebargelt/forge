// Mechanical done-audit for campaign items (FG-383).
//
// Pure evaluator — no IO. All facts arrive via DoneAuditInput.
// container_verification is INFORMATIONAL: present in checks but excluded from
// outcome aggregation; it must NEVER satisfy host_verification.

export type DoneAuditOutcome = "pass" | "fail" | "unknown";
export type DoneAuditCheckStatus = "pass" | "fail" | "unknown";
export type DoneAuditCheck = { name: string; status: DoneAuditCheckStatus; detail?: string };
export type DoneAuditResult = {
  outcome: DoneAuditOutcome;
  checks: DoneAuditCheck[];
  gaps: string[];
  requestedAction: string | null;
};
export type DoneAuditInput = {
  ticket: { status: string; closedCommit?: string; body: string; related?: string[] } | null;
  item: { lifecycleStatus: string; outcome?: string };
  git: {
    dirty: boolean | null;
    commitExists: boolean | null;
    pushed: boolean | null;
    // Derived, non-persisted reason for pushed=null. "no_remote" = no remote configured;
    // absence = git error or no closedCommit. Drives operator-facing text only.
    pushedReason?: string | null;
  };
  verification: {
    hostVerified: boolean | null;
    hostVerificationDetail?: string | null;
    containerTestsRun: number | null;
    acceptedException?: string | null;
  };
};

function extractDeferralSection(body: string): { found: boolean; sectionText: string } {
  // Look for a markdown heading "Deferred" or "Deferred scope"
  const lines = body.split("\n");
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      const title = heading[1]!.trim().toLowerCase();
      if (title === "deferred" || title === "deferred scope") {
        inSection = true;
        continue;
      } else if (inSection) {
        break; // next heading ends the section
      }
    } else if (inSection) {
      sectionLines.push(line);
    }
  }

  if (inSection) {
    return { found: true, sectionText: sectionLines.join("\n").trim() };
  }

  // Look for a "deferred:" inline marker
  const markerMatch = body.match(/^deferred:\s*(.*)$/im);
  if (markerMatch) {
    return { found: true, sectionText: (markerMatch[1] ?? "").trim() };
  }

  return { found: false, sectionText: "" };
}

function hasDeferralLink(sectionText: string): boolean {
  return /FG-\d+/i.test(sectionText);
}

function buildRequestedAction(
  nonPassChecks: DoneAuditCheck[],
  closedCommit: string | undefined,
  pushedReason?: string | null,
): string {
  const actions: string[] = [];
  for (const check of nonPassChecks) {
    switch (check.name) {
      case "ticket_closed":
        actions.push("mark the ticket as done");
        break;
      case "closed_commit_present":
        actions.push("record the closed commit on the ticket");
        break;
      case "commit_exists":
        actions.push("verify the closed commit exists in the repository");
        break;
      case "clean_git":
        actions.push("commit or revert the working tree");
        break;
      case "pushed":
        if (pushedReason === "no_remote") {
          actions.push("no remote configured; push/PR unavailable");
        } else {
          actions.push(closedCommit ? `push ${closedCommit}` : "push the commit");
        }
        break;
      case "host_verification":
        actions.push("run host typecheck + full suite, record the result, then re-audit");
        break;
      case "deferral_linked":
        actions.push("file a follow-up ticket and link it");
        break;
    }
  }
  return actions.join("; ");
}

export function evaluateDoneAudit(input: DoneAuditInput): DoneAuditResult {
  const checks: DoneAuditCheck[] = [];
  const gaps: string[] = [];

  // ticket_closed
  if (input.ticket === null) {
    checks.push({ name: "ticket_closed", status: "unknown" });
    gaps.push("ticket could not be read");
  } else if (input.ticket.status === "done") {
    checks.push({ name: "ticket_closed", status: "pass" });
  } else {
    checks.push({ name: "ticket_closed", status: "fail" });
    gaps.push(`ticket status is "${input.ticket.status}", not done`);
  }

  // closed_commit_present
  if (input.ticket === null) {
    checks.push({ name: "closed_commit_present", status: "unknown" });
  } else if (input.ticket.closedCommit) {
    checks.push({ name: "closed_commit_present", status: "pass" });
  } else {
    checks.push({ name: "closed_commit_present", status: "fail" });
    gaps.push("no closed commit recorded on ticket");
  }

  // commit_exists
  if (input.git.commitExists === true) {
    checks.push({ name: "commit_exists", status: "pass" });
  } else if (input.git.commitExists === false) {
    checks.push({ name: "commit_exists", status: "fail" });
    gaps.push("closed commit does not exist in repository");
  } else {
    checks.push({ name: "commit_exists", status: "unknown" });
  }

  // clean_git
  if (input.git.dirty === false) {
    checks.push({ name: "clean_git", status: "pass" });
  } else if (input.git.dirty === true) {
    checks.push({ name: "clean_git", status: "fail" });
    gaps.push("working tree is dirty — uncommitted changes present");
  } else {
    checks.push({ name: "clean_git", status: "unknown" });
  }

  // pushed
  const closedCommit = input.ticket?.closedCommit;
  if (input.git.pushed === true) {
    checks.push({ name: "pushed", status: "pass" });
  } else if (input.git.pushed === false) {
    checks.push({ name: "pushed", status: "fail" });
    gaps.push(closedCommit ? `${closedCommit} not pushed` : "commit not pushed to remote");
  } else if (input.git.pushedReason === "no_remote") {
    checks.push({ name: "pushed", status: "unknown", detail: "no remote configured; push/PR unavailable" });
  } else {
    checks.push({ name: "pushed", status: "unknown" });
  }

  // container_verification (INFORMATIONAL — excluded from outcome aggregation)
  if (input.verification.containerTestsRun != null && input.verification.containerTestsRun > 0) {
    checks.push({ name: "container_verification", status: "pass", detail: `${input.verification.containerTestsRun} tests run in container` });
  } else if (input.verification.containerTestsRun === 0) {
    checks.push({ name: "container_verification", status: "fail", detail: "0 container tests recorded" });
  } else {
    checks.push({ name: "container_verification", status: "unknown", detail: "container test count not recorded" });
  }

  // host_verification
  if (input.verification.acceptedException) {
    checks.push({
      name: "host_verification",
      status: "pass",
      detail: `waiver: ${input.verification.acceptedException}`,
    });
  } else if (input.verification.hostVerified === true) {
    checks.push({
      name: "host_verification",
      status: "pass",
      detail: input.verification.hostVerificationDetail ?? undefined,
    });
  } else if (input.verification.hostVerified === false) {
    checks.push({
      name: "host_verification",
      status: "fail",
      detail: input.verification.hostVerificationDetail ?? undefined,
    });
    gaps.push("host verification failed");
  } else {
    checks.push({ name: "host_verification", status: "unknown" });
    gaps.push("host verification not recorded — confirm host typecheck + suite");
  }

  // deferral_linked
  const ticketBody = input.ticket?.body ?? "";
  const { found: hasDeferral, sectionText } = extractDeferralSection(ticketBody);
  if (hasDeferral) {
    if (hasDeferralLink(sectionText)) {
      checks.push({ name: "deferral_linked", status: "pass" });
    } else {
      checks.push({ name: "deferral_linked", status: "fail" });
      gaps.push("deferred scope declared without a linked follow-up ticket");
    }
  } else {
    checks.push({ name: "deferral_linked", status: "pass", detail: "n/a — no deferral declared" });
  }

  // Aggregate outcome from required checks (all except container_verification)
  const requiredChecks = checks.filter((c) => c.name !== "container_verification");
  let outcome: DoneAuditOutcome;
  if (requiredChecks.every((c) => c.status === "pass")) {
    outcome = "pass";
  } else if (requiredChecks.some((c) => c.status === "fail")) {
    outcome = "fail";
  } else {
    outcome = "unknown";
  }

  const nonPassRequired = requiredChecks.filter((c) => c.status !== "pass");
  const requestedAction = outcome === "pass" ? null : buildRequestedAction(nonPassRequired, closedCommit, input.git.pushedReason);

  return { outcome, checks, gaps, requestedAction };
}
