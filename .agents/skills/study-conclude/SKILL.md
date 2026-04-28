---
name: study-conclude
description: Turn study evidence into production decisions, code changes, and durable documentation. Use when applying benchmark study results to scanner policy or budgets.
---

# Study Conclude

Use this when the evidence is ready to become a production policy or budget.

## Workflow

1. **Restate the decision**
   - Name the exact production behavior being changed.
   - Quote the report path, run timestamp, corpus, and commit.

2. **Summarize evidence**
   - Include only metrics that support or challenge the decision.
   - Show tradeoffs: capability retained/lost, speed gained/lost, false-positive risk.
   - For budgets, show p50/p90/p95/max and recall retained.

3. **Make the smallest code change**
   - Replace magic constants with named policy values.
   - Add comments referencing the study doc, not the raw report alone.
   - Keep compatibility aliases if public options are renamed.

4. **Add regression checks**
   - Tests should verify policy shape, not freeze noisy timing numbers.
   - Add fixture-level checks when a specific asset class drove the decision.

5. **Update documentation**
   - Complete `apps/docs/studies/<study-id>.md` Conclusion with:
     - selected decision;
     - evidence backing;
     - rejected alternatives;
     - known limitations;
     - when to rerun the study.

6. **Validate and commit**
   - Run focused typecheck/test/lint.
   - Commit with a message explaining the evidence-backed decision.

## Output

Return:
- selected decision;
- evidence summary;
- files changed;
- validation commands;
- follow-up studies or risks.
