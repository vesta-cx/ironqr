# ScanFrame End-to-End, Explained Like You're Eight

Related: [[ScanFrame End-to-End]], [[Pipeline Stage Contracts]], [[Ranked Proposal Pipeline]], [[Proposal Clusters]], [[Early Exit Heuristics]], [[Diagnostics and Benchmark Boundary]]

## First, hold my hand
We are going to walk through what happens when someone calls:

```ts
await scanFrame(image)
```

or:

```ts
await scanImage(image)
```

Same scanner. Different little hat. Very fancy. Try not to clap yet.

The scanner's job is simple to say and annoying to do:

> Look at a picture, find a QR code, read the message, and tell us where the QR code was.

The hard part is that pictures are messy. They can be blurry, colorful, tilted, inverted, weirdly lit, or designed by someone who thought “what if the QR code looked like soup?”

So `ironqr` does not just stare at one black-and-white image and hope. That would be adorable. Wrong, but adorable.

It builds a search pipeline.

---

## The toy version
Imagine you lost a sticker on a messy desk.

A bad scanner says:

> “I looked once. Didn't see it. Bye.”

`ironqr` says:

> “I will look at the desk through different glasses, make a few smart guesses, rank those guesses, throw away the silly ones, and spend real effort only on the best ones.”

That is the whole idea.

You may now breathe through your nose again.

---

## Big picture
Here is the flow with tiny baby steps:

```text
input image
  |
  v
normalize it
  |
  v
create lazy views of the image
  |
  v
make QR location guesses from prioritized binary views
  |
  v
rank the guesses
  |
  v
cluster duplicates
  |
  v
cheaply reject bad guesses
  |
  v
try hard to decode good guesses
  |
  v
return decoded QR results
```

That is the grown-up pipeline wearing light-up sneakers.

---

## Step 1: The public door
The caller starts with one of these:

```ts
scanFrame(input)
scanImage(input)
```

If they ask normally, they get:

```ts
Promise<readonly ScanResult[]>
```

That means: “Here are the QR codes I found.”

If they ask with observability:

```ts
scanFrame(input, { observability: { scan: { proposals: 'summary' } } })
```

then they get a `ScanReport`.

That means: “Here are the QR codes, and also here is what the scanner did while looking.”

This is not called `verbose: true` because we are adults with standards. Barely.

---

## Step 2: Normalize the image
The scanner first turns whatever it was given into one boring, predictable shape called `NormalizedImage`.

The input might be:

- `Blob`
- `File`
- `ImageBitmap`
- `ImageData`
- `{ width, height, data }`
- canvas-ish things
- video-frame-ish things

The scanner does not want to care. Caring is expensive.

So it normalizes the input into:

- `width`
- `height`
- `rgbaPixels`
- lazy caches called `derivedViews`

It also checks basic safety rules:

- width and height must be positive integers
- pixels must be a `Uint8ClampedArray`
- data length must be `width * height * 4`

This is the scanner wiping mud off its shoes before entering the house. A concept you may one day master.

---

## Step 3: Build a lazy view bank
Next, the scanner creates a `ViewBank`.

A view is just “the same image, looked at a different way.”

For example:

- grayscale
- red channel
- green channel
- blue channel
- OKLab lightness
- OKLab color planes

Then each scalar view can become a black-and-white binary view using:

- `otsu`
- `sauvola`
- `hybrid`

And each binary view can be:

- `normal`
- `inverted`

That gives 54 possible binary views.

But here is the clever bit: views are lazy.

The scanner does **not** build all of them immediately. It waits until a later stage asks for one.

This is like not making all 54 sandwiches until someone actually says they are hungry. Revolutionary stuff, I know.

---

## Step 4: Do not search every view first
The scanner does not start by scanning all 54 binary views.

That would be slow and, frankly, a little desperate.

Instead, it uses an empirically chosen top-18 proposal-view list. These are the views that have been useful in benchmark/study work.

The first few are currently:

1. `gray:otsu:normal`
2. `oklab-l:hybrid:normal`
3. `gray:sauvola:normal`
4. `oklab-l:sauvola:normal`

The scanner tries better views earlier so easy images can finish quickly.

Yes, ordering matters. Gold star.

---

## Step 5: Proposal batches
For each prioritized binary view, the scanner creates one `ProposalViewBatch`.

A batch means:

> “Here are the QR-looking guesses I found in this one binary view.”

The scanner gets batches from an internal `ProposalBatchSource`.

That source is:

- sequential
- Effect-native
- cooperative
- not worker-backed

In tiny-human language:

> It does one proposal view at a time, using Effect yield points so the host can breathe between chunks, but it does not spin up worker threads or summon browser goblins.

The default scheduler yields with `Effect.yieldNow` before and after proposal-view batches.

So the scanner can politely pause between big bites instead of shoving the whole CPU sandwich into its mouth.

You should try this with actual sandwiches too.

---

## Step 6: Finder evidence
Inside one proposal view, the scanner looks for finder patterns.

Finder patterns are the three big square targets on a QR code.

You know, these guys:

```text
■       ■


■
```

Do not judge the art. It is doing its best.

The scanner gathers finder-like evidence using detectors such as:

- row-scan
- flood
- matcher

It may skip expensive detectors when the cheap detector already gives enough evidence.

Then it dedupes the evidence, because the same finder can be rediscovered multiple ways. Computers are fast, not wise.

---

## Step 7: Turn finder evidence into proposals
Once the scanner has finder evidence, it builds plausible finder triples.

A finder triple is:

> “These three finder-looking things might be the three corners of one QR code.”

Each good triple becomes a `finder-triple` proposal.

The proposal includes:

- proposal id
- source binary view id
- the three finder evidences
- estimated QR versions
- score fields
- geometry seeds

The important new bit is geometry seeds.

Previously, the scanner could emit both:

- one finder-triple proposal
- one inferred quad proposal from the same finder evidence

That duplicated the frontier. Same evidence, two proposal objects. Very “I made a mess and called it architecture.”

Now the finder-triple proposal carries alternate geometry ideas inside itself.

For example:

```ts
geometrySeeds: [
  { kind: 'finder-triple' },
  { kind: 'inferred-quad', corners },
]
```

So one proposal can say:

> “Try the normal finder geometry, and also try this inferred quad geometry.”

Same evidence. One proposal. Multiple geometry hypotheses.

Tiny but important. Like flossing, which you also probably skip.

---

## Step 8: The proposal frontier
As each batch arrives, the scanner adds its proposals to the active frontier.

The frontier is just:

> “All the guesses we have so far.”

But the scanner does not wait for every proposal view before trying to decode.

For ordinary single-code scans, it can do this:

1. generate an early batch
2. add it to the frontier
3. rank the frontier
4. cluster it
5. try the best representatives
6. return early if one decodes

That means easy images can finish before all 18 proposal views are generated.

The scanner is allowed to stop early only when `allowMultiple !== true`.

If the caller asked for multiple QR codes, the scanner must be more patient and keep looking. Sharing is caring. Unfortunately.

---

## Step 9: Ranking proposals
The scanner globally ranks the proposals using `rankProposalCandidates(...)`.

Ranking looks at things like:

- detector confidence
- geometry plausibility
- quiet-zone support
- timing-pattern plausibility
- alignment support
- penalties for suspicious shapes

The output is not just proposals. It is `RankedProposalCandidate` objects.

Those include ranking-time geometry candidates.

This matters because ranking already did some geometry work. Decode should reuse it instead of doing the same homework twice.

Even you know copying your own homework is still a waste of time.

---

## Step 10: Budget the frontier
After ranking, the scanner slices the frontier to a global proposal budget.

Current default:

- global proposal budget: `24`
- per-view proposal cap: `12`

So even if the scanner finds a giant pile of guesses, it only spends real effort on the best bounded set.

This is because “try everything” is not a strategy. It is what toddlers and brute-force scripts do.

---

## Step 11: Cluster duplicates
Many proposals describe the same physical QR code.

They might come from:

- different color views
- different threshold methods
- normal vs inverted polarity
- multiple geometry seeds on one finder-triple proposal

Clustering groups near-duplicates.

A cluster means:

> “These guesses probably point at the same QR code.”

The scanner keeps a small representative set from each cluster.

Current representative budget:

- `3`

It prefers:

1. the best-ranked proposal
2. proposals from new view families
3. unseen threshold/polarity combinations
4. then next-best leftovers

This avoids spending decode budget on the same QR candidate over and over while wearing slightly different glasses.

---

## Step 12: Cheap structural screen
Before the scanner spends expensive decode work, it asks:

> “Does this candidate even look like a QR code?”

That is `assessProposalStructure(...)`.

It cheaply checks things like:

- finder support
- separator support
- timing support
- module pitch smoothness

If the candidate looks silly, it gets rejected early.

If a cluster gets too many structural failures, the cluster is killed.

Current threshold:

- `3` structural failures

This is the scanner saying:

> “No, your three smudges and a dream are not a QR code.”

Harsh, but fair.

---

## Step 13: Decode cascade
If a representative passes the cheap screen, it enters `runDecodeCascade(...)`.

This is where the scanner actually tries hard.

The rough order is:

1. use ranking-time geometry candidates
2. expand seeded geometry candidates if needed
3. try decode-neighborhood binary views
4. refine geometry by fitness
5. try alignment-assisted refits
6. try corner nudges
7. try nearby QR versions
8. sample a logical grid
9. decode the QR data

This is the expensive part, so only promising candidates get here.

That is the whole trick: be cheap and picky first, then expensive and stubborn later.

Write that down with your chunky crayon.

---

## Step 14: Geometry candidates
A geometry candidate says:

> “Here is how I think the square QR grid maps onto the image.”

It carries:

- QR version
- grid size
- homography
- image-space corners
- image-space bounds
- proposal id
- binary view id
- geometry mode
- geometry score

Current geometry modes:

- `finder-homography`
- `center-homography`
- `quad-homography`

For finder-triple proposals:

- finder evidence can create `finder-homography`
- finder centers can create `center-homography`
- inferred quad geometry seeds can create `quad-homography`

So the scanner keeps multiple ways to map the QR code without multiplying proposal objects like a gremlin with a photocopier.

---

## Step 15: Off-image rejection
Before decoding, the scanner checks whether important projected points are actually inside the image.

It checks:

- four QR corners
- QR center
- alignment anchor for version 2+

If the geometry points off the image, the scanner rejects it.

Because if your “QR code” lives mostly outside the picture, congratulations, you found imagination.

---

## Step 16: Decode neighborhood
The proposal came from one binary view, but that does not mean that same view is best for decoding.

So the scanner tries a decode neighborhood.

It starts close:

- exact same view
- same scalar and polarity
- same scalar
- same family and polarity

Then it moves farther away:

- same threshold and polarity
- same family
- more distant views

Why?

Because one view might find the QR code well, while another view reads the modules better.

This is like using one flashlight to find your Lego and another flashlight to confirm it is not a raisin.

---

## Step 17: Sampling the QR grid
Once the scanner has geometry and a decode view, it samples the QR grid.

Samplers include:

- `cross-vote`
- `dense-vote`
- `nearest`

The sampler decides whether each QR module is dark or light.

This produces a logical grid: a clean-ish QR matrix that can be handed to the spec decoder.

This is the moment where a messy photo becomes a little square of booleans.

Behold, civilization.

---

## Step 18: Timing gate
Before full QR decoding, the scanner checks the timing patterns.

Timing patterns are the alternating dark/light lines that help prove the grid is really QR-shaped.

If timing looks bad, the scanner stops that attempt early.

This saves time because Reed-Solomon does not need to be dragged into every nonsense situation like a tired substitute teacher.

---

## Step 19: QR-spec decode
If timing passes, the scanner runs `decodeGridLogical(...)`.

This is the actual QR decoder.

It handles:

- format info
- version info
- masks
- Reed-Solomon correction
- payload extraction
- segment decoding

It also has limited header rescue for near-miss grids:

- ranked near-miss format-info candidates
- size-implied and nearby version candidates
- mirrored variants

This rescue is narrow and QR-spec-adjacent. It does not turn the decoder into a magical swamp monster.

We have standards. Again, barely.

---

## Step 20: Attach original-image geometry
When decode succeeds, the scanner returns a `ScanResult`.

The result includes payload data, but also original-image geometry:

- `bounds`
- `corners.topLeft`
- `corners.topRight`
- `corners.bottomRight`
- `corners.bottomLeft`

These coordinates are in the original input image, not the sampled logical grid.

So callers can draw a box around the QR code.

Yes, the rectangle is useful. Please stop poking it.

---

## Step 21: Deduplicate and stop
Successful results are deduped.

Default behavior:

- stop after the first success

If the caller sets:

```ts
allowMultiple: true
```

then the scanner keeps going to find more QR codes.

Single-code default is faster. Multi-code mode is more thorough.

This is called a tradeoff. You will meet many of them after snack time.

---

## Step 22: What the caller gets
Without observability:

```ts
const results = await scanFrame(image)
```

The caller gets `ScanResult[]`, including:

- payload text / bytes
- payload kind
- confidence
- QR version
- error correction level
- bounds
- corners
- headers
- segments

With observability:

```ts
const report = await scanFrame(image, {
  observability: {
    result: { path: 'basic', attempts: 'summary' },
    scan: { proposals: 'summary', timings: 'summary', failure: 'summary' },
    trace: { events: 'summary' },
  },
})
```

The caller gets `ScanReport`, including requested metadata such as:

- winning path metadata
- attempt summaries
- proposal-generation summaries
- view summaries
- timing summaries
- failure summaries
- trace summaries or events

This keeps normal scans cheap and lets diagnostics ask for more detail explicitly.

No giant mystery `verbose` bucket. We are not animals.

---

## The whole flow as a bedtime story
The image arrives.

The scanner cleans it up into a normalized image.

It builds a lazy cabinet of possible views.

It opens only the most promising drawers first.

For each promising binary view, it finds finder evidence.

It makes finder-triple proposals.

Each proposal can carry geometry seeds, so one guess can try multiple shapes without becoming duplicate clutter.

The scanner ranks all guesses seen so far.

It keeps a bounded frontier.

It clusters near-duplicates.

It cheaply rejects the nonsense.

It spends serious decode effort on the best survivors.

If one decodes and the caller only wanted one QR, it stops early.

If observability was requested, it also explains what happened.

Then everyone goes home, except the benchmark suite, which remains hungry forever.

---

## One sentence, because your juice box is empty
`ironqr` turns an image into lazy views, streams prioritized proposal batches, ranks and clusters QR-location guesses, screens bad candidates cheaply, then reuses cached and seeded geometry inside a decode cascade until it finds a real QR result with original-image bounds and corners.
