const PRIMITIVE_POLY = 0x11d;

let tablesInitialized = false;
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

/**
 * Lazily initializes the GF(256) log and exponent tables used by QR Reed-Solomon math.
 *
 * @returns Nothing.
 */
const initializeTables = (): void => {
  if (tablesInitialized) {
    return;
  }

  let x = 1;

  // Build the canonical GF(256) tables for the QR primitive polynomial, then extend the
  // exponent table so multiplication can index without explicit modulo operations.
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
};

/**
 * Adds two GF(256) elements.
 *
 * @param left - First field element.
 * @param right - Second field element.
 * @returns The field sum.
 */
const gfAdd = (left: number, right: number): number => {
  return left ^ right;
};

/**
 * Multiplies two GF(256) elements.
 *
 * @param left - First field element.
 * @param right - Second field element.
 * @returns The field product.
 */
const gfMultiply = (left: number, right: number): number => {
  if (left === 0 || right === 0) {
    return 0;
  }

  initializeTables();
  return EXP_TABLE[(LOG_TABLE[left] ?? 0) + (LOG_TABLE[right] ?? 0)] ?? 0;
};

/**
 * Computes the multiplicative inverse of a GF(256) element.
 *
 * @param value - Non-zero field element.
 * @returns The multiplicative inverse.
 * @throws {Error} Thrown when attempting to invert zero.
 */
const gfInverse = (value: number): number => {
  if (value === 0) {
    throw new Error('Cannot invert zero in GF(256).');
  }

  initializeTables();
  return EXP_TABLE[255 - (LOG_TABLE[value] ?? 0)] ?? 0;
};

/**
 * Multiplies two polynomials whose coefficients live in GF(256).
 *
 * @param left - Left polynomial coefficients.
 * @param right - Right polynomial coefficients.
 * @returns The product polynomial coefficients.
 */
const polynomialMultiply = (left: readonly number[], right: readonly number[]): number[] => {
  const result = new Array<number>(left.length + right.length - 1).fill(0);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      result[leftIndex + rightIndex] =
        (result[leftIndex + rightIndex] ?? 0) ^
        gfMultiply(left[leftIndex] ?? 0, right[rightIndex] ?? 0);
    }
  }

  return result;
};

/**
 * Builds the Reed-Solomon generator polynomial for the requested ECC width.
 *
 * @param ecCodewords - Number of error-correction codewords to generate.
 * @returns Generator polynomial coefficients.
 */
const buildGeneratorPolynomial = (ecCodewords: number): number[] => {
  initializeTables();

  let generator = [1];
  for (let i = 0; i < ecCodewords; i += 1) {
    generator = polynomialMultiply(generator, [1, EXP_TABLE[i] ?? 0]);
  }

  return generator;
};

/**
 * Represents a Reed-Solomon decode failure before it is translated into the public scanner contract.
 */
export class ReedSolomonError extends Error {
  /**
   * Creates a Reed-Solomon decode error.
   *
   * @param message - Human-readable decode failure detail.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ReedSolomonError';
  }
}

/**
 * Minimal polynomial helper used by the Reed-Solomon decoder.
 */
class GenericGFPoly {
  readonly coefficients: number[];

  /**
   * Normalizes a polynomial by trimming leading zero coefficients.
   *
   * @param coefficients - Polynomial coefficients from highest to lowest degree.
   */
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

  /**
   * Creates the zero polynomial.
   *
   * @returns A polynomial representing zero.
   */
  static zero(): GenericGFPoly {
    return new GenericGFPoly([0]);
  }

  /**
   * Creates a monomial of the form coefficient × x^degree.
   *
   * @param degree - Exponent of the monomial.
   * @param coefficient - Leading coefficient.
   * @returns The requested monomial.
   */
  static monomial(degree: number, coefficient: number): GenericGFPoly {
    if (degree < 0) {
      throw new Error(`Invalid monomial degree: ${degree}`);
    }

    if (coefficient === 0) {
      return GenericGFPoly.zero();
    }

    return new GenericGFPoly([coefficient, ...Array.from({ length: degree }, () => 0)]);
  }

  /**
   * Returns the highest degree with a non-zero coefficient.
   *
   * @returns The polynomial degree.
   */
  get degree(): number {
    return this.coefficients.length - 1;
  }

  /**
   * Checks whether the polynomial is exactly zero.
   *
   * @returns True when the polynomial is zero.
   */
  isZero(): boolean {
    return this.coefficients.length === 1 && (this.coefficients[0] ?? 0) === 0;
  }

  /**
   * Returns the coefficient for a specific power of x.
   *
   * @param degree - Degree whose coefficient should be read.
   * @returns The coefficient for that degree.
   */
  getCoefficient(degree: number): number {
    return this.coefficients[this.coefficients.length - 1 - degree] ?? 0;
  }

  /**
   * Evaluates the polynomial at a field element.
   *
   * @param value - Field element to plug into the polynomial.
   * @returns The evaluated field element.
   */
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

  /**
   * Adds or subtracts another polynomial.
   *
   * @param other - Polynomial to combine with this one.
   * @returns The combined polynomial.
   */
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

  /**
   * Multiplies this polynomial by another polynomial.
   *
   * @param other - Polynomial multiplier.
   * @returns The product polynomial.
   */
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

  /**
   * Multiplies every coefficient by a scalar field element.
   *
   * @param scalar - Field element multiplier.
   * @returns The scaled polynomial.
   */
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

  /**
   * Multiplies the polynomial by coefficient × x^degree.
   *
   * @param degree - Degree of the monomial multiplier.
   * @param coefficient - Coefficient of the monomial multiplier.
   * @returns The shifted and scaled polynomial.
   */
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

/**
 * Runs the Euclidean algorithm to derive the error locator and evaluator polynomials.
 *
 * @param a - Higher-degree polynomial input.
 * @param b - Lower-degree polynomial input.
 * @param ecCodewords - Number of ECC codewords in the block.
 * @returns A tuple of [error locator, error evaluator].
 */
const runEuclideanAlgorithm = (
  a: GenericGFPoly,
  b: GenericGFPoly,
  ecCodewords: number,
): readonly [GenericGFPoly, GenericGFPoly] => {
  if (a.degree < b.degree) {
    [a, b] = [b, a];
  }

  let rLast = a;
  let r = b;
  let tLast = GenericGFPoly.zero();
  let t = new GenericGFPoly([1]);

  // Continue until the remainder has low enough degree to represent the evaluator polynomial.
  while (r.degree >= ecCodewords / 2) {
    const rLastLast = rLast;
    const tLastLast = tLast;
    rLast = r;
    tLast = t;

    if (rLast.isZero()) {
      throw new ReedSolomonError('Reed-Solomon Euclidean algorithm failed: zero remainder.');
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
    throw new ReedSolomonError('Reed-Solomon Euclidean algorithm failed: sigma(0) = 0.');
  }

  const inverse = gfInverse(sigmaTildeAtZero);
  return [t.multiplyScalar(inverse), r.multiplyScalar(inverse)];
};

/**
 * Finds every error location encoded by an error locator polynomial.
 *
 * @param errorLocator - Error locator polynomial.
 * @returns Field elements representing each error location.
 */
const findErrorLocations = (errorLocator: GenericGFPoly): number[] => {
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
    throw new ReedSolomonError('Reed-Solomon decoder failed to locate all errors.');
  }

  return result;
};

/**
 * Computes the magnitude of each located Reed-Solomon error.
 *
 * @param errorEvaluator - Error evaluator polynomial.
 * @param errorLocations - Field elements representing each error location.
 * @returns Error magnitudes aligned to the provided locations.
 */
const findErrorMagnitudes = (
  errorEvaluator: GenericGFPoly,
  errorLocations: readonly number[],
): number[] => {
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
};

/**
 * Generates Reed-Solomon ECC bytes for a data block.
 *
 * @param data - Data codewords to protect.
 * @param ecCodewords - Number of ECC codewords to generate.
 * @returns The ECC bytes for the provided data block.
 */
export const rsEncode = (data: readonly number[], ecCodewords: number): Uint8Array => {
  const generator = buildGeneratorPolynomial(ecCodewords);
  const buffer = new Uint8Array(data.length + ecCodewords);
  buffer.set(data);

  // Perform polynomial long division; the remainder becomes the ECC payload.
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
};

/**
 * Corrects a full Reed-Solomon block containing data and ECC codewords.
 *
 * @param received - Received block codewords.
 * @param ecCodewords - Number of ECC codewords at the tail of the block.
 * @returns The corrected block codewords.
 */
export const correctRsBlock = (received: readonly number[], ecCodewords: number): Uint8Array => {
  initializeTables();

  try {
    const work = Array.from(received);
    const poly = new GenericGFPoly(work);
    const syndromeCoefficients = new Array<number>(ecCodewords).fill(0);
    let noError = true;

    // A zero syndrome means the block is already valid and can be returned as-is.
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
        throw new ReedSolomonError('Reed-Solomon error location outside the block.');
      }

      work[position] = (work[position] ?? 0) ^ (errorMagnitudes[i] ?? 0);
    }

    return Uint8Array.from(work);
  } catch (error) {
    if (error instanceof ReedSolomonError) {
      throw error;
    }

    if (error instanceof Error) {
      throw new ReedSolomonError(error.message);
    }

    throw new ReedSolomonError('Unknown Reed-Solomon decoding failure.');
  }
};

/**
 * Verifies that the supplied ECC bytes match the given data bytes.
 *
 * @param data - Data codewords.
 * @param ecc - Expected ECC codewords.
 * @returns True when the ECC bytes match the encoded remainder.
 */
export const verifyRsBlock = (data: readonly number[], ecc: readonly number[]): boolean => {
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
};
