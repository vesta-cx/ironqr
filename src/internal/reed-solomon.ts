const PRIMITIVE_POLY = 0x11d;

let tablesInitialized = false;
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

function initializeTables(): void {
  if (tablesInitialized) {
    return;
  }

  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) {
      x ^= PRIMITIVE_POLY;
    }
  }

  for (let i = 255; i < EXP_TABLE.length; i += 1) {
    EXP_TABLE[i] = EXP_TABLE[i - 255] ?? 0;
  }

  tablesInitialized = true;
}

function gfAdd(left: number, right: number): number {
  return left ^ right;
}

function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) {
    return 0;
  }

  initializeTables();
  return EXP_TABLE[(LOG_TABLE[left] ?? 0) + (LOG_TABLE[right] ?? 0)] ?? 0;
}

function gfInverse(value: number): number {
  if (value === 0) {
    throw new Error('Cannot invert zero in GF(256).');
  }

  initializeTables();
  return EXP_TABLE[255 - (LOG_TABLE[value] ?? 0)] ?? 0;
}

function polynomialMultiply(left: readonly number[], right: readonly number[]): number[] {
  const result = new Array<number>(left.length + right.length - 1).fill(0);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      result[leftIndex + rightIndex] =
        (result[leftIndex + rightIndex] ?? 0) ^
        gfMultiply(left[leftIndex] ?? 0, right[rightIndex] ?? 0);
    }
  }

  return result;
}

function buildGeneratorPolynomial(ecCodewords: number): number[] {
  initializeTables();

  let generator = [1];
  for (let i = 0; i < ecCodewords; i += 1) {
    generator = polynomialMultiply(generator, [1, EXP_TABLE[i] ?? 0]);
  }

  return generator;
}

class GenericGFPoly {
  readonly coefficients: number[];

  constructor(coefficients: readonly number[]) {
    if (coefficients.length === 0) {
      throw new Error('Polynomial must contain at least one coefficient.');
    }

    let firstNonZero = 0;
    while (firstNonZero < coefficients.length - 1 && (coefficients[firstNonZero] ?? 0) === 0) {
      firstNonZero += 1;
    }

    this.coefficients = Array.from(coefficients.slice(firstNonZero));
  }

  static zero(): GenericGFPoly {
    return new GenericGFPoly([0]);
  }

  static monomial(degree: number, coefficient: number): GenericGFPoly {
    if (degree < 0) {
      throw new Error(`Invalid monomial degree: ${degree}`);
    }

    if (coefficient === 0) {
      return GenericGFPoly.zero();
    }

    return new GenericGFPoly([coefficient, ...Array.from({ length: degree }, () => 0)]);
  }

  get degree(): number {
    return this.coefficients.length - 1;
  }

  isZero(): boolean {
    return this.coefficients.length === 1 && (this.coefficients[0] ?? 0) === 0;
  }

  getCoefficient(degree: number): number {
    return this.coefficients[this.coefficients.length - 1 - degree] ?? 0;
  }

  evaluateAt(value: number): number {
    if (value === 0) {
      return this.getCoefficient(0);
    }

    let result = 0;
    for (const coefficient of this.coefficients) {
      result = gfMultiply(result, value) ^ coefficient;
    }

    return result;
  }

  addOrSubtract(other: GenericGFPoly): GenericGFPoly {
    if (this.isZero()) {
      return other;
    }

    if (other.isZero()) {
      return this;
    }

    let larger = this.coefficients;
    let smaller = other.coefficients;
    if (larger.length < smaller.length) {
      [larger, smaller] = [smaller, larger];
    }

    const result = larger.slice();
    const offset = result.length - smaller.length;
    for (let index = 0; index < smaller.length; index += 1) {
      result[index + offset] = gfAdd(result[index + offset] ?? 0, smaller[index] ?? 0);
    }

    return new GenericGFPoly(result);
  }

  multiply(other: GenericGFPoly): GenericGFPoly {
    if (this.isZero() || other.isZero()) {
      return GenericGFPoly.zero();
    }

    const result = new Array<number>(this.coefficients.length + other.coefficients.length - 1).fill(
      0,
    );

    for (let leftIndex = 0; leftIndex < this.coefficients.length; leftIndex += 1) {
      for (let rightIndex = 0; rightIndex < other.coefficients.length; rightIndex += 1) {
        result[leftIndex + rightIndex] =
          (result[leftIndex + rightIndex] ?? 0) ^
          gfMultiply(this.coefficients[leftIndex] ?? 0, other.coefficients[rightIndex] ?? 0);
      }
    }

    return new GenericGFPoly(result);
  }

  multiplyScalar(scalar: number): GenericGFPoly {
    if (scalar === 0) {
      return GenericGFPoly.zero();
    }

    if (scalar === 1) {
      return this;
    }

    return new GenericGFPoly(
      this.coefficients.map((coefficient) => gfMultiply(coefficient, scalar)),
    );
  }

  multiplyByMonomial(degree: number, coefficient: number): GenericGFPoly {
    if (degree < 0) {
      throw new Error(`Invalid monomial degree: ${degree}`);
    }

    if (coefficient === 0) {
      return GenericGFPoly.zero();
    }

    return new GenericGFPoly([
      ...this.coefficients.map((value) => gfMultiply(value, coefficient)),
      ...Array.from({ length: degree }, () => 0),
    ]);
  }
}

function runEuclideanAlgorithm(
  a: GenericGFPoly,
  b: GenericGFPoly,
  ecCodewords: number,
): readonly [GenericGFPoly, GenericGFPoly] {
  if (a.degree < b.degree) {
    [a, b] = [b, a];
  }

  let rLast = a;
  let r = b;
  let tLast = GenericGFPoly.zero();
  let t = new GenericGFPoly([1]);

  while (r.degree >= ecCodewords / 2) {
    const rLastLast = rLast;
    const tLastLast = tLast;
    rLast = r;
    tLast = t;

    if (rLast.isZero()) {
      throw new Error('Reed-Solomon Euclidean algorithm failed: zero remainder.');
    }

    r = rLastLast;
    let q = GenericGFPoly.zero();

    const denominatorLeadingTerm = rLast.getCoefficient(rLast.degree);
    const dltInverse = gfInverse(denominatorLeadingTerm);

    while (r.degree >= rLast.degree && !r.isZero()) {
      const degreeDiff = r.degree - rLast.degree;
      const scale = gfMultiply(r.getCoefficient(r.degree), dltInverse);
      q = q.addOrSubtract(GenericGFPoly.monomial(degreeDiff, scale));
      r = r.addOrSubtract(rLast.multiplyByMonomial(degreeDiff, scale));
    }

    t = q.multiply(tLast).addOrSubtract(tLastLast);
  }

  const sigmaTildeAtZero = t.getCoefficient(0);
  if (sigmaTildeAtZero === 0) {
    throw new Error('Reed-Solomon Euclidean algorithm failed: sigma(0) = 0.');
  }

  const inverse = gfInverse(sigmaTildeAtZero);
  return [t.multiplyScalar(inverse), r.multiplyScalar(inverse)];
}

function findErrorLocations(errorLocator: GenericGFPoly): number[] {
  const numberOfErrors = errorLocator.degree;
  if (numberOfErrors === 0) {
    return [];
  }

  const result: number[] = [];
  for (let i = 1; i < 256 && result.length < numberOfErrors; i += 1) {
    if (errorLocator.evaluateAt(i) === 0) {
      result.push(gfInverse(i));
    }
  }

  if (result.length !== numberOfErrors) {
    throw new Error('Reed-Solomon decoder failed to locate all errors.');
  }

  return result;
}

function findErrorMagnitudes(
  errorEvaluator: GenericGFPoly,
  errorLocations: readonly number[],
): number[] {
  const result: number[] = [];

  for (let i = 0; i < errorLocations.length; i += 1) {
    const xi = errorLocations[i] ?? 0;
    const xiInverse = gfInverse(xi);

    let denominator = 1;
    for (let j = 0; j < errorLocations.length; j += 1) {
      if (j === i) {
        continue;
      }

      const xj = errorLocations[j] ?? 0;
      denominator = gfMultiply(denominator, gfAdd(1, gfMultiply(xj, xiInverse)));
    }

    result.push(gfMultiply(errorEvaluator.evaluateAt(xiInverse), gfInverse(denominator)));
  }

  return result;
}

export function rsEncode(data: readonly number[], ecCodewords: number): Uint8Array {
  const generator = buildGeneratorPolynomial(ecCodewords);
  const buffer = new Uint8Array(data.length + ecCodewords);
  buffer.set(data);

  for (let index = 0; index < data.length; index += 1) {
    const factor = buffer[index] ?? 0;
    if (factor === 0) {
      continue;
    }

    for (let generatorIndex = 0; generatorIndex < generator.length; generatorIndex += 1) {
      buffer[index + generatorIndex] =
        (buffer[index + generatorIndex] ?? 0) ^ gfMultiply(generator[generatorIndex] ?? 0, factor);
    }
  }

  return buffer.slice(data.length);
}

export function correctRsBlock(received: readonly number[], ecCodewords: number): Uint8Array {
  const work = Array.from(received);
  const poly = new GenericGFPoly(work);
  const syndromeCoefficients = new Array<number>(ecCodewords).fill(0);
  let noError = true;

  for (let i = 0; i < ecCodewords; i += 1) {
    const evaluation = poly.evaluateAt(EXP_TABLE[i] ?? 0);
    syndromeCoefficients[ecCodewords - 1 - i] = evaluation;
    if (evaluation !== 0) {
      noError = false;
    }
  }

  if (noError) {
    return Uint8Array.from(work);
  }

  const syndrome = new GenericGFPoly(syndromeCoefficients);
  const [errorLocator, errorEvaluator] = runEuclideanAlgorithm(
    GenericGFPoly.monomial(ecCodewords, 1),
    syndrome,
    ecCodewords,
  );

  const errorLocations = findErrorLocations(errorLocator);
  const errorMagnitudes = findErrorMagnitudes(errorEvaluator, errorLocations);

  for (let i = 0; i < errorLocations.length; i += 1) {
    const position = work.length - 1 - (LOG_TABLE[errorLocations[i] ?? 0] ?? 0);
    if (position < 0) {
      throw new Error('Reed-Solomon error location outside the block.');
    }

    work[position] = (work[position] ?? 0) ^ (errorMagnitudes[i] ?? 0);
  }

  return Uint8Array.from(work);
}

export function verifyRsBlock(data: readonly number[], ecc: readonly number[]): boolean {
  const expected = rsEncode(data, ecc.length);

  if (expected.length !== ecc.length) {
    return false;
  }

  for (let index = 0; index < ecc.length; index += 1) {
    if ((expected[index] ?? 0) !== (ecc[index] ?? 0)) {
      return false;
    }
  }

  return true;
}
