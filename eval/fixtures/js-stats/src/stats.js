/** Sum of a list of numbers. */
export function sum(values) {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Arithmetic mean. Throws a TypeError on an empty list. */
export function mean(values) {
  if (values.length === 0) throw new TypeError("mean() of empty list");
  return sum(values) / values.length;
}
