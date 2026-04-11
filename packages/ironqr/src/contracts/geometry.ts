import * as S from 'effect/Schema';

export const PointSchema = S.Struct({
  x: S.Number,
  y: S.Number,
});
export type Point = S.Schema.Type<typeof PointSchema>;

export const BoundsSchema = S.Struct({
  x: S.Number,
  y: S.Number,
  width: S.Number,
  height: S.Number,
});
export type Bounds = S.Schema.Type<typeof BoundsSchema>;

export const CornerSetSchema = S.Struct({
  topLeft: PointSchema,
  topRight: PointSchema,
  bottomRight: PointSchema,
  bottomLeft: PointSchema,
});
export type CornerSet = S.Schema.Type<typeof CornerSetSchema>;
