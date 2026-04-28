# Study Cache Note

Runtime scanning owns finder seeds through the active scan pipeline and any production in-memory memoization. Benchmark/study tooling may additionally write this stage to disk as part of:

```text
L4 finder evidence
```

Later, if we add richer finder geometry refinement, study tooling may split this into:

```text
L4a finder seeds
L4b refined finder geometry
```

That separation lets reports reuse cheap seed detection while changing refinement math.
