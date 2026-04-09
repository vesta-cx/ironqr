# Research: Reed–Solomon Decoder for QR Code GF(256)

## Summary
QR codes use RS codes over GF(2^8) with primitive polynomial `0x11D` and generator base `b=0`. Two proven decoder paths exist: (1) Berlekamp–Massey + Chien search + Forney (Wikiversity / reedsolo), and (2) Extended Euclidean Algorithm (zxing-js TypeScript — Apache 2.0). ZXing is the canonical TypeScript reference; its `ReedSolomonDecoder.ts` is directly portable. Both paths share the same syndrome and Forney steps; only the error-locator computation differs.

---

## Canonical Sources

| Source | Algorithm | Language | License |
|--------|-----------|----------|---------|
| [zxing-js/library `ReedSolomonDecoder.ts`](https://github.com/zxing-js/library/blob/master/src/core/common/reedsolomon/ReedSolomonDecoder.ts) | Extended Euclidean | TypeScript | Apache 2.0 |
| [Wikiversity: Reed–Solomon codes for coders](https://en.wikiversity.org/wiki/Reed%E2%80%93Solomon_codes_for_coders) | BM + Chien + Forney | Python pseudocode | CC BY-SA |
| [tomerfiliba-org/reedsolomon (reedsolo)](https://github.com/tomerfiliba-org/reedsolomon) | BM + Chien + Forney | Python | Public domain |

---

## Findings

### 1. GF(256) Field Parameters for QR

```
Primitive polynomial : 0x11D  (x^8 + x^4 + x^3 + x^2 + 1)
Field size           : 256
Generator alpha      : 2 (α)
Generator base b     : 0   ← QR-specific; DataMatrix uses b=1
```

**Caveat**: `b=0` means syndromes are evaluated at α^0, α^1, … α^(2t-1), not α^1..α^(2t). ZXing's `GenericGF.QR_CODE_FIELD_256 = new GenericGF(0x011d, 256, 0)` encodes this.

### 2. Log/Exp Table Construction (GF arithmetic backbone)

```typescript
const exp = new Int32Array(256);
const log = new Int32Array(256);
let x = 1;
for (let i = 0; i < 255; i++) {
  exp[i] = x;
  log[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11D;  // reduce mod primitive poly
}
exp[255] = exp[0];  // wrap; use size-512 table to skip % in multiply

// mul(a,b) = a==0||b==0 ? 0 : exp[(log[a]+log[b]) % 255]
// div(a,b) = exp[(log[a]-log[b]+255) % 255]
// inv(a)   = exp[255 - log[a]]
// pow(x,n) = exp[(log[x]*n) % 255]
// add/sub  = a ^ b   (XOR, same in GF(2^8))
```

### 3. Syndrome Computation

Evaluate the received word `r(x)` (data + EC bytes as polynomial coefficients, high-degree first) at the `2t` generator roots:

```
S_i = r(α^(i+b))  for i = 0, 1, …, 2t-1
```

For QR (`b=0`): `S_i = r(α^i)`.

If all `S_i == 0` → no errors, return immediately.

**ZXing idiom** (stores syndromes in reverse, coefficient `[2t-1-i]`):
```typescript
for (let i = 0; i < twoS; i++) {
  syndromeCoefficients[syndromeCoefficients.length - 1 - i] =
    poly.evaluateAt(field.exp(i + field.getGeneratorBase()));
}
```
Polynomial evaluation via Horner's method: `r(v) = (…((r[0]*v + r[1])*v + r[2])*v …) + r[n]`.

### 4A. Error Locator Polynomial — Extended Euclidean (ZXing)

Run the extended Euclidean algorithm on `(x^(2t), S(x))` until `deg(r) < t`:

```
Input : a = x^(2t),  b = S(x)
Track : t_last = 0,  t = 1

Loop while deg(r) >= t:
  (q, r) = divmod(r_last, r)
  t      = q * t_last + t_last_last   (all in GF poly arithmetic)

Normalize so that σ(0) = 1:
  inv = inverse(t[0])
  σ = t * inv        // error locator
  ω = r * inv        // error evaluator
```

`σ` has degree = number of errors `e`. If `e > t`, decoding fails.

### 4B. Error Locator Polynomial — Berlekamp–Massey (BM, alternative)

```
err_loc = [1],  old_loc = [1]

for K in range(0, 2t):
  # Discrepancy (partial dot product — linear time)
  delta = S[K]
  for j in 1..len(err_loc)-1:
    delta ^= gf_mul(err_loc[-(j+1)], S[K-j])

  old_loc = old_loc + [0]   # shift

  if delta != 0:
    if len(old_loc) > len(err_loc):          # Rule B
      new_loc  = gf_poly_scale(old_loc, delta)
      old_loc  = gf_poly_scale(err_loc, inverse(delta))
      err_loc  = new_loc
    err_loc = gf_poly_add(err_loc, gf_poly_scale(old_loc, delta))

# drop leading zeros
if (len(err_loc) - 1) > t:  raise TooManyErrors
```

BM also produces `σ`. You then need `ω = (S * σ) mod x^(2t)` (polynomial multiply, then slice to keep only the low `2t` terms).

### 5. Error Location Search (Chien Search)

Find all `X_i` such that `σ(X_i) = 0`. Brute-force over all 255 non-zero GF elements (fast for n ≤ 255):

```typescript
// ZXing: evaluates σ at 1, 2, 3, …, 255 (i.e. α^0 … α^254)
for (let i = 1; i < 256 && e < numErrors; i++) {
  if (sigma.evaluateAt(i) === 0) {
    roots[e++] = field.inverse(i);  // X_i = inverse of the root
  }
}
if (e !== numErrors) throw ReedSolomonException;
```

**Position in received word** from root:
```
position = received.length - 1 - field.log(X_i)
```
If `position < 0`, the error falls outside the block → decoding failure.

### 6. Error Magnitude — Forney Algorithm

For each error location `X_i`:

```
X_i_inv = inverse(X_i)

# Formal derivative of σ (denominator): product over j≠i of (1 - X_j * X_i_inv)
denom = ∏_{j≠i} (1 - X_j * X_i_inv)    [all GF multiplications]

# Numerator: evaluate error evaluator ω at X_i_inv
numer = ω(X_i_inv)

# For b=0 (QR): extra factor X_i^1
numer = numer * X_i                      # omit if b=0 and you want to skip; ZXing multiplies by xiInverse when b≠0

magnitude[i] = numer / denom
```

> **ZXing Forney code note** (line ~185 of `ReedSolomonDecoder.ts`): when `generatorBase != 0`, it multiplies the result by `xiInverse`. For QR (`b=0`) this step is skipped.

Apply correction:
```
received[position] ^= magnitude[i]   // XOR = addition in GF(2^8)
```

### 7. QR Codeword Block Interleaving

QR codes split data into multiple RS blocks and **interleave** them before writing to the grid. De-interleave before feeding blocks to the RS decoder.

**De-interleaving algorithm** (from `DataBlock.ts` in zxing-js):

```
Given: rawCodewords[], version, ecLevel
  → Look up: numBlocks, dataCodewordsPerBlock (shorter), ecCodewordsPerBlock

Step 1: Allocate result[0..numBlocks-1], each of length dataCodewords+ecCodewords

Step 2: Fill data bytes (interleaved round-robin across all blocks):
  for i in 0..shorterDataLen-1:
    for j in 0..numBlocks-1:
      result[j].codewords[i] = rawCodewords[offset++]

  # Longer blocks get one extra byte at position shorterDataLen:
  for j in longerBlocksStartAt..numBlocks-1:
    result[j].codewords[shorterDataLen] = rawCodewords[offset++]

Step 3: Fill EC bytes (also interleaved):
  for i in shorterDataLen..totalPerBlock-1:
    for j in 0..numBlocks-1:
      iOffset = (j < longerBlocksStartAt) ? i : i+1
      result[j].codewords[iOffset] = rawCodewords[offset++]
```

Then run the RS decoder on each `result[j].codewords` independently (pass `ecCodewordsPerBlock` as `2t`).

### 8. QR-Specific Caveats

| Caveat | Detail |
|--------|--------|
| Primitive poly | Must be `0x11D`. DataMatrix uses `0x12D` — wrong for QR. |
| Generator base | `b=0` for QR. Syndromes at α^0..α^(2t-1). Forney skips the `xiInverse` multiplier. |
| Block structure | Multiple interleaved blocks; de-interleave before RS per zxing `DataBlock.getDataBlocks`. |
| Max correctable | `t = ecCodewordsPerBlock / 2` errors per block (no erasures). With erasures: `2e + v ≤ 2t`. |
| Syndrome shift | Some implementations prepend a zero to the syndrome array for index alignment. Adjust BM iteration range (`K = i + synd_shift` where `synd_shift = len(synd) - nsym`). |
| Position bounds | If `received.length - 1 - log(X_i) < 0`, the error is outside the block — report uncorrectable. |
| EC codewords at end | In each RS block, data bytes come first, EC bytes follow. The decoder corrects the full block in-place; only the first `numDataCodewords` bytes are kept for output. |

---

## Recommended Implementation Path for TypeScript

**Use the Euclidean path** (cleaner, no syndrome-shift subtlety):

1. Copy `GenericGF.ts`, `GenericGFPoly.ts`, `ReedSolomonDecoder.ts` from [zxing-js/library](https://github.com/zxing-js/library/tree/master/src/core/common/reedsolomon) (Apache 2.0).
2. Instantiate with `GenericGF.QR_CODE_FIELD_256` (primitive=`0x11D`, size=256, base=0).
3. Call `decoder.decode(blockCodewords, ecCodewordsPerBlock)` — mutates array in-place.
4. Before calling: de-interleave using the `DataBlock.getDataBlocks` logic above.
5. After: extract `blockCodewords.slice(0, numDataCodewords)` from each block and concatenate.

---

## Sources

- **Kept**: [zxing-js ReedSolomonDecoder.ts](https://github.com/zxing-js/library/blob/master/src/core/common/reedsolomon/ReedSolomonDecoder.ts) — authoritative TypeScript, Euclidean decoder, direct QR usage
- **Kept**: [zxing-js GenericGF.ts](https://github.com/zxing-js/library/blob/master/src/core/common/reedsolomon/GenericGF.ts) — GF table construction, QR field constant
- **Kept**: [zxing-js DataBlock.ts](https://github.com/zxing-js/library/blob/master/src/core/qrcode/decoder/DataBlock.ts) — canonical block de-interleaving
- **Kept**: [Wikiversity RS codes for coders](https://en.wikiversity.org/wiki/Reed%E2%80%93Solomon_codes_for_coders) — best BM+Chien+Forney pseudocode with full annotations
- **Dropped**: Medium/qrcodefyi blog posts — introductory only, no implementation detail
- **Dropped**: NASA tutorial PDF (1990) — conceptually useful but uses non-standard notation and old conventions

## Gaps

- **Erasure correction**: Not covered here. QR scanners rarely provide erasure positions, but if your grid-reader can flag unreadable modules, the `rs_find_errata_locator` + modified Forney from Wikiversity handles it.
- **Block count / EC bytes per version**: You need a QR version table (ISO 18004 Table 9) to look up `ecCodewordsPerBlock` and block group sizes. ZXing's `Version.ts` is the reference.
- **Remainder bits**: QR codes append 0–7 remainder bits after all codewords; these are not codewords and must be stripped before RS decoding.
