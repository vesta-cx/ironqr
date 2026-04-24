import * as S from 'effect/Schema';

const FiniteNumberSchema = S.Number.check(S.isFinite());
const NonNegativeFiniteNumberSchema = S.Number.check(S.isFinite(), S.isGreaterThanOrEqualTo(0));

export const PointSchema = S.Struct({
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
});
export type Point = S.Schema.Type<typeof PointSchema>;

export const BoundsSchema = S.Struct({
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
  width: NonNegativeFiniteNumberSchema,
  height: NonNegativeFiniteNumberSchema,
});
export type Bounds = S.Schema.Type<typeof BoundsSchema>;

export const CornerSetSchema = S.Struct({
  topLeft: PointSchema,
  topRight: PointSchema,
  bottomRight: PointSchema,
  bottomLeft: PointSchema,
});
export type CornerSet = S.Schema.Type<typeof CornerSetSchema>;
