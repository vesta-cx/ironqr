# Study Cache Note

Runtime scanning owns binary views through production `ViewBank` memoization. Benchmark/study tooling may additionally write this stage to disk as:

```text
L3 binary views
```

Bump the study L3 cache version when:

- threshold formulas change,
- default threshold parameter constants change,
- polarity semantics change,
- binary bit encoding changes.
