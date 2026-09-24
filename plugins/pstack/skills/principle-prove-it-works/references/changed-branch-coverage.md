# Changed branch coverage

Use coverage to find changed branch outcomes that lack proof. Coverage does not prove correctness. It does not replace a failing-before check, a real-path check, or the verification required by the changed feature.

After a code change, record one `CoverageReview` for the comparison from `base` to `head`.

```text
CoverageReview =
  measured {
    base,
    head,
    command,
    artifact,
    granularity,
    coveredChangedBranches,
    totalChangedBranches,
    configuredThreshold?,
    gaps[]
  }
  | unavailable {
    reason: no-tooling | unsupported-granularity | failed-run,
    attemptedCommand?,
    substituteVerification
  }

gap = {
  location,
  outcome,
  behavior-test { test, protectedOutcome, failingSignal }
  | exception {
      unreachable | generated | platform-specific | impractical,
      rationale,
      alternateEvidenceOrResidualRisk
    }
}
```

Use the repository's existing coverage command and artifact. Do not add a coverage dependency, parser, threshold, or reporting layer for this policy. If the current tool cannot compare changed branches at the required granularity, return `unavailable` with the command you attempted and the closest real verification.

Inspect every uncovered branch changed by the patch. Add a behavior test when the branch protects a meaningful outcome. State the outcome that the test protects and the signal that would fail before the behavior regresses. Do not add percentage-padding tests, implementation-mirroring assertions, or tests that only execute code without proving an outcome.

An exception must name the branch location, why a behavior test is not useful, and either alternate evidence or the residual risk. `unreachable`, generated code, platform-specific behavior, and an impractical test path are allowed exception classes. They are not blanket exemptions.

There is no universal percentage target. Honor an existing configured threshold when the repository has one, but never invent one. Use selective mutation testing only for high-risk logic where the coverage review still leaves doubt about whether the test assertions can detect a wrong result.

For a bug fix, preserve the failing-before proof and use the original reproduction or regression test as the real-path proof. For every change, report the review result and the remaining gaps in the pull request and final response.
