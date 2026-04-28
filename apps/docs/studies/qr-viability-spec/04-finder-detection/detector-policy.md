# Detector Policy

Canonical production-like detector families:

```text
row-scan
matcher
```

`flood` exists as historical context and is outside the default detector policy.

Finder detection remains a candidate generator. It supplies cheap local finder seeds for later geometry refinement.

It provides:

```text
where finder geometry refinement should look
what rough scale refinement should try
which detector/view produced this seed
```

Later stages own full QR realism: finder geometry refinement, triple construction, version/grid fitting, homography fitting, semantic QR checks, and decode confirmation.
