# Scalar Selection Policy

The scalar set catches QR contrast across:

```text
brightness
red channel
green channel
blue channel
perceptual lightness
red/green chroma
blue/yellow chroma
```

The goal is to create enough independent views that real finder patterns show up in at least one of them.

## View priority

The spec does not canonize a proposal-view order yet.

Re-rank scalar/threshold/polarity combinations after validating the new spec direction, especially:

```text
7 scalar views instead of 9
ok-a / ok-b direction handled by binary polarity
Rec. 601 grayscale over canonical SDR RGB
HDR/SDR and gamma/color-space normalization
histogram and threshold-stat reuse
```

Relevant open study issues:

```text
#28 Study grayscale and scalar transforms for QR foreground separation
#29 Study dynamic-range normalization for scalar QR views
#31 Study finder-quality contribution per scalar and threshold view
#35 Cache scalar histograms and integral stats for threshold reuse
#39 Explore tiny learned scalar transforms from corpus evidence
```

Until those results land, proposal-view ordering remains policy outside this stage contract.
